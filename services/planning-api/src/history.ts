/**
 * Provider-independent Historical Replay.
 *
 * Source hierarchy (first hit wins for `best`, but every attempt is reported
 * so the UI can offer alternates):
 *
 *   1. adsbaero       — FREE, no key. Verified ADS-B trajectories from the
 *                       adsb.aero archive (coverage checked first via
 *                       /api/v1/data-range). Identity verified by exact
 *                       callsign + date + airport agreement — never a blind
 *                       prefix match. Oceanic coverage gaps are reported,
 *                       never interpolated.
 *   2. import         — the user's own uploaded track files (CSV/GPX/KML),
 *                       matched by flight number + date.
 *   3. opensky        — free OpenSky account (no payment); verified ADS-B
 *                       flight + track (track ≤30 days old). Needs origin.
 *   4. flightaware    — paid, ONLY when the user configured an API key.
 *   5. reconstruction — explicit opt-in only: great-circle reference route,
 *                       every fix generated, never the actual flown route.
 *
 * Paid FlightAware is strictly optional and deliberately NOT first: when no
 * key is configured the source is skipped with an explanatory note and
 * everything else keeps working.
 *
 * Each successful source yields a full FlightLookupResult plus `planFixes` /
 * `planWarnings` so /api/plan can build an exportable plan without ever
 * touching a paid provider.
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  AdsbAeroProvider,
  FlightAwareProvider,
  OpenSkyProvider,
  fld,
  formatGap,
  normalizeFlightNumber,
  parseTrackFile,
  reconstructReferenceRoute,
  trackToFixes,
  type FlightLookupError,
} from "@flightdeck/flight-providers";
import type {
  AirportNavData,
  FlightLookupResult,
  HistoricalSourceAttempt,
  HistoricalSourceId,
  ProviderState,
  RouteFix,
  TrackKind,
  TrackPoint,
} from "@flightdeck/shared-models";
import { getSetting } from "./db.js";

export interface HistoryOption {
  source: HistoricalSourceId;
  label: string;
  trackKind: TrackKind;
  detail: string;
  lookup: FlightLookupResult;
  track: TrackPoint[];
  /** Fixes /api/plan should use when the source has no filed route. */
  planFixes: RouteFix[];
  planWarnings: string[];
}

export interface HistoryResponse {
  attempts: HistoricalSourceAttempt[];
  options: HistoryOption[];
}

export interface HistoryRequest {
  flightNumber: string;
  date: string;
  origin?: string;
  destination?: string;
  allowReconstruction?: boolean;
  openskyClientId?: string;
  openskyClientSecret?: string;
}

// ---------------------------------------------------------------------------
// Imports store
// ---------------------------------------------------------------------------

export interface StoredImport {
  id: string;
  flightNumber: string;
  date: string;
  filename: string;
  points: TrackPoint[];
  createdAt: string;
}

export function initImportsTable(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  flight_number TEXT NOT NULL,
  flight_date TEXT NOT NULL,
  filename TEXT NOT NULL,
  track_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_flight ON imports(flight_number, flight_date);
`);
}

/** Parse + store a user-uploaded track file. Throws ImportParseError on bad input. */
export function storeImport(
  db: DatabaseSync,
  flightNumber: string,
  date: string,
  filename: string,
  content: string,
): { stored: StoredImport; warnings: string[] } {
  const norm = normalizeFlightNumber(flightNumber);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD.");
  const parsed = parseTrackFile(filename, content);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO imports(id, flight_number, flight_date, filename, track_json, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(id, norm.display, date, filename, JSON.stringify(parsed.points), now);
  return {
    stored: {
      id,
      flightNumber: norm.display,
      date,
      filename,
      points: parsed.points,
      createdAt: now,
    },
    warnings: parsed.warnings,
  };
}

export function findImports(db: DatabaseSync, flightNumber: string, date: string): StoredImport[] {
  const norm = normalizeFlightNumber(flightNumber);
  const rows = db
    .prepare("SELECT * FROM imports WHERE flight_number = ? AND flight_date = ? ORDER BY created_at DESC")
    .all(norm.display, date) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    flightNumber: String(r.flight_number),
    date: String(r.flight_date),
    filename: String(r.filename),
    points: JSON.parse(String(r.track_json)) as TrackPoint[],
    createdAt: String(r.created_at),
  }));
}

export function listImports(db: DatabaseSync): Omit<StoredImport, "points">[] {
  const rows = db.prepare(
    "SELECT id, flight_number, flight_date, filename, created_at, json_array_length(track_json) AS n FROM imports ORDER BY created_at DESC",
  ).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    flightNumber: String(r.flight_number),
    date: String(r.flight_date),
    filename: String(r.filename),
    createdAt: String(r.created_at),
  }));
}

export function deleteImport(db: DatabaseSync, id: string): boolean {
  const res = db.prepare("DELETE FROM imports WHERE id = ?").run(id);
  return (res.changes as number) > 0;
}

// ---------------------------------------------------------------------------
// Lookup builders
// ---------------------------------------------------------------------------

function baseLookup(over: Partial<FlightLookupResult> & { flightNumber: string; date: string; provider: string }): FlightLookupResult {
  const merged = {
    flightId: over.flightId ?? `${over.provider}-${over.flightNumber}-${over.date}`,
    state: "ok" as ProviderState,
    origin: fld(null, "unavailable"),
    destination: fld(null, "unavailable"),
    airline: fld(null, "unavailable"),
    scheduledDeparture: fld(null, "unavailable"),
    scheduledArrival: fld(null, "unavailable"),
    actualDeparture: fld(null, "unavailable"),
    actualArrival: fld(null, "unavailable"),
    actualRunwayDeparture: fld(null, "unavailable"),
    actualRunwayArrival: fld(null, "unavailable"),
    aircraftType: fld(null, "unavailable"),
    registration: fld(null, "unavailable"),
    filedRoute: fld(null, "unavailable"),
    filedCruiseAltitudeFt: fld(null, "unavailable"),
    recordedTrack: fld(null, "unavailable"),
    ...over,
  };
  const unavailableFields: string[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v && typeof v === "object" && "value" in (v as object) && (v as { value: unknown }).value === null) {
      unavailableFields.push(k);
    }
  }
  return { ...merged, unavailableFields, warnings: over.warnings ?? [], retrievedAt: new Date().toISOString() };
}

function airportRef(nav: AirportNavData) {
  return {
    icao: nav.airport.icao,
    iata: nav.airport.iata,
    name: nav.airport.name,
    city: nav.airport.city,
    country: nav.airport.country,
    position: nav.airport.position,
  };
}

/**
 * Cruise altitude honestly derived from a track: the maximum recorded
 * altitude. Provenance "inferred" with the rule in the note — never claimed
 * to be the filed cruise altitude. Returns null when the track has no usable
 * altitudes, in which case PLN export will honestly refuse.
 */
function cruiseFromTrack(points: TrackPoint[], sourceLabel: string) {
  const alts = points.map((p) => p.altitudeFt).filter((a): a is number => a != null && a > 0);
  if (alts.length === 0) return fld(null, "unavailable");
  return fld(
    Math.max(...alts),
    "inferred",
    sourceLabel,
    "Maximum recorded altitude from the track — not the filed cruise altitude.",
  );
}

const ADSBAERO_LABEL = "adsb.aero (free)";

async function tryAdsbAero(
  navdb: { getAirport(icao: string): Promise<AirportNavData | null> },
  req: HistoryRequest,
  attempts: HistoricalSourceAttempt[],
  options: HistoryOption[],
): Promise<void> {
  const label = ADSBAERO_LABEL;
  const norm = normalizeFlightNumber(req.flightNumber);
  const originIcao = req.origin?.trim().toUpperCase();
  const destIcao = req.destination?.trim().toUpperCase();
  const originNav = originIcao ? await navdb.getAirport(originIcao) : null;
  const destNav = destIcao ? await navdb.getAirport(destIcao) : null;
  if (!originNav || !destNav) {
    attempts.push({
      source: "adsbaero",
      label,
      found: false,
      trackKind: "unavailable",
      detail: `Origin and destination with navigation data are required (${!originNav ? (req.origin ?? "?") : ""}${!originNav && !destNav ? " / " : ""}${!destNav ? (req.destination ?? "?") : ""}).`,
    });
    return;
  }
  const provider = new AdsbAeroProvider();
  let found;
  try {
    found = await provider.findFlight(req.flightNumber, req.date, originIcao, destIcao);
  } catch (e) {
    const err = e as FlightLookupError;
    const detail =
      err.state === "empty"
        ? err.message
        : err.state === "rate_limited"
          ? "adsb.aero rate limit reached — try again later (results are cached 24 h)."
          : `adsb.aero lookup failed (${err.state ?? "network_error"}).`;
    attempts.push({ source: "adsbaero", label, found: false, trackKind: "unavailable", detail });
    return;
  }
  const { flight } = found;
  let trajectory;
  try {
    trajectory = (await provider.getFlight(flight.flightId)).trajectory;
  } catch (e) {
    const err = e as FlightLookupError;
    attempts.push({
      source: "adsbaero",
      label,
      found: false,
      trackKind: "unavailable",
      detail: `Flight ${flight.flightId} verified, but its trajectory could not be retrieved (${err.state ?? "network_error"}).`,
    });
    return;
  }
  const points = trajectory.points;
  const trackKind: TrackKind = points.length >= 2 ? "verified" : "unavailable";
  const gapNotes = trajectory.gaps.map(formatGap);
  const segNote =
    trajectory.segments.length > 1
      ? `Track has ${trajectory.segments.length} contiguous segments (${trajectory.segments.join("+")} positions) with ${trajectory.gaps.length} coverage gap(s) — the map shows the break; nothing was interpolated.`
      : "Continuous ADS-B coverage for the whole flight.";
  const lookup = baseLookup({
    flightNumber: norm.display,
    date: req.date,
    provider: "adsbaero",
    flightId: `adsbaero-${flight.flightId}`,
    identIcao: norm.icaoIdent,
    origin: fld(
      airportRef(originNav),
      "inferred",
      label,
      flight.startAirportIdent === originIcao ? `Provider confirms departure airport ${originIcao}.` : "Airport from your input; provider did not identify it.",
    ),
    destination: fld(
      airportRef(destNav),
      "inferred",
      label,
      flight.endAirportIdent === destIcao ? `Provider confirms arrival airport ${destIcao}.` : "Airport from your input; provider did not identify it.",
    ),
    actualDeparture: fld(flight.startTs, "verified", label, "First observed ADS-B position — approximate wheels-up."),
    actualArrival: fld(flight.endTs, "verified", label, "Last observed ADS-B position — approximate touchdown."),
    aircraftType: fld(flight.icaoType, "verified", label, flight.model ? `Model: ${flight.model}.` : undefined),
    registration: fld(flight.registration, "verified", label),
    recordedTrack: fld(points.length >= 2 ? points : null, "verified", label, segNote),
    filedCruiseAltitudeFt: cruiseFromTrack(points, label),
    warnings: [...found.verifiedReasons, ...gapNotes, "Runways and filed route are not provided by adsb.aero."],
  });
  const planFixes =
    points.length >= 2
      ? trackToFixes(
          points,
          originIcao as string,
          destNav.airport.icao,
          "Derived from verified adsb.aero ADS-B track — coordinates are real; fix names are synthetic.",
        )
      : [];
  attempts.push({
    source: "adsbaero",
    label,
    found: true,
    trackKind,
    detail:
      points.length >= 2
        ? `Verified ADS-B track: ${flight.callsign}${flight.registration ? ` (${flight.registration})` : ""}, ${points.length} positions` +
          (trajectory.gaps.length > 0 ? `, ${trajectory.gaps.length} oceanic coverage gap(s).` : ", continuous coverage.")
        : "Flight verified, but the trajectory has fewer than 2 usable positions.",
  });
  options.push({
    source: "adsbaero",
    label,
    trackKind,
    detail: `Verified ADS-B track (${flight.callsign}${flight.registration ? `, ${flight.registration}` : ""}).`,
    lookup,
    track: points,
    planFixes,
    planWarnings: [
      "Filed route unknown — plan follows the recorded ADS-B track via synthetic TRK waypoints (coordinates are real).",
      ...gapNotes,
    ],
  });
}

async function tryFlightAware(
  flightNumber: string,
  date: string,
  attempts: HistoricalSourceAttempt[],
  options: HistoryOption[],
): Promise<void> {
  const key = getSetting("flightAwareApiKey");
  if (!key) {
    attempts.push({
      source: "flightaware",
      label: "FlightAware AeroAPI (paid)",
      found: false,
      trackKind: "unavailable",
      detail: "No API key configured — paid source skipped. Historical Replay works without it.",
    });
    return;
  }
  try {
    const provider = new FlightAwareProvider({ apiKey: key });
    const lookup = await provider.lookupFlight(flightNumber, date);
    if (lookup.state !== "ok") throw new Error(`state ${lookup.state}`);
    attempts.push({
      source: "flightaware",
      label: "FlightAware AeroAPI (paid)",
      found: true,
      trackKind: lookup.recordedTrack.value ? "verified" : "unavailable",
      detail: "Verified provider data: filed route, recorded track and runways where reported.",
    });
    options.push({
      source: "flightaware",
      label: "FlightAware AeroAPI (paid)",
      trackKind: lookup.recordedTrack.value ? "verified" : "unavailable",
      detail: "Verified provider data.",
      lookup,
      track: lookup.recordedTrack.value ?? [],
      planFixes: [],
      planWarnings: [],
    });
  } catch (e) {
    const state = (e as FlightLookupError)?.state ?? "network_error";
    attempts.push({
      source: "flightaware",
      label: "FlightAware AeroAPI (paid)",
      found: false,
      trackKind: "unavailable",
      detail: `FlightAware lookup failed (${state}).`,
    });
  }
}

async function tryOpenSky(
  db: DatabaseSync,
  navdb: { getAirport(icao: string): Promise<AirportNavData | null> },
  req: HistoryRequest,
  attempts: HistoricalSourceAttempt[],
  options: HistoryOption[],
): Promise<void> {
  const label = "OpenSky Network (free)";
  const originIcao = req.origin?.trim().toUpperCase();
  if (!originIcao) {
    attempts.push({
      source: "opensky",
      label,
      found: false,
      trackKind: "unavailable",
      detail: "Origin airport is required for the free OpenSky lookup — enter it above.",
    });
    return;
  }
  const originNav = await navdb.getAirport(originIcao);
  if (!originNav) {
    attempts.push({
      source: "opensky",
      label,
      found: false,
      trackKind: "unavailable",
      detail: `No navigation data for ${originIcao} — planning needs airport coordinates.`,
    });
    return;
  }
  const provider = new OpenSkyProvider({
    clientId: req.openskyClientId || getSetting("openskyClientId") || undefined,
    clientSecret: req.openskyClientSecret || getSetting("openskyClientSecret") || undefined,
  });
  let found;
  try {
    found = await provider.findFlight(req.flightNumber, req.date, originIcao);
  } catch (e) {
    const state = (e as FlightLookupError)?.state ?? "network_error";
    const detail =
      state === "unauthorized"
        ? "OpenSky historical data needs a free OpenSky API client — add it in Settings (no payment; anonymous requests are rejected)."
        : state === "rate_limited"
          ? "OpenSky rate limit reached. Results are cached 24 h — try again tomorrow or check your quota."
          : state === "empty"
            ? `No matching departure at ${originIcao} in the search window.`
            : `OpenSky lookup failed (${state}).`;
    attempts.push({ source: "opensky", label, found: false, trackKind: "unavailable", detail });
    return;
  }
  const { flight } = found;
  const destIcao = flight.estArrivalAirport ?? req.destination?.trim().toUpperCase() ?? null;
  const destNav = destIcao ? await navdb.getAirport(destIcao) : null;
  if (!destNav) {
    attempts.push({
      source: "opensky",
      label,
      found: false,
      trackKind: "unavailable",
      detail: `Flight found, but destination ${destIcao ?? "(unknown)"} has no navigation data — cannot plan.`,
    });
    return;
  }
  const originAgree = flight.estDepartureAirport === originIcao;
  const track = await provider.getTrack(flight.icao24 as string, flight.firstSeen as number);
  const points = track.points;
  const trackKind: TrackKind = points.length > 0 ? "verified" : "unavailable";
  const lookup = baseLookup({
    flightNumber: normalizeFlightNumber(req.flightNumber).display,
    date: req.date,
    provider: "opensky",
    flightId: `opensky-${flight.icao24}-${flight.firstSeen}`,
    identIcao: normalizeFlightNumber(req.flightNumber).icaoIdent,
    origin: fld(airportRef(originNav), "inferred", SOURCE_LABEL, originAgree ? "Matches OpenSky's estimated departure airport." : `User-provided; OpenSky estimated ${flight.estDepartureAirport ?? "unknown"}.`),
    destination: fld(
      airportRef(destNav),
      "inferred",
      SOURCE_LABEL,
      flight.estArrivalAirport ? `OpenSky's estimated arrival airport (${flight.estArrivalAirport}).` : "User-provided destination.",
    ),
    actualDeparture: fld(
      flight.firstSeen ? new Date(flight.firstSeen * 1000).toISOString() : null,
      "verified",
      SOURCE_LABEL,
      "First ADS-B sighting — approximate wheels-up.",
    ),
    actualArrival: fld(
      flight.lastSeen ? new Date(flight.lastSeen * 1000).toISOString() : null,
      "verified",
      SOURCE_LABEL,
      "Last ADS-B sighting — approximate touchdown.",
    ),
    recordedTrack: fld(points.length > 0 ? points : null, "verified", SOURCE_LABEL, track.note),
    filedCruiseAltitudeFt: cruiseFromTrack(points, SOURCE_LABEL),
    warnings: [
      `OpenSky flight ${flight.callsign?.trim() ?? ""} (${flight.icao24})${found.candidates > 1 ? ` — ${found.candidates} matching departures in window, closest to ${req.date} chosen` : ""}.`.trim(),
      "Runways, aircraft type and filed route are not provided by OpenSky.",
    ],
  });
  const planFixes =
    points.length >= 2
      ? trackToFixes(
          points,
          originIcao,
          destNav.airport.icao,
          "Derived from verified OpenSky ADS-B track — coordinates are real; fix names are synthetic.",
        )
      : [];
  attempts.push({
    source: "opensky",
    label,
    found: true,
    trackKind,
    detail:
      points.length > 0
        ? `Verified ADS-B track (${points.length} positions).`
        : "Flight found, but no track — the OpenSky tracks endpoint only covers the last 30 days.",
  });
  options.push({
    source: "opensky",
    label,
    trackKind,
    detail: points.length > 0 ? "Verified ADS-B track." : "Flight times/airports verified; no track available.",
    lookup,
    track: points,
    planFixes,
    planWarnings:
      points.length >= 2
        ? [
            "Filed route unknown — plan follows the recorded ADS-B track via synthetic TRK waypoints (coordinates are real).",
            track.note,
          ]
        : ["No recorded track available for this flight (older than 30 days). Plan has origin/destination only."],
  });
  void db;
}

const SOURCE_LABEL = "OpenSky Network";

function tryImports(
  db: DatabaseSync,
  navdb: { getAirport(icao: string): Promise<AirportNavData | null> },
  req: HistoryRequest,
  attempts: HistoricalSourceAttempt[],
  options: HistoryOption[],
): Promise<void> {
  const label = "Imported file";
  const run = async () => {
    const imports = findImports(db, req.flightNumber, req.date);
    if (imports.length === 0) {
      attempts.push({
        source: "import",
        label,
        found: false,
        trackKind: "unavailable",
        detail: "No imported track files for this flight and date. Upload a CSV/GPX/KML below.",
      });
      return;
    }
    for (const imp of imports) {
      if (imp.points.length < 2) continue;
      const originIcao = req.origin?.trim().toUpperCase();
      const destIcao = req.destination?.trim().toUpperCase();
      const originNav = originIcao ? await navdb.getAirport(originIcao) : null;
      const destNav = destIcao ? await navdb.getAirport(destIcao) : null;
      if (!originNav || !destNav) {
        attempts.push({
          source: "import",
          label,
          found: false,
          trackKind: "unavailable",
          detail: `File "${imp.filename}" found, but origin/destination with navigation data are required to plan.`,
        });
        continue;
      }
      const lookup = baseLookup({
        flightNumber: imp.flightNumber,
        date: imp.date,
        provider: "import",
        flightId: `import-${imp.id}`,
        origin: fld(airportRef(originNav), "inferred", `Imported file: ${imp.filename}`, "Airport from user input."),
        destination: fld(airportRef(destNav), "inferred", `Imported file: ${imp.filename}`, "Airport from user input."),
        actualDeparture: fld(imp.points[0]?.timestamp ?? null, "imported", `Imported file: ${imp.filename}`),
        actualArrival: fld(imp.points[imp.points.length - 1]?.timestamp ?? null, "imported", `Imported file: ${imp.filename}`),
        recordedTrack: fld(imp.points, "imported", `Imported file: ${imp.filename}`, "User-supplied track — taken as-is, not independently verified."),
        filedCruiseAltitudeFt: cruiseFromTrack(imp.points, `Imported file: ${imp.filename}`),
        warnings: ["Imported track: times, altitudes and positions are exactly as in the file."],
      });
      const planFixes = trackToFixes(
        imp.points,
        originIcao as string,
        destNav.airport.icao,
        `Derived from imported file "${imp.filename}" — coordinates as supplied; fix names are synthetic.`,
      );
      attempts.push({
        source: "import",
        label,
        found: true,
        trackKind: "imported",
        detail: `Imported file "${imp.filename}" (${imp.points.length} positions).`,
      });
      options.push({
        source: "import",
        label,
        trackKind: "imported",
        detail: `Imported file "${imp.filename}".`,
        lookup,
        track: imp.points,
        planFixes,
        planWarnings: [
          "Filed route unknown — plan follows the imported track via synthetic TRK waypoints.",
          "Imported data is taken as-is and was not independently verified.",
        ],
      });
    }
  };
  return run();
}

async function tryReconstruction(
  navdb: { getAirport(icao: string): Promise<AirportNavData | null> },
  req: HistoryRequest,
  attempts: HistoricalSourceAttempt[],
  options: HistoryOption[],
): Promise<void> {
  const label = "Reconstructed reference";
  if (!req.allowReconstruction) {
    attempts.push({
      source: "reconstruction",
      label,
      found: false,
      trackKind: "unavailable",
      detail: "Opt-in only — reconstruct a clearly-labelled great-circle reference route when nothing else exists.",
    });
    return;
  }
  const originIcao = req.origin?.trim().toUpperCase();
  const destIcao = req.destination?.trim().toUpperCase();
  if (!originIcao || !destIcao) {
    attempts.push({
      source: "reconstruction",
      label,
      found: false,
      trackKind: "unavailable",
      detail: "Origin and destination are required to reconstruct a reference route.",
    });
    return;
  }
  const originNav = await navdb.getAirport(originIcao);
  const destNav = await navdb.getAirport(destIcao);
  if (!originNav || !destNav) {
    attempts.push({
      source: "reconstruction",
      label,
      found: false,
      trackKind: "unavailable",
      detail: "Both airports need navigation data for reconstruction.",
    });
    return;
  }
  const route = reconstructReferenceRoute(
    { icao: originIcao, lat: originNav.airport.position.lat, lon: originNav.airport.position.lon },
    { icao: destIcao, lat: destNav.airport.position.lat, lon: destNav.airport.position.lon },
  );
  const lookup = baseLookup({
    flightNumber: normalizeFlightNumber(req.flightNumber).display,
    date: req.date,
    provider: "reconstruction",
    flightId: `reconstruction-${originIcao}-${destIcao}-${req.date}`,
    origin: fld(airportRef(originNav), "verified", "navdata", "Airport position from navdata."),
    destination: fld(airportRef(destNav), "verified", "navdata", "Airport position from navdata."),
    filedRoute: fld(route.fixes, "generated", "FlightDeck reconstruction", "Great-circle reference — not the actual flown route."),
    warnings: route.warnings,
  });
  attempts.push({
    source: "reconstruction",
    label,
    found: true,
    trackKind: "reconstructed",
    detail: `Great-circle reference route (${route.distanceNm} nm, ${route.fixes.length} fixes) — NOT the actual flown route.`,
  });
  options.push({
    source: "reconstruction",
    label,
    trackKind: "reconstructed",
    detail: "Great-circle reference — not the actual flown route.",
    lookup,
    track: [],
    planFixes: [],
    planWarnings: route.warnings,
  });
}

/** Run the full source hierarchy. Never throws for "not found" — reports attempts. */
export async function findHistorical(
  db: DatabaseSync,
  navdb: { getAirport(icao: string): Promise<AirportNavData | null> },
  req: HistoryRequest,
): Promise<HistoryResponse> {
  const attempts: HistoricalSourceAttempt[] = [];
  const options: HistoryOption[] = [];
  normalizeFlightNumber(req.flightNumber); // throws on invalid format — a real error
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.date)) throw new Error("date must be YYYY-MM-DD.");
  await tryAdsbAero(navdb, req, attempts, options);
  await tryImports(db, navdb, req, attempts, options);
  await tryOpenSky(db, navdb, req, attempts, options);
  await tryFlightAware(req.flightNumber, req.date, attempts, options);
  await tryReconstruction(navdb, req, attempts, options);
  return { attempts, options };
}
