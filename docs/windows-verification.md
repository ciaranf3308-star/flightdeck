# Windows verification checklist — MSFS 2024 EFB import + flight-computer sync

These are the highest-priority remaining checks. They cannot run in a Linux
sandbox — they need the user's Windows PC with MSFS 2024 installed.

## 1. EFB PLN import round-trip (highest priority)

Goal: prove a FlightDeck-exported `.pln` loads in the real MSFS 2024 EFB exactly
as generated, with no silent alteration.

1. On the Windows PC: `npm install`, `npm run build`, `npm run dev:api`, `npm run dev:desktop`.
2. Historical tab → EI106 / 2026-10-09 / KJFK → EIDW → use the **adsb.aero** option → plan → export. Save as `EI106-adsbaero.pln`.
3. In MSFS 2024: World Map → EFB → Load/Save → load the file.
4. Verify and record:
   - [ ] Departure/destination airports and IFR type correct.
   - [ ] Cruising altitude shows 37,000 (inferred from the track — shown in FlightDeck warnings).
   - [ ] All 24 TRK waypoints appear with correct coordinates (spot-check 2–3 against the FlightDeck map).
   - [ ] The oceanic gap is visible as a straight segment between the last pre-gap and first post-gap waypoint (expected: FlightDeck does not interpolate; the EFB draws the leg directly).
   - [ ] No procedure (SID/STAR/approach) was invented by the sim for the User waypoints.
   - [ ] Re-export from the EFB and diff against FlightDeck's file — record any element the sim adds, drops, or reorders (known risk area per research/api-research.md honesty notes).

Known risk: per DevSupport reports, the sim does not always import spec-shaped files,
and exported EFB files contain elements not covered by the SDK doc. **The sim is the
ground truth, not the doc.** Any discrepancy goes into research/api-research.md.

## 2. Aircraft flight-computer synchronization

Goal: get the plan into the aircraft's FMGC/MCDU with minimum manual entry.

Honest baseline: there is **no documented programmatic injection path** into an
aircraft's flight computer from an external app (SimConnect's flight-plan load
updates the legacy ATC plan, not the avionics). Realistic sync stories, in order:

1. **EFB → aircraft (preferred where supported):** some aircraft (e.g. iniBuilds A330,
   Fenix A320) can import the EFB flight plan into the FMGC. Test: load the plan in
   the EFB, then use the aircraft's EFB-import / company-route function; record
   whether waypoints, cruise alt, and cost index transfer, and what needs manual entry.
2. **Manual MCDU entry:** fall back to entering the TRK waypoints as lat/long
   waypoints. Record the exact keystroke flow for the iniBuilds A330 so it can be
   documented once and reused.
3. **SimBrief OFP as reference:** FlightDeck's SimBrief Stage-1 import already
   works — compare its OFP route against the adsb.aero-derived plan for the same
   flight and note divergences.

Record per-aircraft results in a table here (aircraft / EFB import works? /
manual flow / notes). Do not claim sync works until flown in-sim.

## 3. SimConnect bridge (telemetry + guidance)

1. Build `services/simconnect-bridge` with the .NET 8 SDK on Windows; align the
   placeholder SimConnect package reference with the installed MSFS 2024 SDK version.
2. Run the bridge next to MSFS 2024; confirm `GET /api/telemetry/latest` shows
   `connected: true` with live position.
3. Fly the EI106 replay plan and confirm the guidance UI tracks progress against
   the TRK waypoints (lateral deviation, next-waypoint sequencing).

## 4. Tauri desktop binary

`apps/desktop/src-tauri` needs Rust stable on Windows: `npm run tauri build`,
generate icons (icon still missing), smoke-test the Historical tab in the
packaged app (no browser loopback issues there).

---

## EI106 flyable integration test — iniBuilds A330-300 (default MSFS 2024 aircraft)

**Status: NOT TESTED — every step below is UNVERIFIED until flown in the running simulator.
Nothing in this section may be marked verified without that.**

### What FlightDeck produces (verified on the API, 2026-10-14)

`POST /api/flyable` builds a navigable IFR reference route from the 190 verified
adsb.aero ADS-B positions, kept strictly separate from the historical reference:

- `KJFK` (verified) → `TRK01`–`TRK05` (inferred: real track coordinates, synthetic names)
  → `OCN01`–`OCN03` (generated: great-circle bridging across the 3h17m oceanic coverage gap —
  flyable reference only, never the actual flown route) → `EIDW` (verified).
- 8 enroute User waypoints with coordinates, cruise 37,000 ft (inferred from track max).
- Runways: override to the known actuals **31L → 28L** in the UI procedure panel
  (2 clicks, recorded in plan overrides) — the engine then recommends the matching
  SID/STAR/ILS from navdata automatically.
- The exported PLN carries: airports, runways 31L/28L, 8 User waypoints, cruise alt.
  Synthetic fixture procedure names are **never exported** (honesty gate) — the pilot
  selects the published SID/STAR/ILS in the EFB from the sim's own navdata.

### Preparation (Windows PC)

1. `npm install`, `npm run build`, `npm run dev:api`, `npm run dev:desktop`.
2. Historical tab → EI106 / 2026-10-09 / KJFK → EIDW → **adsb.aero** option →
   **Build flyable IFR plan** → aircraft: iniBuilds A330-300.
3. In the procedure panel: override departure runway → **31L**, arrival runway → **28L**.
   Confirm the SID/STAR/approach recommendations refresh.
4. Export → save as `EI106-flyable.pln`.
5. MSFS 2024: select the iniBuilds A330-300, spawn at KJFK gate (cold & dark or ready — record which).

### Step 1 — MSFS 2024 accepts the exported PLN [UNVERIFIED]

1. World Map → EFB → Load/Save → load `EI106-flyable.pln`.
2. Pass criteria: no import error; Departure KJFK, Destination EIDW, IFR, cruise 37,000;
   Departure runway preselected 31L; Arrival runway preselected 28L; 8 enroute waypoints
   (KJFK, TRK01–TRK05, OCN01–OCN03, EIDW) plotted in order with no gaps or reversals.
3. Record: any warning the EFB shows; whether User waypoints display coordinates.

### Step 2 — EFB shows the intended route including departure and approach [UNVERIFIED]

1. In the EFB flight-plan page, select the published **31L SID** (via MERIT if published),
   the **OSGAR4L STAR** (or current equivalent for 28L), and the **ILS 28L** approach
   from the sim's navdata.
2. Pass criteria: the EFB route is continuous KJFK → SID → TRK/OCN waypoints → STAR →
   ILS 28L → EIDW with no discontinuities; the oceanic OCN legs are straight segments
   (expected: generated reference).
3. Record the exact published procedure names selected — they become the reference
   for future flights.

### Step 3 — A330 MCDU receives the route, or manual sync steps identified [UNVERIFIED]

1. Try, in order: (a) EFB "send to avionics" / flight-plan transfer if the iniBuilds
   EFB offers it; (b) the A330's own EFB flight-plan import; (c) MCDU INIT/ F-PLN manual entry.
2. Pass criteria for (a)/(b): the F-PLN page shows KJFK, the 8 waypoints, EIDW with
   matching coordinates; no duplicate or dropped waypoints.
3. If only (c) works: record the EXACT keystroke flow (MCDU pages, lat/long entry format
   for TRK/OCN waypoints, SID/STAR/approach selection in the MCDU) so it becomes a
   documented procedure, not tribal knowledge.
4. Do not claim MCDU sync works until the F-PLN page is photographed/verified in-sim.

### Step 4 — Navigation display shows the expected route [UNVERIFIED]

1. With the route in the MCDU, check the ND (ARC and PLAN modes).
2. Pass criteria: ND draws KJFK → waypoints → EIDW matching the EFB; no missing legs;
   the OCN oceanic legs appear as straight segments; distance/fuel predictions are sane.

### Step 5 — Aircraft follows the route in managed lateral navigation [UNVERIFIED]

1. Depart 31L, engage AP with managed lateral mode (NAV) after the SID.
2. Pass criteria: the aircraft sequences through each TRK/OCN waypoint without manual
   heading intervention; no unexpected turns at the oceanic gap boundaries (the
   generated OCN waypoints must produce a smooth great-circle-ish path); cross-check
   one oceanic waypoint's coordinates against the FlightDeck plan.

### Step 6 — Arrival procedure and ILS flown on the aircraft's autopilot [UNVERIFIED]

1. Fly the STAR and ILS 28L with AP engaged (managed or selected as the test dictates —
   record which).
2. Pass criteria: STAR waypoints sequence correctly; ILS 28L captures localizer and
   glideslope; stable approach achievable without manual vectoring.
3. Record: the published STAR/approach names actually flown, any MCDU discontinuities
   requiring manual deletion, and autoland vs manual landing outcome.

### Reporting

For each step record: PASS/FAIL, the exact sim behavior, and any FlightDeck change
needed. A FAIL is data — file it against the relevant layer (export format, procedure
selection, waypoint count/format) rather than working around it in the sim.
