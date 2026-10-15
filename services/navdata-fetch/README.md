# Sim navdata fetch

Reads the simulator's **own** SID/STAR/approach data over SimConnect and hands
it to FlightDeck's planning API — so plans auto-select real procedures and the
EFB loads them pre-selected. No SDK, no .NET, no compilation: it's a plain
Node script speaking the SimConnect protocol (via `node-simconnect`), running
on the same Node runtime FlightDeck already ships.

## Automatic (recommended)

Just plan a flight with the sim running and connected (Live Telemetry shows
connected). If FlightDeck has no cached procedures for the origin/destination,
it spawns this fetch itself and tells you to replan once the data lands
(~10–30s per airport). Cached results live in the API's SQLite store, tagged
`SIM-YYYYMMDD`.

## Manual

From the installed app (or the repo), with MSFS running (main menu is fine):

```powershell
node .\resources\navdata-fetch\fetch-procedures.mjs KJFK,EIDW `
    --api-url http://localhost:8124/api/navdata/procedures
```

Exit 0 = all airports stored, 2 = one or more failed (see stderr), 1 = the
sim isn't reachable.

## What it fetches per airport

- Runways (both ends + ILS idents)
- Departures (SIDs): names, runway transitions, enroute transitions
- Arrivals (STARs): same
- Approaches: type (ILS/RNAV/VOR/NDB), runway, transitions

Names are the sim's own nav data — default or Navigraph, whatever the sim
(and therefore the EFB) is using — never invented. Approach types with no EFB
mapping (localizer, SDF, LDA…) are skipped rather than guessed.

## Honesty notes

- Facility data carries no AIRAC cycle, so cached entries are tagged with the
  fetch date. Re-fetch after a sim/navdata update.
- A few airports are reported to crash the *simulator* on facility requests
  (ESGF, ZLXY, ZSQD, KLMS, KOSX, M44 on the forums). KJFK/EIDW are not among
  them; if a fetch ever crashes your sim, tell us the airport and we'll add it
  to a skip list.
- The parser (`parse-facility.mjs`) rejects truncated or insane payloads
  instead of returning half-parsed procedures — see `tests/unit/navdata-fetch.test.ts`.
