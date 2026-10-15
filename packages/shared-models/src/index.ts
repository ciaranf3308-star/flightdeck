/**
 * @flightdeck/shared-models
 *
 * Canonical data contracts for FlightDeck. Every boundary (provider, engine,
 * exporter, UI) validates through these Zod schemas.
 *
 * DESIGN RULE (hard): no aviation fact may be presented without provenance.
 * A missing value is `unavailable` — never a plausible-looking guess.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Provenance — the honesty core
// ---------------------------------------------------------------------------
/**
 * verified    — came from an authoritative source (provider API, real navdata)
 * inferred    — derived by deterministic rule from verified data (e.g. runway
 *               from wind), must list the rule in `note`
 * generated   — produced locally (e.g. interpolated track point), never
 *               presented as a real-world fact
 * imported    — supplied by the user (file import); taken as-is, not
 *               independently verified — source filename is recorded
 * unavailable — the source did not provide it; `value` must be null
 */
export const Provenance = z.enum(["verified", "inferred", "generated", "unavailable", "imported"]);
export type Provenance = z.infer<typeof Provenance>;

/** A single value carrying its provenance. Unavailable => value is null. */
export function field<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      value: valueSchema.nullable(),
      provenance: Provenance,
      /** human-readable source, e.g. "FlightAware AeroAPI 2026-10-13" */
      source: z.string().optional(),
      /** ISO timestamp of retrieval/generation */
      retrievedAt: z.string().optional(),
      /** why inferred/unavailable, or caveats */
      note: z.string().optional(),
    })
    .refine((f) => f.provenance !== "unavailable" || f.value === null, {
      message: "unavailable fields must have null value",
    })
    .refine((f) => f.provenance === "unavailable" || f.value !== null, {
      message: "non-unavailable fields must have a value",
    });
}
export type Field<T> = {
  value: T | null;
  provenance: Provenance;
  source?: string;
  retrievedAt?: string;
  note?: string;
};

// ---------------------------------------------------------------------------
// Provider states — explicit, never silent
// ---------------------------------------------------------------------------
export const ProviderState = z.enum([
  "ok",
  "empty", // provider answered, no matching flight
  "unavailable", // provider has no data for this query (e.g. blocked tail)
  "rate_limited",
  "unauthorized",
  "network_error",
  "not_configured", // e.g. no API key in settings
]);
export type ProviderState = z.infer<typeof ProviderState>;

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------
export const LatLon = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type LatLon = z.infer<typeof LatLon>;

// ---------------------------------------------------------------------------
// Airports / runways (reference data)
// ---------------------------------------------------------------------------
export const AirportRef = z.object({
  icao: z.string().length(4),
  iata: z.string().optional(),
  name: z.string(),
  city: z.string().optional(),
  country: z.string().optional(),
  position: LatLon,
  elevationFt: z.number().optional(),
  timezone: z.string().optional(),
});
export type AirportRef = z.infer<typeof AirportRef>;

// ---------------------------------------------------------------------------
// Flight lookup (Feature A)
// ---------------------------------------------------------------------------
export const RouteFixType = z.enum([
  "origin",
  "destination",
  "waypoint",
  "vor",
  "ndb",
  "reporting_point",
  "nat", // North Atlantic track coordinate / named oceanic point
  "unknown",
]);
export type RouteFixType = z.infer<typeof RouteFixType>;

export const RouteFix = z.object({
  name: z.string(),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
  type: RouteFixType,
  /** e.g. "N503B" oceanic designator kept verbatim when coords missing */
  raw: z.string().optional(),
  provenance: Provenance,
  note: z.string().optional(),
});
export type RouteFix = z.infer<typeof RouteFix>;

export const TrackPoint = z.object({
  timestamp: z.string(), // ISO
  lat: z.number(),
  lon: z.number(),
  altitudeFt: z.number().nullable(),
  groundspeedKt: z.number().nullable(),
  headingDeg: z.number().nullable(),
  provenance: Provenance,
});
export type TrackPoint = z.infer<typeof TrackPoint>;

export const FlightLookupResult = z.object({
  flightId: z.string(), // provider flight id, e.g. fa_flight_id
  flightNumber: z.string(), // as entered, e.g. "EI106"
  identIcao: z.string().optional(), // e.g. "EIN106"
  date: z.string(), // local departure date YYYY-MM-DD
  provider: z.string(), // "flightaware" | "fixtures" | ...
  state: ProviderState,
  origin: field(AirportRef),
  destination: field(AirportRef),
  airline: field(z.string()),
  scheduledDeparture: field(z.string()),
  scheduledArrival: field(z.string()),
  actualDeparture: field(z.string()),
  actualArrival: field(z.string()),
  actualRunwayDeparture: field(z.string()),
  actualRunwayArrival: field(z.string()),
  aircraftType: field(z.string()), // ICAO, e.g. "A333"
  registration: field(z.string()),
  filedRoute: field(z.array(RouteFix)),
  filedCruiseAltitudeFt: field(z.number()),
  recordedTrack: field(z.array(TrackPoint)),
  /** exactly which fields the provider could not supply */
  unavailableFields: z.array(z.string()),
  warnings: z.array(z.string()),
  retrievedAt: z.string(),
});
export type FlightLookupResult = z.infer<typeof FlightLookupResult>;

// ---------------------------------------------------------------------------
// Navigation data (Feature C inputs)
// ---------------------------------------------------------------------------
export const Runway = z.object({
  id: z.string(), // "31L"
  headingDeg: z.number().min(0).max(360),
  lengthFt: z.number(),
  widthFt: z.number().optional(),
  ils: z
    .object({
      /** ILS identifier as published, e.g. "IDLE" — never invented */
      ident: z.string().nullable(),
      frequencyMHz: z.number().nullable(),
      courseDeg: z.number().nullable(),
      gsAngleDeg: z.number().default(3.0),
      category: z.enum(["I", "II", "IIIa", "IIIb", "IIIc"]).nullable(),
    })
    .nullable(),
  provenance: Provenance,
  note: z.string().optional(),
});
export type Runway = z.infer<typeof Runway>;

export const ProcedureKind = z.enum(["SID", "STAR", "APPROACH"]);
export type ProcedureKind = z.infer<typeof ProcedureKind>;

export const ApproachKind = z.enum(["ILS", "RNAV", "VOR", "NDB", "VISUAL", "OTHER"]);
export type ApproachKind = z.infer<typeof ApproachKind>;

export const Procedure = z.object({
  id: z.string(), // e.g. "OSGAR4L", "ILS28L"
  kind: ProcedureKind,
  airport: z.string(), // ICAO
  runway: z.string().nullable(), // null for runway-agnostic (rare)
  transitions: z.array(z.string()),
  /** resolved coordinates for transitions, when sourced from live sim navdata (enables geometric selection) */
  transitionPositions: z.record(z.string(), LatLon).optional(),
  approachKind: ApproachKind.nullable(), // set for APPROACH
  waypoints: z.array(z.string()), // fix names in order
  constraints: z.array(
    z.object({
      fix: z.string(),
      altitudeFt: z.number().nullable(),
      speedKt: z.number().nullable(),
      note: z.string().optional(),
    }),
  ),
  navdataCycle: z.string(),
  provenance: Provenance,
  note: z.string().optional(),
});
export type Procedure = z.infer<typeof Procedure>;

export const AirportNavData = z.object({
  airport: AirportRef,
  runways: z.array(Runway),
  procedures: z.array(Procedure),
  navdataCycle: z.string(),
  provenance: Provenance,
  note: z.string().optional(),
});
export type AirportNavData = z.infer<typeof AirportNavData>;

// ---------------------------------------------------------------------------
// Route engine output (Feature C)
// ---------------------------------------------------------------------------
export const ValidationStatus = z.enum(["valid", "valid_with_warnings", "invalid", "unknown"]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

/**
 * Confidence is evidence-derived, never a made-up percentage.
 * `score` = evidenceFor.length / (for+against+missing) — a plain fraction
 * with its evidence listed. The UI renders the evidence, not just the number.
 */
export const Confidence = z.object({
  level: z.enum(["high", "medium", "low", "unknown"]),
  score: z.number().min(0).max(1),
  evidenceFor: z.array(z.string()),
  evidenceAgainst: z.array(z.string()),
  evidenceMissing: z.array(z.string()),
});
export type Confidence = z.infer<typeof Confidence>;

export const ProcedureRecommendation = z.object({
  procedureId: z.string().nullable(),
  runway: z.string().nullable(),
  transition: z.string().nullable(),
  navdataCycle: z.string(),
  selectionReasons: z.array(z.string()),
  warnings: z.array(z.string()),
  confidence: Confidence,
  validationStatus: ValidationStatus,
});
export type ProcedureRecommendation = z.infer<typeof ProcedureRecommendation>;

export const PlanProcedures = z.object({
  departureRunway: ProcedureRecommendation,
  sid: ProcedureRecommendation,
  arrivalRunway: ProcedureRecommendation,
  star: ProcedureRecommendation,
  approach: ProcedureRecommendation,
});
export type PlanProcedures = z.infer<typeof PlanProcedures>;

export const PlanMode = z.enum(["historical", "current"]);
export type PlanMode = z.infer<typeof PlanMode>;

export const FlightPlan = z.object({
  id: z.string(),
  flightNumber: z.string(),
  date: z.string(),
  mode: PlanMode,
  origin: AirportRef,
  destination: AirportRef,
  aircraftType: z.string().nullable(),
  registration: z.string().nullable(),
  /** ordered fixes; fixes without coordinates are kept with provenance note */
  fixes: z.array(RouteFix),
  cruiseAltitudeFt: z.number().nullable(),
  procedures: PlanProcedures,
  /** player overrides, keyed by slot */
  overrides: z.record(z.string(), z.string()).default({}),
  navdataCycle: z.string(),
  /** filed route vs actual track distinction is preserved, not merged */
  sourceRouteKind: z.enum(["filed", "recorded_track", "simbrief_ofp", "manual", "none"]),
  warnings: z.array(z.string()),
  createdAt: z.string(),
});
export type FlightPlan = z.infer<typeof FlightPlan>;

// ---------------------------------------------------------------------------
// MSFS 2024 export (Feature D)
// ---------------------------------------------------------------------------
export const MsfsExportResult = z.object({
  xml: z.string(),
  format: z.string(), // e.g. "msfs2024-efb-pln/1.0" — documents what we emitted
  includedFixes: z.array(z.string()),
  excludedFixes: z.array(z.object({ name: z.string(), reason: z.string() })),
  warnings: z.array(z.string()),
});
export type MsfsExportResult = z.infer<typeof MsfsExportResult>;

// ---------------------------------------------------------------------------
// SimBrief OFP import (Feature B)
// ---------------------------------------------------------------------------
export const SimBriefOfpSummary = z.object({
  flightNumber: z.string().nullable(),
  callsign: z.string().nullable(),
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  aircraftType: z.string().nullable(),
  routeFixes: z.array(z.string()),
  sid: z.string().nullable(),
  star: z.string().nullable(),
  cruiseAltitudeFt: z.number().nullable(),
  fuelKg: z.number().nullable(),
  alternate: z.string().nullable(),
  airacCycle: z.string().nullable(),
  raw: z.unknown(), // full parsed payload for inspection
});
export type SimBriefOfpSummary = z.infer<typeof SimBriefOfpSummary>;

// ---------------------------------------------------------------------------
// Aircraft profiles (aircraft-adapters)
// ---------------------------------------------------------------------------
export const AircraftProfile = z.object({
  id: z.string(), // e.g. "inibuilds-a333"
  label: z.string(), // "iniBuilds Airbus A330-300"
  icaoType: z.string(), // "A333"
  approachCategory: z.enum(["A", "B", "C", "D", "E"]).nullable(),
  /** minimum runway length required at MTOW-ish planning weight */
  minRunwayLengthFt: z.number().nullable(),
  supportedApproachKinds: z.array(ApproachKind),
  maxCruiseAltitudeFt: z.number().nullable(),
  provenance: Provenance,
  note: z.string().optional(),
});
export type AircraftProfile = z.infer<typeof AircraftProfile>;

// ---------------------------------------------------------------------------
// Telemetry (simconnect-bridge contract)
// ---------------------------------------------------------------------------
export const TelemetrySample = z.object({
  timestamp: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  altitudeFt: z.number().nullable(),
  groundspeedKt: z.number().nullable(),
  headingDeg: z.number().nullable(),
  verticalSpeedFpm: z.number().nullable(),
  onGround: z.boolean().nullable(),
  autopilotMaster: z.boolean().nullable(),
  connected: z.boolean(),
});
export type TelemetrySample = z.infer<typeof TelemetrySample>;

// ---------------------------------------------------------------------------
// Historical sources — provider-independent Historical Replay
// ---------------------------------------------------------------------------
/**
 * Where historical flight data came from. FlightAware is strictly optional
 * (paid); the free and imported alternatives keep Historical Replay fully
 * functional without it.
 */
export const HistoricalSourceId = z.enum(["adsbaero", "flightaware", "opensky", "import", "reconstruction"]);
export type HistoricalSourceId = z.infer<typeof HistoricalSourceId>;

/**
 * What kind of position history we hold — the core honesty distinction.
 * verified      — real recorded ADS-B/provider track
 * imported      — user-supplied file, taken as-is (not independently verified)
 * reconstructed — generated reference route, NEVER the actual flown route
 * unavailable   — no position history from this source
 */
export const TrackKind = z.enum(["verified", "imported", "reconstructed", "unavailable"]);
export type TrackKind = z.infer<typeof TrackKind>;

export const HistoricalSourceAttempt = z.object({
  source: HistoricalSourceId,
  /** short human label, e.g. "OpenSky Network (free)" */
  label: z.string(),
  found: z.boolean(),
  trackKind: TrackKind,
  /** one-line attribution or the reason nothing was found */
  detail: z.string(),
});
export type HistoricalSourceAttempt = z.infer<typeof HistoricalSourceAttempt>;
