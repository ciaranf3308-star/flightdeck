# FlightDeck Architecture

## Data flow

```
┌─────────────┐   ┌──────────────────┐   ┌──────────────┐
│ FlightAware │   │ SimBrief         │   │ Fixtures     │
│ AeroAPI v4  │   │ xml.fetcher.php  │   │ (snapshots)  │
└──────┬──────┘   └────────┬─────────┘   └──────┬───────┘
       │                   │                    │
       └───────────┬───────┴────────────────────┘
                   ▼
        packages/flight-providers ──► FlightLookupResult (provenance on every field)
                   │
                   ▼
        packages/route-engine ◄── packages/navigation (AirportNavData)
                   │                    ▲
                   │              packages/aircraft-adapters
                   ▼
               FlightPlan ──► packages/msfs-export ──► EFB .pln XML
                   │
                   ▼
        services/planning-api (node:http + node:sqlite)
                   ▲ polling                ▲ POST
                   │ /api/telemetry/latest  │ /api/telemetry
        apps/desktop (React/Leaflet)   services/simconnect-bridge (C#)
```

## Key design decisions

1. **Provenance is structural, not cosmetic.** `Field<T>` in shared-models forces every
   boundary value to declare `verified | inferred | generated | unavailable`. The Zod
   refinements make `unavailable` ⇔ `null` a type-level invariant.

2. **The engine never sees raw provider JSON.** It consumes `FlightLookupResult` +
   `AirportNavData` + `AircraftProfile` — so swapping fixture navdata for a real AIRAC
   cycle changes nothing upstream.

3. **Confidence is a fraction with receipts.** `score = for / (for+against+missing)`,
   always rendered alongside the evidence lists. There is no hidden weighting.

4. **The exporter is a filter, not a formatter.** It *removes* what can't be honestly
   emitted (coordinate-less fixes, synthetic procedure names) and reports each removal.

5. **Local-first.** SQLite holds settings + 24h lookup cache. No account, no cloud,
   no telemetry exfiltration. The FlightAware key only ever goes to FlightAware.

## What "verified" means per source

- FlightAware adapter: value present in the AeroAPI response.
- Fixtures provider: value present in the labelled snapshot.
- Route engine outputs: derived by a named deterministic rule → `inferred`.
- Navdata fixture: `generated` (synthetic, labelled in every file).
- Aircraft profiles: `generated` (reference compilation, verify against addon docs).
