/**
 * OpenSky Network adapter — the free historical-data alternative.
 *
 * Official docs: https://openskynetwork.github.io/opensky-api/rest.html
 * (API 1.4.0, verified 2026-10-13; notes captured in research/api-research.md)
 *
 * What is free and what is not (verified live 2026-10-13):
 * - Historical /flights/* endpoints REQUIRE authentication: a FREE OpenSky
 *   account with an API client (OAuth2 client credentials) — no payment.
 *   Anonymous requests get HTTP 403 "You cannot access historical flights".
 * - Authenticated quota: 4,000 credits/day per endpoint bucket
 *   (states / tracks / flights are independent).
 * - A historical /flights/departure query costs ~180 credits (3 day-partitions,
 *   the minimum window the API accepts); a track fetch ~30 credits.
 *
 * Verified constraints (from the official docs):
 * - GET /flights/departure?airport=&begin=&end= — the window MUST cover more
 *   than two days (UTC); 404 when no flights; batch-updated nightly, so only
 *   previous days are available (fine for Historical Replay).
 * - Flight objects carry icao24, firstSeen/lastSeen (unix), callsign
 *   (8-char, space-padded), estDepartureAirport / estArrivalAirport
 *   (estimated — marked inferred, never presented as certain).
 * - GET /tracks/all?icao24=&time= — experimental, and tracks are NOT
 *   available more than 30 days in the past. Path entries:
 *   [time, lat, lon, baro_altitude_m, true_track, on_ground].
 *   Track waypoints are decimated (≥15 min or significant change) — the
 *   general movement pattern, not a full-resolution recording.
 *
 * This adapter never fabricates: a missing track is reported as unavailable
 * with the 30-day reason, never interpolated.
 */
import type { ProviderState, TrackPoint } from "@flightdeck/shared-models";
import { classifyHttpError, FlightLookupError, normalizeFlightNumber } from "./types.js";

const BASE = "https://opensky-network.org/api";
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const SOURCE = "OpenSky Network";

/** One flight object from /flights/*. All fields optional — parsed defensively. */
export interface OpenSkyFlight {
  icao24: string | null;
  firstSeen: number | null;
  estDepartureAirport: string | null;
  lastSeen: number | null;
  estArrivalAirport: string | null;
  callsign: string | null;
}

export interface OpenSkyOptions {
  clientId?: string;
  clientSecret?: string;
  fetchFn?: typeof fetch;
}

const M_PER_FT = 0.3048;

function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function parseOpenSkyFlight(raw: unknown): OpenSkyFlight | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const icao24 = asStr(r.icao24)?.toLowerCase() ?? null;
  if (!icao24) return null;
  return {
    icao24,
    firstSeen: asNum(r.firstSeen),
    estDepartureAirport: asStr(r.estDepartureAirport)?.toUpperCase() ?? null,
    lastSeen: asNum(r.lastSeen),
    estArrivalAirport: asStr(r.estArrivalAirport)?.toUpperCase() ?? null,
    callsign: asStr(r.callsign)?.toUpperCase() ?? null,
  };
}

/** Normalize "EIN106  " -> "EIN106"; compare against ICAO ident variants. */
export function callsignMatches(callsign: string | null, icaoIdent: string): boolean {
  if (!callsign) return false;
  return callsign.replace(/\s+/g, "") === icaoIdent;
}

/**
 * Pick the flight whose firstSeen is closest to midday UTC of the target date.
 * A >2-day departure window can contain the same daily flight on adjacent
 * days — the closest match wins; the count of candidates is reported.
 */
export function pickBestFlight(
  flights: OpenSkyFlight[],
  icaoIdent: string,
  targetDate: string,
): { flight: OpenSkyFlight; candidates: number } | null {
  const noon = Date.parse(`${targetDate}T12:00:00Z`) / 1000;
  if (!Number.isFinite(noon)) return null;
  const matching = flights.filter((f) => callsignMatches(f.callsign, icaoIdent) && f.firstSeen != null);
  if (matching.length === 0) return null;
  let best = matching[0];
  for (const f of matching) {
    if (Math.abs((f.firstSeen as number) - noon) < Math.abs((best.firstSeen as number) - noon)) best = f;
  }
  return { flight: best, candidates: matching.length };
}

/** Parse /tracks/all path entries into TrackPoints (meters -> feet). */
export function parseOpenSkyTrack(raw: unknown, provenanceNote: string): TrackPoint[] {
  if (!raw || typeof raw !== "object") return [];
  const path = (raw as Record<string, unknown>).path;
  if (!Array.isArray(path)) return [];
  const out: TrackPoint[] = [];
  for (const p of path) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const time = asNum(p[0]);
    const lat = asNum(p[1]);
    const lon = asNum(p[2]);
    if (time == null || lat == null || lon == null) continue;
    const altM = asNum(p[3]);
    out.push({
      timestamp: new Date(time * 1000).toISOString(),
      lat,
      lon,
      altitudeFt: altM == null ? null : Math.round(altM / M_PER_FT),
      groundspeedKt: null, // not provided by the tracks endpoint
      headingDeg: asNum(p[4]),
      provenance: "verified",
    });
  }
  void provenanceNote;
  return out;
}

export class OpenSkyProvider {
  readonly name = "opensky";
  private token: { value: string; expiresAt: number } | null = null;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: OpenSkyOptions = {}) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async authHeader(): Promise<Record<string, string>> {
    // Historical /flights/* requires authentication (verified: anonymous gets
    // HTTP 403 "You cannot access historical flights"). Credentials are free.
    if (!this.clientId || !this.clientSecret) {
      throw new FlightLookupError(
        "unauthorized",
        "OpenSky historical data needs a free OpenSky API client — add it in Settings. Anonymous access does not include historical flights.",
      );
    }
    const now = Date.now();
    if (this.token && now < this.token.expiresAt - 30_000) {
      return { Authorization: `Bearer ${this.token.value}` };
    }
    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new FlightLookupError("unauthorized", "OpenSky token exchange failed — check client id/secret.");
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new FlightLookupError("unauthorized", "OpenSky returned no access token.");
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 1800) * 1000 };
    return { Authorization: `Bearer ${this.token.value}` };
  }

  private async get(path: string): Promise<unknown> {
    const headers = await this.authHeader();
    const res = await this.fetchFn(`${BASE}${path}`, { headers });
    if (res.status === 404) throw new FlightLookupError("empty", "No flights found for this query.");
    if (!res.ok) throw new FlightLookupError(classifyHttpError(res.status), `OpenSky request failed (HTTP ${res.status}).`);
    return res.json();
  }

  /**
   * Find a historical flight by callsign via departures at the origin.
   * The window must cover more than two days (UTC) per the API docs, so we
   * query [date-1d 00:00Z, date+2d 00:00Z).
   */
  async findFlight(
    flightNumber: string,
    date: string,
    origin: string,
  ): Promise<{ flight: OpenSkyFlight; candidates: number; state: ProviderState }> {
    const { icaoIdent } = normalizeFlightNumber(flightNumber);
    const dayStart = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(dayStart)) throw new FlightLookupError("invalid_format", `Bad date "${date}".`);
    const begin = Math.floor(dayStart / 1000) - 86400;
    const end = Math.floor(dayStart / 1000) + 2 * 86400;
    const raw = (await this.get(
      `/flights/departure?airport=${encodeURIComponent(origin.toUpperCase())}&begin=${begin}&end=${end}`,
    )) as unknown[];
    const flights = (Array.isArray(raw) ? raw : []).map(parseOpenSkyFlight).filter((f): f is OpenSkyFlight => f !== null);
    const picked = pickBestFlight(flights, icaoIdent, date);
    if (!picked) throw new FlightLookupError("empty", `No departure matching ${icaoIdent} found at ${origin.toUpperCase()} in the search window.`);
    return { ...picked, state: "ok" as ProviderState };
  }

  /**
   * Recorded ADS-B track for an aircraft at a given time.
   * Returns state "empty" (not an error) when the track is unavailable —
   * notably for flights more than 30 days in the past (documented limit).
   */
  async getTrack(icao24: string, time: number): Promise<{ points: TrackPoint[]; state: ProviderState; note: string }> {
    let raw: unknown;
    try {
      raw = await this.get(`/tracks/all?icao24=${encodeURIComponent(icao24.toLowerCase())}&time=${Math.floor(time)}`);
    } catch (e) {
      if (e instanceof FlightLookupError && e.state === "empty") {
        return {
          points: [],
          state: "empty",
          note: "No track from OpenSky for this flight — the tracks endpoint only covers the last 30 days and is experimental.",
        };
      }
      throw e;
    }
    const points = parseOpenSkyTrack(raw, SOURCE);
    if (points.length === 0) {
      return { points: [], state: "empty", note: "OpenSky returned a track with no usable positions." };
    }
    return {
      points,
      state: "ok",
      note: `ADS-B track from ${SOURCE}; waypoints are decimated (at least every 15 min or on significant change) — general movement pattern, not full resolution.`,
    };
  }

  /** Quota/attribution summary for settings/docs UI. */
  static describeAccess(hasCredentials: boolean): string {
    return hasCredentials
      ? "Authenticated (free OpenSky account): 4,000 credits/day per endpoint bucket. A historical departure search costs ~180 credits; a track fetch ~30. Results are cached for 24 h."
      : "Historical OpenSky data needs a free OpenSky API client (no payment) — anonymous requests are rejected with HTTP 403. Add it in Settings.";
  }

  static readonly SOURCE = SOURCE;
}
