# PoC: iniBuilds A330 company-route (.fpl) loading — UNVERIFIED

Status (2026-10-14): the exporter (`src/company-route.ts`) and this generator
are a proof of concept. The .fpl format was reconstructed from community
sources, NOT from iniBuilds documentation, and has NOT been loaded in the
simulator. Do not wire into production UI until the in-sim test passes.

## Sources
- `shenkira/routefinder-to-inibuilds-.fpl-converter` (GitHub, MIT-style
  community tool for the iniBuilds A350) — established the line format:
  `AIRLINE/FLTID/CYCLE/ADEP/ADES/ALTN/CRUISE` header + `<type> <ident> <via>
  <alt> <lat> <lon>` waypoint lines (type 1 = airport, 11 = waypoint).
- MSFS forums (Jan 2025): SimBrief "iniBuilds .fpl" placed in
  `WASM/MSFS2024/microsoft-aircraft-a330/work/flightplans` and loaded via the
  MCDU CO ROUTE field on the DEFAULT A330-300. Route/airports/CRZ ALT correct;
  procedures (SID/STAR/runway) NOT carried — selected in the MCDU afterwards.

## In-sim test (needs the user's PC)
1. Copy `KJFKEIDW01.fpl` (in ~/workspace/your_files/) to the A330
   `work/flightplans` folder (Steam: `%APPDATA%\Microsoft Flight Simulator
   2024\WASM\MSFS2024\microsoft-aircraft-a330\work\flightplans`;
   MS Store: `%LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\
   LocalState\WASM\MSFS2024\microsoft-aircraft-a330\work\flightplans`).
2. In the A330 MCDU, enter `KJFKEIDW01` in the CO ROUTE field.
3. Check F-PLN: expect KJFK, TRK01, OCN01-03, TRK02-05, EIDW at FL370.
4. Select SID/STAR on DEPARTURE/ARRIVAL pages; confirm ND + NAV/FD.

## Regenerate
`node packages/msfs-export/poc/gen-ei106-fpl.mjs` (imports the built
`packages/msfs-export/dist/index.js`; rebuild the package first).
