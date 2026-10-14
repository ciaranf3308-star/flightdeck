/**
 * FlightAware AeroAPI v4 adapter.
 *
 * Official docs: https://www.flightaware.com/aeroapi/portal/documentation
 * Endpoint paths below follow the documented v4 REST surface; see
 * research/api-research.md for the verification notes. API key is supplied
 * by the caller (from app settings / secure storage) — never hardcoded.
 */
import type {
  AirportRef,
  FlightLookupResult,
  RouteFix,
  RouteFixType,
  TrackPoint,
} from "@flightdeck/shared-models";
import { classifyHttpError, fld, FlightLookupError, normalizeFlightNumber, toProviderState } from "./types.js";
import type { FlightProvider } from "./types.js";
import type { ProviderState } from "@flightdeck/shared-models";

const BASE = "https://aeroapi.flightaware.com/aeroapi";
const SOURCE = "FlightAware AeroAPI v4";

interface AeroFlight {
  fa_flight_id: string;
  ident: string;
  ident_icao?: string | null;
  ident_iata?: string | null;
  operator?: string | null;
  operator_icao?: string | null;
  flight_number?: string | null;
  origin?: AeroAirport | null;
  destination?: AeroAirport | null;
  aircraft_type?: string | null;
  registration?: string | null;
  status?: string | null;
  cancelled?: boolean;
  diverted?: boolean;
  blocked?: boolean;
  scheduled_out?: string | null;
  scheduled_off?: string | null;
  scheduled_on?: string | null;
  scheduled_in?: string | null;
  estimated_out?: string | null;
  estimated_in?: string | null;
  actual_out?: string | null;
  actual_off?: string | null;
  actual_on?: string | null;
  actual_in?: string | null;
  actual_runway_off?: string | null;
  actual_runway_on?: string | null;
  filed_ete?: number | null;
  filed_airspeed?: number | null;
  filed_altitude?: number | null;
  route_distance?: number | null;
}

interface AeroAirport {
  code_icao?: string | null;
  code_iata?: string | null;
  name?: string | null;
  city?: string | null;
  timezone?: string | null;
}

interface AeroFix {
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  type?: string | null;
  outbound_course?: number | null;
}

interface AeroPosition {
  timestamp?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  groundspeed?: number | null;
  heading?: number | null;
}

export interface FlightAwareConfig {
  apiKey: string;
  timeoutMs?: number;
}

export class FlightAwareProvider implements FlightProvider {
  readonly name = "flightaware";
  private key: string;
  private timeoutMs: number;

  constructor(config: FlightAwareConfig) {
    if (!config.apiKey) throw new FlightLookupError("not_configured", "FlightAware API key is not configured.");
    this.key = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 30000;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "x-apikey": this.key }, signal: ctrl.signal });
    } catch {
      clearTimeout(t);
      throw new FlightLookupError("network_error", `Network error reaching FlightAware (${path}).`);
    }
    clearTimeout(t);
    if (!res.ok) {
      const state = classifyHttpError(res.status);
      const label: Record<string, string> = {
        empty: "FlightAware has no record for this flight/date.",
        unauthorized: "FlightAware rejected the API key (unauthorized). Check Settings.",
        rate_limited: "FlightAware rate limit reached. Try again later.",
        network_error: `FlightAware request failed (HTTP ${res.status}).`,
      };
      throw new FlightLookupError(state === "network_error" ? "network_error" : state, label[state] ?? label.network_error);
    }
    return (await res.json()) as T;
  }

  async lookupFlight(flightNumber: string, date: string): Promise<FlightLookupResult> {
    const { icaoIdent, display } = normalizeFlightNumber(flightNumber);
    // AeroAPI expects a window; use the local departure date as a UTC day window.
    const start = `${date}T00:00:00Z`;
    const end = `${date}T23:59:59Z`;
    // Flights older than 10 days must use the /history endpoints (Standard tier+).
    const ageDays = (Date.now() - new Date(start).getTime()) / 86400000;
    const path = ageDays > 10 ? `/history/flights/${icaoIdent}` : `/flights/${icaoIdent}`;
    let data: { flights?: AeroFlight[] };
    try {
      data = await this.get<{ flights?: AeroFlight[] }>(path, { start, end, ident_type: "designator" });
    } catch (e) {
      if (e instanceof FlightLookupError && e.state !== "invalid_format") {
        return emptyResult(display, date, e.state, e.message);
      }
      throw e;
    }
    const flights = data.flights ?? [];
    if (flights.length === 0) return emptyResult(display, date, "empty", `No ${display} flights found on ${date}.`);
    // Pick the flight whose scheduled departure falls on the requested date.
    const flight =
      flights.find((f) => (f.scheduled_out ?? "").startsWith(date)) ??
      flights.find((f) => !f.cancelled) ??
      flights[0];
    return this.toLookupResult(display, date, flight);
  }

  async getFiledRoute(flightId: string) {
    try {
      const data = await this.get<{ fixes?: AeroFix[] }>(`/flights/${encodeURIComponent(flightId)}/route`);
      const fixes = (data.fixes ?? []).map(mapFix);
      return { fixes, state: "ok" as ProviderState };
    } catch (e) {
      return { fixes: [], state: e instanceof FlightLookupError ? toProviderState(e.state) : ("network_error" as ProviderState) };
    }
  }

  async getRecordedTrack(flightId: string) {
    try {
      const data = await this.get<{ positions?: AeroPosition[] }>(`/flights/${encodeURIComponent(flightId)}/track`);
      const points: TrackPoint[] = (data.positions ?? [])
        .filter((p) => p.latitude != null && p.longitude != null && p.timestamp)
        .map((p) => ({
          timestamp: p.timestamp as string,
          lat: p.latitude as number,
          lon: p.longitude as number,
          altitudeFt: p.altitude != null ? p.altitude * 100 : null,
          groundspeedKt: p.groundspeed ?? null,
          headingDeg: p.heading ?? null,
          provenance: "verified" as const,
        }));
      return { points, state: "ok" as ProviderState };
    } catch (e) {
      return { points: [], state: e instanceof FlightLookupError ? toProviderState(e.state) : ("network_error" as ProviderState) };
    }
  }

  async getAircraftInformation(flightId: string) {
    try {
      const data = await this.get<AeroFlight>(`/flights/${encodeURIComponent(flightId)}`);
      return {
        aircraftType: data.aircraft_type ?? null,
        registration: data.registration ?? null,
        state: "ok" as ProviderState,
      };
    } catch (e) {
      return {
        aircraftType: null,
        registration: null,
        state: e instanceof FlightLookupError ? toProviderState(e.state) : ("network_error" as ProviderState),
      };
    }
  }

  private async toLookupResult(display: string, date: string, f: AeroFlight): Promise<FlightLookupResult> {
    const unavailableFields: string[] = [];
    const warnings: string[] = [];
    const need = (label: string, v: unknown) => {
      if (v == null || v === "") unavailableFields.push(label);
    };
    need("registration", f.registration);
    need("filedCruiseAltitude", f.filed_altitude);
    need("actualRunwayDeparture", f.actual_runway_off);
    need("actualRunwayArrival", f.actual_runway_on);
    if (f.blocked) warnings.push("FlightAware marks this flight's data as blocked; some fields are withheld.");
    if (f.diverted) warnings.push("This flight was diverted; origin/destination reflect the filed plan.");
    if (f.cancelled) warnings.push("This flight was cancelled.");

    const [route, track] = await Promise.all([
      this.getFiledRoute(f.fa_flight_id).catch(() => ({ fixes: [], state: "unavailable" as ProviderState })),
      this.getRecordedTrack(f.fa_flight_id).catch(() => ({ points: [], state: "unavailable" as ProviderState })),
    ]);
    if (route.fixes.length === 0) {
      unavailableFields.push("filedRoute");
      warnings.push("FlightAware returned no filed route fixes for this flight.");
    } else {
      const noCoords = route.fixes.filter((x) => x.lat == null).map((x) => x.name);
      if (noCoords.length > 0)
        warnings.push(
          `Filed route fixes without coordinates from provider (shown by name only): ${noCoords.join(", ")}.`,
        );
    }
    if (track.points.length === 0) {
      unavailableFields.push("recordedTrack");
      warnings.push("FlightAware returned no recorded track for this flight.");
    }

    const origin = mapAirport(f.origin);
    const destination = mapAirport(f.destination);
    need("origin", origin);
    need("destination", destination);

    return {
      flightId: f.fa_flight_id,
      flightNumber: display,
      identIcao: f.ident_icao ?? f.ident ?? undefined,
      date,
      provider: this.name,
      state: "ok",
      origin: fld(origin, "verified", SOURCE),
      destination: fld(destination, "verified", SOURCE),
      airline: fld(f.operator_icao ?? f.operator ?? null, "verified", SOURCE),
      scheduledDeparture: fld(f.scheduled_out ?? null, "verified", SOURCE),
      scheduledArrival: fld(f.scheduled_in ?? null, "verified", SOURCE),
      actualDeparture: fld(f.actual_off ?? f.actual_out ?? null, "verified", SOURCE, "wheels-off preferred; falls back to gate departure"),
      actualArrival: fld(f.actual_on ?? f.actual_in ?? null, "verified", SOURCE, "touchdown preferred; falls back to gate arrival"),
      actualRunwayDeparture: fld(f.actual_runway_off ?? null, "verified", SOURCE),
      actualRunwayArrival: fld(f.actual_runway_on ?? null, "verified", SOURCE),
      aircraftType: fld(f.aircraft_type ?? null, "verified", SOURCE),
      registration: fld(f.registration ?? null, "verified", SOURCE),
      filedRoute: fld(route.fixes.length ? route.fixes : null, "verified", SOURCE),
      filedCruiseAltitudeFt: fld(f.filed_altitude ?? null, "verified", SOURCE),
      recordedTrack: fld(track.points.length ? track.points : null, "verified", SOURCE),
      unavailableFields,
      warnings,
      retrievedAt: new Date().toISOString(),
    };
  }
}

function emptyResult(flightNumber: string, date: string, state: ProviderState, message: string): FlightLookupResult {
  const u = <T>(): import("@flightdeck/shared-models").Field<T> => ({
    value: null,
    provenance: "unavailable",
    note: message,
    retrievedAt: new Date().toISOString(),
  });
  return {
    flightId: "",
    flightNumber,
    date,
    provider: "flightaware",
    state,
    origin: u(),
    destination: u(),
    airline: u(),
    scheduledDeparture: u(),
    scheduledArrival: u(),
    actualDeparture: u(),
    actualArrival: u(),
    actualRunwayDeparture: u(),
    actualRunwayArrival: u(),
    aircraftType: u(),
    registration: u(),
    filedRoute: u(),
    filedCruiseAltitudeFt: u(),
    recordedTrack: u(),
    unavailableFields: ["all"],
    warnings: [message],
    retrievedAt: new Date().toISOString(),
  };
}

function mapAirport(a?: AeroAirport | null): AirportRef | null {
  if (!a?.code_icao) return null;
  // Coordinates are not part of the AeroAPI airport object; the app resolves
  // them from local reference data. Missing coords are marked, not guessed.
  return {
    icao: a.code_icao,
    ...(a.code_iata ? { iata: a.code_iata } : {}),
    name: a.name ?? a.code_icao,
    ...(a.city ? { city: a.city } : {}),
    position: { lat: 0, lon: 0 }, // placeholder replaced by navigation reference data
    ...(a.timezone ? { timezone: a.timezone } : {}),
  };
}

const FIX_TYPE_MAP: Record<string, RouteFixType> = {
  "origin airport": "origin",
  "destination airport": "destination",
  waypoint: "waypoint",
  "vor-dme (navaid)": "vor",
  "vor (navaid)": "vor",
  "ndb (navaid)": "ndb",
  "reporting point": "reporting_point",
  unknown: "unknown",
};

/** North Atlantic track coordinate names like 5030N / N503B have no fixed coords. */
function isNatName(name: string): boolean {
  return /^N?\d{4}[NS]?[A-Z]?$/.test(name) || /^(NAT[A-Z]|MALOT|GISTI|OSGAR|ALLRY|SUNOT|DOGAL)$/.test(name);
}

export function mapFix(f: AeroFix): RouteFix {
  const name = f.name ?? "UNKNOWN";
  const type = FIX_TYPE_MAP[(f.type ?? "").toLowerCase()] ?? (isNatName(name) ? "nat" : "unknown");
  const hasCoords = f.latitude != null && f.longitude != null;
  return {
    name,
    lat: hasCoords ? (f.latitude as number) : null,
    lon: hasCoords ? (f.longitude as number) : null,
    type,
    ...(f.name ? { raw: f.name } : {}),
    provenance: hasCoords ? "verified" : "unavailable",
    ...(hasCoords ? {} : { note: "Provider returned this fix without coordinates." }),
  };
}
