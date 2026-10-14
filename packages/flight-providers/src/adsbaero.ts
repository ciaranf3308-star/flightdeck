/**
 * adsb.aero adapter — the primary free historical-flight provider.
 *
 * Official OpenAPI spec: https://adsb.aero/api/docs
 * (raw spec: https://adsb.aero/api/openapi.json — "adsb.aero API" 0.1.0,
 * verified 2026-10-13; notes captured in research/api-research.md)
 *
 * Endpoints used:
 * - GET  /api/v1/data-range            — {first_date, last_date} archive coverage
 * - POST /api/v1/query                — flight search; match DSL, keyset pagination
 * - GET  /api/v1/flights/{flight_id}  — full trajectory (flight_id = <icao24>:<start_ts_utc>)
 *
 * Verified live 2026-10-13:
 * - No authentication required; no rate-limit headers observed. We stay polite:
 *   small page limits, a descriptive User-Agent, and FlightDeck's 24 h result cache.
 * - Query matches callsign by PREFIX (case-insensitive, hyphens ignored), so
 *   EI106 -> EIN106 must still be identity-verified afterwards (exact callsign,
 *   date, and airport agreement) — never blindly accepted.
 * - Trajectory `path` is a GeoJSON MultiLineString of [lon, lat, alt_ft] with
 *   per-sub-sequence unix timestamps. Multiple sub-sequences = coverage gaps
 *   (e.g. ~3.3 h mid-Atlantic for EI106 2026-10-09). Gaps are REPORTED, never
 *   interpolated — the map draws the segments with a visible break.
 * - Sparse timeseries (path_gs, path_tracks) are [[unix_ts, value]] pairs joined
 *   to the nearest vertex within 120 s; otherwise left null, never guessed.
 * - start_airport_ident / end_airport_ident are the nearest airport within 5 km
 *   (or null) — used for identity verification, marked inferred where surfaced.
 */
import type { ProviderState, TrackPoint } from "@flightdeck/shared-models";
import { classifyHttpError, FlightLookupError, normalizeFlightNumber } from "./types.js";

const BASE = "https://adsb.aero/api/v1";
const SOURCE = "adsb.aero";
const USER_AGENT = "FlightDeck/1.0 (MSFS 2024 flight-planning companion; historical lookup)";
/** Max seconds between a vertex and a gs/track sample to join them. */
const SERIES_JOIN_TOLERANCE_S = 120;

export interface AdsbAeroDataRange {
  firstDate: string | null;
  lastDate: string | null;
}

export interface AdsbAeroFlightSummary {
  flightId: string;
  icao24: string;
  callsign: string | null;
  icaoType: string | null;
  registration: string | null;
  model: string | null;
  operator: string | null;
  startTs: string | null;
  endTs: string | null;
  startAirportIdent: string | null;
  startAirportName: string | null;
  endAirportIdent: string | null;
  endAirportName: string | null;
  pointCount: number;
  rawPointCount: number;
}

export interface CoverageGap {
  /** ISO timestamp of the last vertex before the gap */
  fromTime: string;
  /** ISO timestamp of the first vertex after the gap */
  toTime: string;
  durationSec: number;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseDataRange(raw: unknown): AdsbAeroDataRange {
  const r = (raw ?? {}) as Record<string, unknown>;
  return { firstDate: asStr(r.first_date), lastDate: asStr(r.last_date) };
}

export function parseFlightSummary(raw: unknown): AdsbAeroFlightSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const flightId = asStr(r.flight_id);
  const icao24 = asStr(r.icao24);
  if (!flightId || !icao24) return null;
  return {
    flightId,
    icao24: icao24.toLowerCase(),
    callsign: asStr(r.callsign)?.toUpperCase() ?? null,
    icaoType: asStr(r.icao_type)?.toUpperCase() ?? null,
    registration: asStr(r.registration)?.toUpperCase() ?? null,
    model: asStr(r.model),
    operator: asStr(r.operator),
    startTs: asStr(r.start_ts),
    endTs: asStr(r.end_ts),
    startAirportIdent: asStr(r.start_airport_ident)?.toUpperCase() ?? null,
    startAirportName: asStr(r.start_airport_name),
    endAirportIdent: asStr(r.end_airport_ident)?.toUpperCase() ?? null,
    endAirportName: asStr(r.end_airport_name),
    pointCount: asNum(r.point_count) ?? 0,
    rawPointCount: asNum(r.raw_point_count) ?? 0,
  };
}

export interface IdentityCheck {
  ok: boolean;
  reasons: string[];
}

export interface IdentityExpectations {
  /** ICAO ident, e.g. "EIN106" */
  icaoIdent: string;
  /** YYYY-MM-DD */
  date: string;
  origin?: string;
  destination?: string;
}

/**
 * Verify a candidate flight is really the requested one — never blindly
 * accept a prefix match. Every check is reported in `reasons`.
 */
export function verifyFlightIdentity(f: AdsbAeroFlightSummary, exp: IdentityExpectations): IdentityCheck {
  const reasons: string[] = [];
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    reasons.push(msg);
  };
  if (f.callsign === exp.icaoIdent) {
    reasons.push(`Callsign ${f.callsign} matches exactly.`);
  } else {
    fail(`Callsign ${f.callsign ?? "(none)"} does not exactly match ${exp.icaoIdent} — rejected.`);
  }
  const startDate = f.startTs ? f.startTs.slice(0, 10) : null;
  if (startDate === exp.date) {
    reasons.push(`Departure date ${startDate} matches.`);
  } else {
    fail(`Departure date ${startDate ?? "(unknown)"} is not ${exp.date} — rejected.`);
  }
  if (exp.origin) {
    if (f.startAirportIdent === exp.origin) reasons.push(`Departure airport ${exp.origin} confirmed by provider.`);
    else if (f.startAirportIdent == null) reasons.push(`Provider did not identify a departure airport (nearest within 5 km: none) — origin taken from your input.`);
    else fail(`Provider departure airport ${f.startAirportIdent} disagrees with ${exp.origin} — rejected.`);
  }
  if (exp.destination) {
    if (f.endAirportIdent === exp.destination) reasons.push(`Arrival airport ${exp.destination} confirmed by provider.`);
    else if (f.endAirportIdent == null) reasons.push(`Provider did not identify an arrival airport — destination taken from your input.`);
    else fail(`Provider arrival airport ${f.endAirportIdent} disagrees with ${exp.destination} — rejected.`);
  }
  return { ok, reasons };
}

type Series = [number, number][];

/** Nearest value in a sparse [[ts, value]] series within tolerance, else null. */
function joinSeries(series: Series, ts: number): number | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] < ts) lo = mid + 1;
    else hi = mid;
  }
  let best = series[lo];
  if (lo > 0 && Math.abs(series[lo - 1][0] - ts) < Math.abs(best[0] - ts)) best = series[lo - 1];
  return Math.abs(best[0] - ts) <= SERIES_JOIN_TOLERANCE_S ? best[1] : null;
}

function parseSeries(raw: unknown): Series {
  if (!Array.isArray(raw)) return [];
  const out: Series = [];
  for (const seq of raw) {
    if (!Array.isArray(seq)) continue;
    for (const p of seq) {
      if (!Array.isArray(p)) continue;
      const t = asNum(p[0]);
      const v = asNum(p[1]);
      if (t != null && v != null) out.push([t, v]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

export interface ParsedTrajectory {
  points: TrackPoint[];
  gaps: CoverageGap[];
  /** per-segment point counts, for honest reporting */
  segments: number[];
}

/** Parse a FlightDetail trajectory. Gaps between sub-sequences are reported, never filled. */
export function parseTrajectory(raw: unknown): ParsedTrajectory {
  const points: TrackPoint[] = [];
  const gaps: CoverageGap[] = [];
  const segments: number[] = [];
  if (!raw || typeof raw !== "object") return { points, gaps, segments };
  const r = raw as Record<string, unknown>;
  const path = r.path as { coordinates?: unknown } | null;
  const coordSeqs = Array.isArray(path?.coordinates) ? (path!.coordinates as unknown[]) : [];
  const tsSeqs = Array.isArray(r.timestamps) ? (r.timestamps as unknown[]) : [];
  const gs = parseSeries(r.path_gs);
  const tr = parseSeries(r.path_tracks);

  let prevEnd: { t: number; lat: number; lon: number } | null = null;
  for (let s = 0; s < coordSeqs.length; s++) {
    const coords = coordSeqs[s];
    const tss = tsSeqs[s];
    if (!Array.isArray(coords) || !Array.isArray(tss)) continue;
    let count = 0;
    for (let i = 0; i < coords.length && i < tss.length; i++) {
      const c = coords[i];
      const t = asNum(tss[i]);
      if (!Array.isArray(c) || t == null) continue;
      const lon = asNum(c[0]);
      const lat = asNum(c[1]);
      if (lon == null || lat == null || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
      const altFt = asNum(c[2]);
      points.push({
        timestamp: new Date(t * 1000).toISOString(),
        lat,
        lon,
        altitudeFt: altFt == null ? null : Math.round(altFt),
        groundspeedKt: joinSeries(gs, t) == null ? null : Math.round(joinSeries(gs, t) as number),
        headingDeg: joinSeries(tr, t),
        provenance: "verified",
      });
      count++;
    }
    segments.push(count);
    const segStart = points[points.length - count];
    const segEnd = points[points.length - 1];
    if (prevEnd && segStart) {
      const gapSec = Math.round(new Date(segStart.timestamp).getTime() / 1000 - new Date(prevEnd.t * 1000).getTime() / 1000);
      if (gapSec > 0) {
        gaps.push({
          fromTime: new Date(prevEnd.t * 1000).toISOString(),
          toTime: segStart.timestamp,
          durationSec: gapSec,
          fromLat: prevEnd.lat,
          fromLon: prevEnd.lon,
          toLat: segStart.lat,
          toLon: segStart.lon,
        });
      }
    }
    if (segEnd) prevEnd = { t: new Date(segEnd.timestamp).getTime() / 1000, lat: segEnd.lat, lon: segEnd.lon };
  }
  return { points, gaps, segments };
}

export function formatGap(g: CoverageGap): string {
  const h = Math.floor(g.durationSec / 3600);
  const m = Math.round((g.durationSec % 3600) / 60);
  return `No ADS-B coverage for ${h}h ${m}m (${g.fromTime.slice(11, 16)}Z–${g.toTime.slice(11, 16)}Z) between ${g.fromLat.toFixed(1)}N ${Math.abs(g.fromLon).toFixed(1)}${g.fromLon < 0 ? "W" : "E"} and ${g.toLat.toFixed(1)}N ${Math.abs(g.toLon).toFixed(1)}${g.toLon < 0 ? "W" : "E"} — oceanic gap, not interpolated.`;
}

export class AdsbAeroProvider {
  readonly name = "adsbaero";
  static readonly SOURCE = SOURCE;
  private readonly fetchFn: typeof fetch;

  constructor(opts: { fetchFn?: typeof fetch } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const res = await this.fetchFn(`${BASE}${path}`, {
      ...init,
      headers: { "user-agent": USER_AGENT, ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new FlightLookupError(classifyHttpError(res.status), `adsb.aero request failed (HTTP ${res.status}).`);
    return res.json();
  }

  /** Archive coverage — call before querying so out-of-range dates get an honest answer. */
  async dataRange(): Promise<AdsbAeroDataRange> {
    return parseDataRange(await this.request("/data-range"));
  }

  /**
   * Search flights by ICAO callsign on a date (UTC). Returns summaries ordered
   * by start_ts descending (API default); identity verification is the caller's job.
   */
  async queryFlights(icaoIdent: string, date: string): Promise<AdsbAeroFlightSummary[]> {
    const dayStart = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(dayStart)) throw new FlightLookupError("invalid_format", `Bad date "${date}".`);
    const next = new Date(dayStart + 86400000).toISOString().slice(0, 10);
    const body = {
      match: { callsign_prefix: icaoIdent },
      start_from: date,
      end_date: next,
      limit: 25,
      include_path: false,
    };
    const raw = (await this.request("/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as { flights?: unknown[] };
    return (raw.flights ?? []).map(parseFlightSummary).filter((f): f is AdsbAeroFlightSummary => f !== null);
  }

  /** Full trajectory for one flight_id. */
  async getFlight(flightId: string): Promise<{ summary: AdsbAeroFlightSummary | null; trajectory: ParsedTrajectory; raw: unknown }> {
    const raw = await this.request(`/flights/${encodeURIComponent(flightId)}`);
    const summary = parseFlightSummary(raw);
    return { summary, trajectory: parseTrajectory(raw), raw };
  }

  /**
   * Find the flight for a user-entered flight number + date, verifying identity.
   * Throws FlightLookupError("empty") when nothing verifies — never returns a
   * lookalike.
   */
  async findFlight(
    flightNumber: string,
    date: string,
    origin?: string,
    destination?: string,
  ): Promise<{ flight: AdsbAeroFlightSummary; candidates: number; verifiedReasons: string[]; state: ProviderState }> {
    const { icaoIdent } = normalizeFlightNumber(flightNumber);
    const range = await this.dataRange();
    if (range.firstDate && date < range.firstDate) {
      throw new FlightLookupError("empty", `adsb.aero archive starts ${range.firstDate} — ${date} is out of coverage.`);
    }
    if (range.lastDate && date > range.lastDate) {
      throw new FlightLookupError("empty", `adsb.aero archive ends ${range.lastDate} — ${date} is not yet ingested.`);
    }
    const candidates = await this.queryFlights(icaoIdent, date);
    const exp: IdentityExpectations = {
      icaoIdent,
      date,
      origin: origin?.trim().toUpperCase() || undefined,
      destination: destination?.trim().toUpperCase() || undefined,
    };
    const verified = candidates
      .map((c) => ({ c, check: verifyFlightIdentity(c, exp) }))
      .filter((v) => v.check.ok);
    if (verified.length === 0) {
      const why = candidates.length === 0 ? "no flights matched the callsign prefix" : "candidates failed identity verification";
      throw new FlightLookupError("empty", `No verified ${icaoIdent} flight on ${date} at adsb.aero (${why}).`);
    }
    // Prefer the candidate whose airports the provider identified (stronger verification).
    verified.sort((a, b) => {
      const score = (v: (typeof verified)[number]) =>
        (v.c.startAirportIdent ? 1 : 0) + (v.c.endAirportIdent ? 1 : 0);
      return score(b) - score(a);
    });
    const best = verified[0];
    return { flight: best.c, candidates: candidates.length, verifiedReasons: best.check.reasons, state: "ok" as ProviderState };
  }
}
