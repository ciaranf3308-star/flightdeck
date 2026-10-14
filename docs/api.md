# FlightDeck Planning API

Base URL: `http://localhost:8124` (override with `FLIGHTDECK_PORT`).
All request/response bodies are JSON and validate against `@flightdeck/shared-models`.

## Endpoints

### `GET /api/health`
`{ ok, service, navdataCycle }`

### `GET /api/settings`
Public settings. Secrets are never returned: `{ provider, simbriefUser, navdataCycle, openskyClientId, flightAwareKeyConfigured: "yes" | null, openskySecretConfigured: "yes" | null }`.

### `PUT /api/settings`
`{ provider?: "auto"|"flightaware"|"fixtures", flightAwareApiKey?: string, openskyClientId?: string, openskyClientSecret?: string, simbriefUser?: string }`
→ public settings. Secrets are stored in the local SQLite DB only. The FlightAware key is a strictly optional paid add-on; the OpenSky client is free (no payment) and enables the free historical source.

### `POST /api/lookup`
`{ flightNumber: "EI106", date: "2026-10-09", provider?: "flightaware"|"fixtures" }`
→ `FlightLookupResult`. Every field carries provenance; unavailable fields are listed in `unavailableFields`. Successful lookups are cached 24h.

### `POST /api/plan`
`{ flightNumber, date, mode: "historical"|"current", provider?, aircraftProfileId?, windOrigin?: {directionDeg, speedKt, source?}, windDestination? }`
→ `{ lookup: FlightLookupResult, plan: FlightPlan }`. 422 when the lookup failed or navdata is missing for the airport pair.

Historical Replay may instead supply a validated lookup from `/api/history`:
`{ mode: "historical", lookup: FlightLookupResult, planFixes?: RouteFix[], planWarnings?: string[], cruiseAltitudeFt?: number, aircraftProfileId? }`.
`planFixes` overrides the filed route (used for track-derived or reconstructed fixes; an empty array means "no override").
`cruiseAltitudeFt` is a manual user entry, recorded in the plan warnings.

### `POST /api/history`
Provider-independent historical lookup — paid FlightAware is strictly optional.
`{ flightNumber, date, origin?, destination?, allowReconstruction?: false }`
→ `{ attempts: HistoricalSourceAttempt[], options: HistoryOption[] }`.
Sources are tried in order: adsb.aero (free, no key — verified ADS-B trajectories from the
adsb.aero archive; coverage checked first via /api/v1/data-range; identity verified by exact
callsign + date + airport agreement; oceanic coverage gaps reported, never interpolated),
user imports (CSV/GPX/KML matched by flight+date), OpenSky Network (free account, needs origin),
FlightAware (only with a configured key — skipped with an explanatory note otherwise),
reconstruction (opt-in only: great-circle reference, every fix `generated`, never the actual flown route).
Each option carries a full `FlightLookupResult` plus `planFixes`/`planWarnings` for `/api/plan`,
a `trackKind` (`verified`|`imported`|`reconstructed`|`unavailable`) and a human `detail` line.
"Not found" is reported via `attempts`, never as an error. Results cached 24h; the cache is
invalidated when imports are added or removed.

### `POST /api/imports`
`{ flightNumber, date, filename, content }` — parse and store a user track file (CSV/GPX/KML, ≤10 MB).
→ `201 { import: { id, flightNumber, date, filename, pointCount, createdAt }, warnings[] }`.
400 with a clear reason on unparseable input. Provenance is always `imported`.

### `GET /api/imports`
`{ imports: [{ id, flightNumber, date, filename, createdAt }] }` — no point data, just the catalog.

### `DELETE /api/imports/:id`
Removes an import (and invalidates the history cache).

### `POST /api/plan/override`
`{ plan, slot: "sid"|"star"|"approach"|"departureRunway"|"arrivalRunway", airportIcao, procedureId?, runwayId? }`
→ `{ plan }` with the override applied and re-validated.

### `GET /api/aircraft`
`{ profiles: AircraftProfile[] }` — iniBuilds A330-300, Fenix A320, PMDG 737-800, Asobo A320neo.

### `GET /api/navdata/:icao`
`AirportNavData` or 404. Currently serves the fixture KJFK/EIDW dataset.

### `POST /api/simbrief`
`{ user?: "username-or-pilot-id" }` (falls back to settings)
→ `{ found: true, ofp: SimBriefOfpSummary }` | `{ found: false, message }`. Read-only Stage 1 import.

### `POST /api/export`
`{ plan, title?, description? }` → `MsfsExportResult { xml, format, includedFixes, excludedFixes[], warnings[] }`.
Throws 500 (refuses) when cruise altitude is unknown — never invents one.

### `POST /api/flyable`
`{ lookup: FlightLookupResult }` — builds a navigable IFR reference route from the lookup's
recorded track. The track itself stays a historical reference; this returns separate plan
fixes: origin/destination (verified), track-sampled `TRKxx` fixes (inferred, real coordinates),
and generated great-circle `OCNxx` waypoints bridging coverage gaps (provenance `generated`,
never the actual flown route). → `{ fixes, warnings, gaps, stats }`. 422 when the lookup
has no usable recorded track.

### `POST /api/import-pln`
`{ xml }` → parsed EFB PLN summary (validates structure, flags legacy AppVersion).

### `POST /api/telemetry`
Ingest from the SimConnect bridge: `{ lat, lon, altitudeFt, groundspeedKt, headingDeg, verticalSpeedFpm, onGround, autopilotMaster }`. Partial samples accepted.

### `GET /api/telemetry/latest`
`{ connected: bool, sample }` — `connected: false` when no sample within 5s.

## Provider selection

`auto` (default): FlightAware when a key is configured, otherwise offline fixtures.
`fixtures` always works — no network, no key.

## Caching

Successful lookups are cached in SQLite for 24h (`lookup_cache`). FlightAware's terms permit caching where the tier allows; historical data requires Standard tier+.
