# A330-300 route-loading investigation (2026-10-14)

Goal: get a FlightDeck plan into the default iniBuilds A330-300's MCDU with
**no SimBrief account, no manual waypoint entry**, FlightDeck handling route
generation and delivery, minimal cockpit interaction, FD + managed NAV.

Prior position (now corrected): a Dec-2024 iniBuilds forum thread said the
universal EFB cannot feed iniBuilds Airbuses. That is STALE.

## What is established

### Official documentation / release notes (strongest evidence)
- **SU3** (mid-2025): iniBuilds fixed *"MCDU and EFB not communicating –
  unable to cross-load flight plan"* on their Airbus line
  (flightsimulator.com SU3 release notes).
- **SU7** (2026-10-13, 1.9.18.0): *"Fixed – EFB fails to send flight plan to
  MCDU"* for the Airbus H225 — Asobo fixes EFB→avionics sync per-aircraft
  (forums.flightsimulator.com, SU7 release notes).
- **MSFS 2024 SDK**: "EFB Flight Plan XML (PLN File) Properties" defines the
  2024 PLN format (AppVersionMajor 12). FlightDeck's exporter implements this
  spec; code-verified, not sim-verified.
- The A330-300's SU7 changelog entry lists only a Lufthansa livery — **no
  EFB→MCDU fix is documented for the A330 specifically.**

### Community reports (credible, not verified by us)
- MSFS forum guide (Oct 2025, "How to import from SimBrief to MSFS2024"):
  *"Default iniBuilds Airbus airliners (A310, A320neo, and A330s) recently
  gained the ability to sync their avionics flight plan with the flight plan
  in the default Flight Planner/Free Flight world map"* — i.e. selecting more
  than a departure airport pre-loads the MCDU on spawn. For other aircraft:
  EFB Flight Planner → SEND → **"SEND TO ATC AND AVIONICS"** → spawn →
  *"you should see that the flight plan is already loaded into the aircraft"*,
  including runways/SID/STAR/approach selected in the EFB.
- MSFS forum (Jan 2025): a SimBrief **"iniBuilds .fpl"** download placed in
  `WASM/MSFS2024/microsoft-aircraft-a330/work/flightplans` and entered as
  `KLAXKLAS01` in the MCDU **CO ROUTE** field loaded airports, CRZ ALT and
  route correctly — but **no runways/SIDs/STARs** (selected manually after).
- Open-source `routefinder-to-inibuilds-.fpl-converter` (GitHub, for the
  iniBuilds A350) documents the .fpl line format FlightDeck's PoC mirrors.

### Verified by FlightDeck (code-level only — no simulator access in this environment)
- `exportMsfs2024Pln` output for EI106 is well-formed per the SDK spec:
  AppVersionMajor 12, DepartureID/DestinationID separate from enroute,
  8 enroute fixes as `User` waypoints with WorldPosition at FL370.
- `exportIniBuildsFpl` (new, `packages/msfs-export/src/company-route.ts`)
  emits byte-exact the community-documented format; 7 unit tests pass.
- `detectA330FlightplansDir()` resolves both known WASM folder layouts
  (Steam `%APPDATA%`, MS Store `%LOCALAPPDATA%/Packages/Microsoft.Limitless_…`).

### NOT verified (requires the user's PC + MSFS 2024)
1. Whether the EFB "SEND TO ATC AND AVIONICS" (or a world-map plan) actually
   populates the default A330-300's MCDU F-PLN.
2. Whether the A330 reads a FlightDeck-generated .fpl from
   `work/flightplans` via CO ROUTE.
3. Whether either path yields FD guidance + managed NAV to the destination.

## Path 1 test protocol — EFB sync (2 minutes, try first)
1. Free Flight → world map → open the EFB (Tab) → Flight Planner → load icon →
   LOAD FROM PC → select `EI106-KJFK-EIDW.pln`.
2. Route page → SEND → **SEND TO ATC AND AVIONICS**.
3. Select the A330-300, spawn cold & dark at a parking stand.
4. Open the MCDU F-PLN page. **Pass = waypoints present.**
   - Note: if the MCDU pre-loads, INIT REQUEST disappears (expected — the
     Oct-2025 guide documents this; the DATA → A/C STATUS → SECOND NAV DATA
     BASE ×2 reset restores it if ever needed).

## Path 2 test protocol — company route .fpl
1. Copy `KJFKEIDW01.fpl` into the A330 `work/flightplans` folder
   (Steam: `%APPDATA%\Microsoft Flight Simulator 2024\WASM\MSFS2024\
   microsoft-aircraft-a330\work\flightplans`; MS Store:
   `%LOCALAPPDATA%\Packages\Microsoft.Limitless_8wekyb3d8bbwe\LocalState\
   WASM\MSFS2024\microsoft-aircraft-a330\work\flightplans`).
2. In the A330 MCDU INIT page, enter `KJFKEIDW01` in the CO ROUTE field.
3. Check F-PLN: expect KJFK → TRK01 → OCN01 → OCN02 → OCN03 → TRK02 →
   TRK03 → TRK04 → TRK05 → EIDW at FL370. **Pass = route present.**
4. Select SID/STAR on DEPARTURE/ARRIVAL pages (the format cannot carry them —
   confirmed by the forum report), then confirm ND display, FD bars, and NAV
   capture after takeoff.

## If a path passes
Wire it into the app: Path 1 needs no app change (PLN export already exists —
document the flow). Path 2 wants one-click "Send to A330" in the SimBrief
panel's place: generate .fpl → `detectA330FlightplansDir()` → write file →
show the CO ROUTE name to type. Neither path was changed in production code
for this investigation, per the brief.
