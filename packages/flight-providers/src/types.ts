/**
 * Provider-neutral flight lookup abstraction (Feature A).
 *
 * Required interface per spec:
 *   lookupFlight(flightNumber, date)
 *   getFiledRoute(flightId)
 *   getRecordedTrack(flightId)
 *   getAircraftInformation(flightId)
 *
 * HARD RULE: a lookup must never fabricate an ILS approach, waypoint sequence
 * or runway. Partial data is returned as-is with unavailable fields listed.
 */
import type {
  Field,
  FlightLookupResult,
  Provenance,
  ProviderState,
  RouteFix,
  TrackPoint,
} from "@flightdeck/shared-models";

export interface FlightProvider {
  readonly name: string;
  /** full lookup: flight facts + filed route + track + aircraft in one call */
  lookupFlight(flightNumber: string, date: string): Promise<FlightLookupResult>;
  getFiledRoute(flightId: string): Promise<{ fixes: RouteFix[]; state: ProviderState }>;
  getRecordedTrack(flightId: string): Promise<{ points: TrackPoint[]; state: ProviderState }>;
  getAircraftInformation(
    flightId: string,
  ): Promise<{ aircraftType: string | null; registration: string | null; state: ProviderState }>;
}

export type { Field, Provenance };

/** Build a Field with provenance; null value forces unavailable. */
export function fld<T>(
  value: T | null | undefined,
  provenance: Provenance,
  source?: string,
  note?: string,
): Field<T> {
  const v = value ?? null;
  return {
    value: v,
    provenance: v === null ? "unavailable" : provenance,
    ...(source ? { source } : {}),
    ...(note ? { note } : {}),
    retrievedAt: new Date().toISOString(),
  };
}

/** Normalize user input: "EI106", "ei 106", "EIN106" -> { icaoIdent, iataIdent } */
export function normalizeFlightNumber(raw: string): { icaoIdent: string; display: string } {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, "");
  const m = cleaned.match(/^([A-Z]{2,3})(\d{1,4}[A-Z]?)$/);
  if (!m) throw new FlightLookupError("invalid_format", `Cannot parse flight number "${raw}". Use e.g. EI106.`);
  const [, airline, num] = m;
  // ICAO 3-letter prefixes we know; otherwise keep as typed.
  const ICAO: Record<string, string> = {
    EI: "EIN",
    BA: "BAW",
    AA: "AAL",
    DL: "DAL",
    UA: "UAL",
    LH: "DLH",
    AF: "AFR",
    KL: "KLM",
    IB: "IBE",
    VS: "VIR",
  };
  const icaoAirline = airline.length === 3 ? airline : (ICAO[airline] ?? airline);
  return { icaoIdent: `${icaoAirline}${num}`, display: cleaned };
}

export class FlightLookupError extends Error {
  constructor(
    public readonly state: ProviderState | "invalid_format",
    message: string,
  ) {
    super(message);
    this.name = "FlightLookupError";
  }
}

/** Coerce an error state to a valid ProviderState for interface returns. */
export function toProviderState(s: ProviderState | "invalid_format"): ProviderState {
  return s === "invalid_format" ? "network_error" : s;
}

/** Map a fetch failure to an explicit ProviderState — never a silent guess. */
export function classifyHttpError(status: number): ProviderState {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "empty";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "network_error";
  return "network_error";
}
