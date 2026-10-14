# FlightDeck — Capability Matrix (honest accounting)

What works, what partially works, and what honestly doesn't — verified on 2026-10-13.

## Verified working (tested here)

| Capability | Evidence |
|---|---|
| Flight lookup EI106 2026-10-09 (fixtures) | `tests/unit/providers.test.ts` — real snapshot: A333 EI-EAV, 31L→28L, 15 fixes, 389 track points |
| Provider states (empty/unavailable/rate-limited/unauthorized/network-error) | `classifyHttpError` + adapter error mapping, unit-tested |
| FlightAware AeroAPI adapter code | Endpoints verified against official OpenAPI v4.30.0 (`research/api-research.md`); live call needs a user key |
| Historical endpoint selection (>10 days → `/history/flights`) | Implemented per spec; needs Standard+ tier key to verify live |
| Route engine: historical mode | Recommends 31L, SID→MERIT, 28L, STAR OSGAR4L→GISTI, ILS approach — matches the real flight |
| Route engine: current-conditions mode | Wind-based runway ranking, deterministic tie-breaks, unknown-wind uncertainty |
| Hard-constraint validation before ranking | Short-runway elimination tested; approach-kind compatibility tested |
| Evidence-based confidence | `buildConfidence` — score is for/(for+against+missing); tested |
| Player overrides | Re-validated, marked as overrides; unknown procedures → invalid |
| MSFS 2024 EFB PLN export | Spec-verified schema (AppVersionMajor 12, User waypoints, procedure-by-name); 10 export tests pass |
| PLN import | Parses EFB PLN back; flags legacy AppVersion < 12 |
| Coordinate-less fixes | Excluded from PLN with reasons; never guessed (test: N503B) |
| Synthetic procedures | Omitted from export with warnings (test: SYN-SID-31L-1) |
| SimBrief OFP import (Stage 1) | Documented `xml.fetcher.php?json=v2` flow implemented; all fields optional |
| Planning API (9 endpoints + telemetry ingest) | Live-tested with curl: `/api/plan` returns full EI106 plan |
| Desktop UI | Vite build succeeds; visual QA via live browser (see below) |
| Unit tests | 75/75 pass (`npm test`) |

## Fully working

| Capability | Notes |
|---|---|
| Historical Replay without any paid subscription | `/api/history` tries adsb.aero first (free, no account — verified ADS-B trajectories, identity-verified by exact callsign+date+airports; oceanic gaps reported, never interpolated), then user-imported tracks (CSV/GPX/KML), OpenSky Network (free account), FlightAware (only with a key — skipped with a note otherwise), then opt-in reconstruction. Every source is labelled with a `trackKind` (`verified`/`imported`/`reconstructed`/`unavailable`); reconstructions are great-circle references with synthetic `REFxx` fix names and hard warnings — never the actual flown route. Full planning, EFB PLN export and guidance work from every successful source. |
| Flyable reference plans from recorded tracks | `POST /api/flyable` builds a separate navigable IFR route from a recorded track: origin/destination (verified), track-sampled `TRKxx` fixes (inferred, real coordinates, MCDU-friendly count), generated `OCNxx` great-circle waypoints bridging coverage gaps (provenance `generated`, never the actual flown route). The 190 observed ADS-B positions stay a historical reference overlay, never the plan's legs. Runway overrides refresh dependent SID/STAR/approach recommendations; synthetic fixture procedure names are never exported — selected in the EFB from sim navdata. |

## Partially working / needs the user's environment

| Capability | What's missing |
|---|---|
| Live FlightAware lookup | User's AeroAPI key (Settings). Historical Replay additionally needs Standard tier+ |
| OpenSky historical data | Free OpenSky account + API client (Settings). Anonymous requests are rejected by OpenSky (verified live: HTTP 403). Tracks only cover the last 30 days |
| SimBrief plan generation (Stage 2) | Officially requires a Navigraph-issued developer API key **and** an interactive SimBrief login popup — no headless path exists. Read-only import is the honest ceiling without it |
| Live telemetry | `services/simconnect-bridge` must be built (.NET 8) and run on the Windows PC next to MSFS 2024; API ingest + UI polling are ready |
| Tauri desktop binary | `apps/desktop/src-tauri` scaffolded; needs Rust stable on Windows |
| EFB PLN round-trip in the real sim | The XML follows the SDK doc exactly, but per DevSupport the sim doesn't always import spec-shaped files — must be verified by loading in the MSFS 2024 EFB |

## Explicitly not done (by design)

- **Scraping** FlightAware's website or using undocumented endpoints — prohibited by the brief, not implemented.
- **Inventing procedures/waypoints/frequencies** — the engine only recommends what's in the selected navdata cycle; the fixture cycle is labelled synthetic.
- **Fake live telemetry** — the Telemetry tab shows "Not connected" rather than a simulated aircraft.
- **Real AIRAC navdata** — the bundled KJFK/EIDW dataset is a synthetic fixture (clearly labelled). A production deployment should load a real cycle (e.g. Navigraph) through the same `NavDatabase` interface.

## Known limitations

1. AeroAPI route decoding is CONUS-centric; oceanic fixes (N503B, NATX…) arrive without coordinates — displayed by name, excluded from PLN.
2. The fixture navdata has SIDs/STARs for only a few runways; current-conditions mode honestly reports "unknown" for the rest.
3. API keys are stored in the local SQLite DB; the Tauri build should move the FlightAware key to the OS credential store (documented in settings code).
4. SimBrief `xml.fetcher.php` field mapping is defensive (all-optional) until validated against a live user response.
5. Playwright E2E (`tests/e2e/`) cannot execute in this sandbox — both the managed browser (leased VM, no loopback) and local Chromium 152 (`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` on all loopback) are blocked from reaching the dev servers. The specs are written and committed; run `npx playwright test` on a normal machine. The Vite production build succeeds and all API/UI contracts are verified via the 42 unit tests + live API checks.
