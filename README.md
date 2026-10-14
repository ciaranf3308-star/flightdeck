# FlightDeck

A local-first **Microsoft Flight Simulator 2024 companion** for commercial IFR flight planning.
Enter a flight number and date — FlightDeck looks up the real flight, plans a valid route with
runway/SID/STAR/approach recommendations, shows it on a map, and exports a genuine
**MSFS 2024 EFB flight plan (.pln)**.

> **Honesty is a feature.** Every aviation fact carries provenance —
> `verified`, `inferred`, `generated`, or `unavailable`. Missing data is labelled
> missing. The app will never invent an ILS frequency, a waypoint coordinate, or a
> procedure to fill a gap.

## Quick start

Prerequisites: Node.js 22+.

```bash
cd flightdeck
npm install
npm run build          # build all packages

# Terminal 1 — planning API (http://localhost:8124)
npm run dev:api

# Terminal 2 — desktop UI (http://localhost:5173)
npm run dev:desktop
```

Open http://localhost:5173, enter **EI106**, date **2026-10-09**, and click **Look up & plan**.
No API keys are needed for the bundled offline fixture (a real FlightAware snapshot).

## The reference flight

**Aer Lingus EI106, 9 October 2026** — the primary example, resolved from real data:

| Field | Value | Provenance |
|---|---|---|
| Origin → Destination | KJFK → EIDW | verified (FlightAware) |
| Aircraft | A333, EI-EAV | verified |
| Actual runways | 31L → 28L | verified |
| Filed route | KJFK MERIT HFD PUT WITCH ALLEX N503B ALLRY NATX MALOT NATX GISTI OSGAR OSGAR4L EIDW | verified (names); oceanic fixes have no provider coordinates — shown by name only |
| Recorded track | 389 positions | verified |
| Cruise | 35,000 ft | inferred (provider reported FL350) |

The snapshot lives in `tests/fixtures/ei106-2026-10-09/` (retrieved 2026-10-13).

## Layout

```
/apps/desktop            React + Vite + Leaflet UI (Tauri shell in src-tauri/)
/services/planning-api   Node.js planning service (node:http + node:sqlite)
/services/simconnect-bridge  C# SimConnect telemetry bridge (Windows-only)
/packages/shared-models  Zod contracts + provenance system
/packages/flight-providers  Provider abstraction, FlightAware AeroAPI adapter,
                             fixtures provider, SimBrief OFP import
/packages/navigation    Navdata access (fixture KJFK/EIDW dataset)
/packages/route-engine   Deterministic runway/SID/STAR/approach selection
/packages/msfs-export    MSFS 2024 EFB PLN XML serialize + parse
/packages/aircraft-adapters  Aircraft profiles (iniBuilds A330-300, …)
/tests/fixtures          Labelled snapshots + synthetic fixtures
/tests/unit              Vitest suite (42 tests)
/docs                    Architecture, API, SimConnect setup, research notes
/research                Official API/SDK verification (AeroAPI, SimBrief, EFB PLN)
```

## Feature status

| Feature | Status |
|---|---|
| A — Flight lookup (FlightAware adapter, fixtures, honest states) | ✅ Working |
| B — SimBrief OFP import (read-only, documented fetch) | ✅ Working |
| B — SimBrief plan *generation* | ❌ Needs SimBrief developer API key + interactive login (documented) |
| C — Route/procedure engine (deterministic, evidence confidence) | ✅ Working |
| D — MSFS 2024 EFB PLN export/import | ✅ Working (spec-verified; round-trip in sim pending) |
| Live telemetry assist | 🟡 API + UI ready; bridge needs Windows + MSFS 2024 |
| Tauri desktop packaging | 🟡 Scaffolded; needs Rust toolchain on Windows |
| Library home page (save flights, categories, recent lookups) | ✅ Working |

See `docs/capability-matrix.md` for the full honest accounting.

## Testing

```bash
npm test            # vitest, 48 tests
```

Tests encode the honesty invariants: coordinate-less fixes are excluded from PLN
output (never guessed), unknown procedures fail validation (never invented),
confidence is evidence-derived (never a made-up percentage).

## API keys

Configure in the app under **Settings** (stored in the local SQLite database only).
Nothing here is required — the full planning, MSFS export and guidance workflow runs without any key.

- **adsb.aero** — the primary Historical Replay source. **Free, no account, no key.**
  Verified ADS-B trajectories; identity verified (exact callsign + date + airport
  agreement), oceanic coverage gaps reported rather than interpolated.
- **OpenSky API client (free, no payment)** — secondary free Historical Replay source:
  verified ADS-B flights and tracks. Create a free account at opensky-network.org, add an API client,
  and paste the client ID + secret. (Anonymous requests are rejected by OpenSky for historical data.)
- **FlightAware AeroAPI key — optional paid add-on** — when configured, FlightAware is tried after the
  free sources for Historical Replay. Historical data needs a Standard-tier key or higher (Personal tier has no historical data).
- **SimBrief username / Pilot ID** — enables OFP import.

Without keys, the app runs fully offline on bundled fixtures, your imported track files (CSV/GPX/KML),
and explicitly labelled reconstructed reference routes.

## Windows packaging

- **Tauri**: `apps/desktop/src-tauri/` — needs Rust stable on Windows.
- **SimConnect bridge**: `services/simconnect-bridge/` — needs .NET 8 SDK on Windows.
- See `docs/simconnect.md` and `apps/desktop/src-tauri/README.md`.
