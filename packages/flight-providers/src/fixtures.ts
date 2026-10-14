/**
 * Fixtures provider — serves labelled snapshot data for repeatable tests and
 * offline use. Every value keeps the provenance of the snapshot it came from;
 * nothing is invented to fill gaps.
 *
 * Snapshot layout:
 *   <fixturesRoot>/<slug>/flight.json   (FlightAware-style flight payload)
 *   <fixturesRoot>/<slug>/route.json    (filed route fixes)
 *   <fixturesRoot>/<slug>/track.json    (recorded positions)
 * where slug = "<iata-lower>-<YYYY-MM-DD>", e.g. "ei106-2026-10-09".
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AirportRef,
  FlightLookupResult,
  RouteFix,
  TrackPoint,
} from "@flightdeck/shared-models";
import type { ProviderState } from "@flightdeck/shared-models";
import { fld, FlightLookupError, normalizeFlightNumber } from "./types.js";
import type { FlightProvider } from "./types.js";
import { mapFix } from "./flightaware.js";

export interface FixturesConfig {
  fixturesRoot: string;
}

export class FixturesProvider implements FlightProvider {
  readonly name = "fixtures";
  constructor(private config: FixturesConfig) {}

  private slug(flightNumber: string, date: string): string {
    const { display } = normalizeFlightNumber(flightNumber);
    return `${display.toLowerCase()}-${date}`;
  }

  private async readJson<T>(slug: string, file: string): Promise<T | null> {
    try {
      const raw = await readFile(join(this.config.fixturesRoot, slug, file), "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async lookupFlight(flightNumber: string, date: string): Promise<FlightLookupResult> {
    let slug: string;
    try {
      slug = this.slug(flightNumber, date);
    } catch (e) {
      throw e;
    }
    const snap = await this.readJson<SnapshotFlight>(slug, "flight.json");
    if (!snap) {
      return emptyFixtureResult(flightNumber, date, `No fixture snapshot for ${flightNumber} on ${date}.`);
    }
    const flight = snap.body?.flights?.[0];
    if (!flight) {
      return emptyFixtureResult(flightNumber, date, `Fixture ${slug} contains no flight records.`);
    }
    const retrievedAt: string = snap.retrieved_at?.utc ?? new Date().toISOString();
    const source = `Fixture snapshot ${slug} (FlightAware data retrieved ${retrievedAt})`;

    const routeSnap = await this.readJson<SnapshotRoute>(slug, "route.json");
    const trackSnap = await this.readJson<SnapshotTrack>(slug, "track.json");
    const fixes: RouteFix[] = (routeSnap?.body?.fixes ?? []).map(mapFix);
    const points: TrackPoint[] = (trackSnap?.body?.positions ?? [])
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

    const unavailableFields: string[] = [];
    const warnings: string[] = [
      "Offline fixture data — values reflect the provider snapshot, not a live query.",
    ];
    const need = (label: string, v: unknown) => {
      if (v == null || v === "") unavailableFields.push(label);
    };
    need("registration", flight.registration);
    need("filedRoute", fixes.length ? true : null);
    need("recordedTrack", points.length ? true : null);
    const noCoords = fixes.filter((x) => x.lat == null).map((x) => x.name);
    if (noCoords.length > 0)
      warnings.push(`Fixes without provider coordinates (name only): ${noCoords.join(", ")}.`);

    const utc = (v: unknown): string | null => {
      if (v == null) return null;
      if (typeof v === "string") return v;
      if (typeof v === "object" && v !== null && "utc" in v) return (v as { utc: string }).utc;
      return null;
    };

    const filedAlt = flight.filed_altitude != null ? flight.filed_altitude * 100 : null;

    return {
      flightId: flight.fa_flight_id ?? "",
      flightNumber: flight.ident_iata ?? flightNumber.toUpperCase(),
      identIcao: flight.ident_icao ?? flight.ident ?? undefined,
      date,
      provider: this.name,
      state: "ok",
      origin: fld(mapSnapAirport(flight.origin), "verified", source),
      destination: fld(mapSnapAirport(flight.destination), "verified", source),
      airline: fld(flight.operator_icao ?? flight.operator ?? null, "verified", source),
      scheduledDeparture: fld(utc(flight.scheduled_gate_departure_at) ?? flight.scheduled_out ?? null, "verified", source),
      scheduledArrival: fld(utc(flight.scheduled_gate_arrival_at) ?? flight.scheduled_in ?? null, "verified", source),
      actualDeparture: fld(utc(flight.actual_takeoff_at) ?? flight.actual_off ?? flight.actual_out ?? null, "verified", source, "wheels-off preferred"),
      actualArrival: fld(utc(flight.actual_landing_at) ?? flight.actual_on ?? flight.actual_in ?? null, "verified", source, "touchdown preferred"),
      actualRunwayDeparture: fld(flight.actual_runway_off ?? null, "verified", source),
      actualRunwayArrival: fld(flight.actual_runway_on ?? null, "verified", source),
      aircraftType: fld(flight.aircraft_type ?? null, "verified", source),
      registration: fld(flight.registration ?? null, "verified", source),
      filedRoute: fld(fixes.length ? fixes : null, "verified", source),
      filedCruiseAltitudeFt: fld(filedAlt, "inferred", source, "Provider reports flight level; converted FL×100 to feet."),
      recordedTrack: fld(points.length ? points : null, "verified", source),
      unavailableFields,
      warnings,
      retrievedAt: new Date().toISOString(),
    };
  }

  async getFiledRoute(flightId: string): Promise<{ fixes: RouteFix[]; state: ProviderState }> {
    // Fixture flightIds are opaque; callers use lookupFlight first, which
    // already returns route+track. Standalone lookup is honestly unavailable.
    void flightId;
    return { fixes: [], state: "unavailable" };
  }

  async getRecordedTrack(flightId: string): Promise<{ points: TrackPoint[]; state: ProviderState }> {
    void flightId;
    return { points: [], state: "unavailable" };
  }

  async getAircraftInformation(flightId: string) {
    return { aircraftType: null, registration: null, state: "unavailable" as ProviderState };
  }
}

function emptyFixtureResult(flightNumber: string, date: string, message: string): FlightLookupResult {
  const u = <T>(): import("@flightdeck/shared-models").Field<T> => ({
    value: null,
    provenance: "unavailable",
    note: message,
    retrievedAt: new Date().toISOString(),
  });
  return {
    flightId: "",
    flightNumber: flightNumber.toUpperCase(),
    date,
    provider: "fixtures",
    state: "empty",
    origin: u(), destination: u(), airline: u(),
    scheduledDeparture: u(), scheduledArrival: u(), actualDeparture: u(), actualArrival: u(),
    actualRunwayDeparture: u(), actualRunwayArrival: u(),
    aircraftType: u(), registration: u(), filedRoute: u(),
    filedCruiseAltitudeFt: u(), recordedTrack: u(),
    unavailableFields: ["all"],
    warnings: [message],
    retrievedAt: new Date().toISOString(),
  };
}

function mapSnapAirport(a: SnapshotAirport | null | undefined): AirportRef | null {
  if (!a?.code_icao) return null;
  return {
    icao: a.code_icao,
    ...(a.code_iata ? { iata: a.code_iata } : {}),
    name: a.name ?? a.code_icao,
    ...(a.city ? { city: a.city } : {}),
    position: { lat: 0, lon: 0 }, // resolved from navigation reference data
    ...(a.timezone ? { timezone: a.timezone } : {}),
  };
}

// --- snapshot shapes (FlightAware CLI wrapper) ---
interface SnapshotFlight {
  body?: { flights?: SnapshotFlightRecord[] };
  retrieved_at?: { utc?: string };
}
interface SnapshotFlightRecord {
  fa_flight_id?: string;
  ident?: string; ident_icao?: string; ident_iata?: string;
  operator?: string; operator_icao?: string;
  origin?: SnapshotAirport | null; destination?: SnapshotAirport | null;
  aircraft_type?: string | null; registration?: string | null;
  status?: string | null; cancelled?: boolean; diverted?: boolean; blocked?: boolean;
  scheduled_out?: string | null; scheduled_in?: string | null;
  scheduled_gate_departure_at?: unknown; scheduled_gate_arrival_at?: unknown;
  actual_takeoff_at?: unknown; actual_landing_at?: unknown;
  actual_out?: string | null; actual_off?: string | null; actual_on?: string | null; actual_in?: string | null;
  actual_runway_off?: string | null; actual_runway_on?: string | null;
  filed_altitude?: number | null; filed_airspeed?: number | null; filed_ete?: number | null;
  route_distance?: number | null;
}
interface SnapshotAirport {
  code_icao?: string | null; code_iata?: string | null; name?: string | null;
  city?: string | null; timezone?: string | null;
}
interface SnapshotRoute { body?: { fixes?: Parameters<typeof mapFix>[0][] } }
interface SnapshotTrack { body?: { positions?: { timestamp?: string | null; latitude?: number | null; longitude?: number | null; altitude?: number | null; groundspeed?: number | null; heading?: number | null }[] } }

export { FlightLookupError };
