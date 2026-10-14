# FlightDeck — Official API/SDK Research

Research date: 2026-10-13. Every claim below cites an official source URL. Where official documentation could not be obtained, the gap is stated explicitly in the HONESTY NOTES of each section.

## Quick verdicts

- **FlightAware AeroAPI v4**: VERIFIED from official OpenAPI spec (v4.30.0). Base URL, `x-apikey` auth header, all four needed endpoints, error codes, tier/rate-limit/pricing terms.
- **SimBrief Stage 1 (OFP read)**: VERIFIED from official Navigraph developer portal (`xml.fetcher.php`).
- **SimBrief Stage 2 (generation)**: VERIFIED from official Navigraph developer docs — requires a developer API key (requested from Navigraph) **and** the end user's SimBrief login via an interactive popup; the public OFP fetcher does **not** authorize generation.
- **MSFS 2024 EFB PLN format**: VERIFIED — it **is** publicly documented in the official MSFS 2024 SDK docs. Full schema captured; known documentation errors recorded.

---

## Target 1 — FlightAware AeroAPI (v4)

### Official sources

- API docs portal: https://www.flightaware.com/aeroapi/portal/documentation (login-gated, JS-driven — content could not be read directly; see HONESTY NOTES)
- Official OpenAPI 3.0 spec (v4.30.0), published by FlightAware and referenced in the spec's own intro ("The AeroAPI OpenAPI specification is located at…"): https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml — **all endpoint details below are from this spec**
- Official product/pricing page: https://www.flightaware.com/commercial/aeroapi — tier limits, rate limits, per-query fees, historical-data terms

### Base URL and authentication (verified in the spec)

- Base URL: `https://aeroapi.flightaware.com/aeroapi` (spec `servers` entry: `https://{env}.flightaware.com/aeroapi`, with `env` defaulting to `aeroapi`)
- Auth: OpenAPI `ApiKeyAuth` security scheme, `type: apiKey, in: header, name: x-apikey`. The spec states authentication is "controlled by an API key that must be set in the header `x-apikey`" and that "your FlightAware username is not used when authenticating to the API."
- Format: JSON (`application/json; charset=UTF-8`). Paged collections use cursor pagination (`links.next`, opaque `cursor` query param).
- Error envelope (from the spec): every error is JSON `{ "title": ..., "reason": ..., "detail": ..., "status": ... }`.

### Endpoints needed by FlightDeck

| Need | Method + path | Key params |
|---|---|---|
| Flight lookup by ident + date | `GET /flights/{ident}` (operationId `get_flight`) | `ident_type` ∈ `designator`/`registration`/`fa_flight_id`; `start`, `end` (ISO-8601 date or datetime, inclusive start / exclusive end, compared against `scheduled_out`); `max_pages`, `cursor` |
| Filed route info | `GET /flights/{id}/route` (operationId `get_flight_route`) | `id` = `fa_flight_id` |
| Recorded track / positions | `GET /flights/{id}/track` (operationId `get_flight_track`) | `id` = `fa_flight_id`; `include_estimated_positions`, `include_surface_positions` (booleans, default false) |
| Aircraft info | same `GET /flights/{ident}` response | `aircraft_type`, `registration`, `operator` fields |
| Current position (live telemetry assist) | `GET /flights/{id}/position` | (listed on official pricing page, $0.010/result set) |
| Historical flights | `GET /history/flights/{ident}` (operationId `get_history_flight`) | `start`+`end` required, span ≤ 7 days, ≤ 40 pages |
| Historical track/route/map | `GET /history/flights/{id}/{track,route,map}` | `id` = `fa_flight_id` |

Spec details that matter for implementation:

- `GET /flights/{ident}` accepts ident, registration, or `fa_flight_id`. "It is highly recommended to specify ICAO flight ident rather than IATA flight ident to avoid ambiguity." Default returns ~14 days of recent + scheduled flights ordered by `scheduled_out` descending. With `start`/`end`: start must be no more than 10 days in the past and no more than 2 days in the future; end bound exclusive.
- Flight objects include: `ident`, `ident_icao`, `ident_iata`, `fa_flight_id`, `operator`/`operator_icao`/`operator_iata`, `flight_number`, `registration` (tail, "when known"), `aircraft_type` (ICAO code, IATA fallback), `origin`/`destination` (each with `code`, `code_icao`, `code_iata`, `code_lid`, `timezone`, `name`, `city`), `status` (human-readable: "Landed", "En Route", "Scheduled", "Cancelled", etc.), `cancelled`, `diverted`, `blocked`, `scheduled_*`/`estimated_*`/`actual_*` out/off/on/in, `departure_delay`/`arrival_delay` (**in seconds**, negative = early), `filed_ete` (seconds), `filed_airspeed` (knots), `filed_altitude` (**hundreds of feet**), `route` (textual route description, nullable), `actual_runway_off` / `actual_runway_on` ("when known"), `gate_origin`/`gate_destination`, `terminal_origin`/`terminal_destination`.
- `GET /flights/{id}/route` returns `{ route_distance, fixes: [{ name, latitude, longitude, distance_from_origin, distance_this_leg, distance_to_destination, outbound_course, type }] }`. **Critical caveat, verbatim in spirit from the spec: route decoding relies on navaid data limited to continental US airspace; fixes whose data is missing get `type: "UNKNOWN"`.** For KJFK→EIDW (transatlantic), route decode coverage must be treated as partial — do not fabricate missing oceanic fixes.
- `GET /flights/{id}/track` returns `{ actual_distance, positions: [{ fa_flight_id, altitude (hundreds of feet), altitude_change (C/D/-), groundspeed (knots), heading (0–360), latitude, longitude, timestamp, update_type }] }`. `update_type` ∈ P(projected)/O(oceanic)/Z(radar)/A(ADS-B)/M(multilateration)/D(datalink)/X(surface)/S(space-based)/V(virtual event). Default: airborne actual positions only. **Live (non-history) track only goes back 10 days** — older data must use the `/history` endpoints.
- Error codes (from the spec): `400` = incorrect parameters or malformed `fa_flight_id`; `404` = no track/route available for this flight. (401/402/403 documented in community integrations as key-invalid / tier-restricted; see HONESTY NOTES.)
- Historical data: "Data is available from now back to 2011-01-01 00:00:00 UTC." **Tier restriction (official product page): historical data access is Standard tier and above.** Personal tier = "Current flight status and tracks" only; Standard adds historical data + flight alerting; Premium adds Aireon space-based ADS-B + Foresight predictions.

### Rate limits and pricing (official product page)

- Personal: 10 result sets/minute. Standard: 5 result sets/second. Premium: 100 result sets/second. (1 result set = 15 records; `max_pages` caps result sets per call.)
- Per-query fees: `GET /flights/{ident}` $0.005/result set; `GET /flights/{id}/route` $0.010; `GET /flights/{id}/track` $0.012; `GET /flights/{id}/position` $0.010. Personal tier: pay-per-query, up to $5 free/month ($10 for ADS-B feeders), no monthly minimum. Standard: $100/month minimum. Premium: $1,000/month minimum.
- **Licensing**: Personal tier permits storage and distribution of derivative works for "personal or academic purposes only"; Standard = business/B2C; Premium = all B2B. FlightDeck ships a desktop app — check which tier covers it before commercial use.

### Minimal correct example

```http
GET https://aeroapi.flightaware.com/aeroapi/flights/EIN106?start=2026-10-09T00:00:00Z&end=2026-10-10T00:00:00Z&ident_type=designator&max_pages=1
x-apikey: <FLIGHTAWARE_API_KEY>
```

Response is `{ "links": {...}, "num_pages": 1, "flights": [ { ... } ] }`. For a flight older than 10 days, use:

```http
GET https://aeroapi.flightaware.com/aeroapi/history/flights/EIN106?start=2026-10-09T00:00:00Z&end=2026-10-10T00:00:00Z&ident_type=designator
x-apikey: <FLIGHTAWARE_API_KEY>
```

(Note: Aer Lingus ICAO code is EIN; IATA "EI106" maps to ident `EIN106`. The spec recommends the ICAO ident to avoid ambiguity.)

### HONESTY NOTES — AeroAPI

1. The official docs portal (https://www.flightaware.com/aeroapi/portal/documentation) is login-gated and JavaScript-driven; I could not read its content directly. All endpoint claims were instead verified against the official OpenAPI YAML FlightAware publishes for that same portal (v4.30.0).
2. Spec version was 4.30.0 at time of research; endpoint paths have been stable across v4, but the portal should be re-checked for additions before final implementation.
3. The exact meaning of 401 vs 402/403 (key invalid vs tier-restricted) was not re-verified in the spec text I read; the spec defines a generic error envelope and I observed `400`/`404` explicitly. Map 401 → unauthorized, 429 → rate-limited in client code per standard HTTP semantics, but FlightAware's rate-limit response code/shape is NOT officially verified here.
4. `actual_runway_off`/`actual_runway_on` and `registration` are documented as "when known" — the API may simply omit them; this is expected partial data, not an error.
5. `registration` is explicitly not populated by `/flights/search` and position endpoints; FlightDeck should prefer `/flights/{ident}` for aircraft identity.
6. The `/flights/{id}/position` endpoint's parameter details were not re-read from the spec (only its existence/fee from the pricing page); verify fields before coding against it.
7. Free-tier usage caps quoted by community integrations (e.g. "$5 free/month") match the official page; treat pricing as subject to change — the official page says "Prices may change."

---

## Target 2 — SimBrief integration

### Official sources

- Stage 1 (read-only OFP fetch): https://developers.navigraph.com/docs/simbrief/fetching-ofp-data ("Fetching a User's Latest OFP Data", Navigraph Developer Portal)
- Stage 2 (dispatch/generation API): https://developers.navigraph.com/docs/simbrief/using-the-api ("Using the API", Navigraph Developer Portal)
- Same material in the official forum thread: https://forum.navigraph.com/t/the-simbrief-api/5298/1 ("The SimBrief API", posted by SimBrief/Navigraph staff)

### Stage 1 — Existing OFP import (read-only)

Documented mechanism (`xml.fetcher.php`):

```
GET https://www.simbrief.com/api/xml.fetcher.php?userid={pilot_id}
GET https://www.simbrief.com/api/xml.fetcher.php?username={username}
```

- `userid` = the user's numeric SimBrief Pilot ID (found on the SimBrief Account Settings page, or in the Dispatch "New Flight" Optional Entries section where it pre-fills the "Pilot ID" field). `username` = the SimBrief alias/username.
- Append `&json=1` for a JSON object instead of XML (documented on the developer portal). The official forum API docs add: `&json=v2` is recommended for new implementations ("much more stable"); `&json=1` remains supported.
- Success → HTTP 200 + XML (or JSON) of the user's **most recent** flight plan. Invalid user or any error → HTTP 400 + a small XML-formatted error message.
- The fetcher can also fetch an API-generated plan by static ID: `https://www.simbrief.com/api/xml.fetcher.php?userid={user_id}&static_id={your_static_id}` (documented in the "Note Regarding Static ID" section).
- Known behavioral caveats (community, staff-confirmed): the fetcher exposes only the **latest generated** OFP; generated plans expire after a while and must be regenerated; to import a specific older plan the user must re-load + re-generate it in SimBrief.
- Terms/auth: no developer API key needed for Stage 1; the user's Pilot ID/username is the identifier. **Security note: the fetcher makes the user's plans accessible to anyone who knows the ID — treat the Pilot ID as user data, store it in app settings.**

Minimal correct examples:

```
https://www.simbrief.com/api/xml.fetcher.php?userid=999999
https://www.simbrief.com/api/xml.fetcher.php?username=somepilot&json=v2
https://www.simbrief.com/api/xml.fetcher.php?userid=999999&static_id=MYAPP_42
```

### Stage 2 — Flight plan generation (dispatch API)

The official integration process ("Using the API" page):

1. The developer embeds dispatch options in an HTML `<form id="sbapiform">` with documented input names (`orig`, `dest`, `type`, `airline`, `fltnum`, `route`, `deph`, `depm`, `altn`, `fl`, `callsign`, `pax`, fuel/planning options, `planformat`, `units`, `navlog`, `etops`, `stepclimbs`, `tlr`, `notams`, `maps`, `omit_sids`, `omit_stars`, `find_sidstar`, `static_id`, `acdata`, etc.). Minimum: `orig`, `dest`, `type`.
2. Include the provided `simbrief.apiv1.js` and call `simbriefsubmit('referral_page')` from the submit button.
3. Include `simbrief.apiv1.php` on the output page; the API returns XML with "nearly every internal SimBrief variable" for the generated plan.
4. **An API key is required**: "Prior to using the API, you must obtain an API key and paste it into your `simbrief.apiv1.php` file. Failure to do this will result in your flightplan requests being denied. API keys can be requested by contacting us. Please include information about your website and how you intend on using the API."

Generation flow (official "How it Works" section): when the user presses "Generate", **a small popup window hosts the SimBrief background process**; if the pilot is not logged into SimBrief, the popup asks for their SimBrief/Navigraph username and password; a progress bar shows, then the popup closes and the user returns to the site.

**This confirms the task brief's key constraint**: "First and foremost, this API does not bypass the SimBrief login system... any pilots who wish to use them will require a SimBrief (or Navigraph) account. This is necessary as SimBrief must be able to track which AIRAC cycle to deliver to the user." Public OFP fetching via `xml.fetcher.php` therefore does **not** authorize server-side dispatch generation — generation additionally requires (a) a Navigraph-issued developer API key and (b) an interactive user login with SimBrief.

Architectural implication for FlightDeck (desktop app): there is no headless server-side generation path. Stage 2 must open a browser/popup window for the SimBrief login + generation flow, or redirect the user to SimBrief Dispatch (`https://www.simbrief.com/system/dispatch.php?editflight=last&static_id=...`) with pre-filled options, then fetch the result via `xml.fetcher.php` using the `static_id`. Without the API key, ship only Stage 1 (read-only import) + local `.pln` export.

### HONESTY NOTES — SimBrief

1. The field-level response schema of `xml.fetcher.php` (all XML/JSON keys) is NOT field-documented in the official pages I read; they only promise "the XML data for the user's most recent flight" / "nearly every internal SimBrief variable." Field mapping must be derived from a real response and cross-checked against community libraries — mark all parsed fields as `inferred` in FlightDeck's provider adapter until validated against a live sample.
2. No official rate limit for `xml.fetcher.php` was found in the official docs (community integrations reference an optional `apikey` param that "improves rate limits," but this is not on the official fetching page). Implement client-side throttling and treat HTTP 429/5xx as retryable.
3. The official generation docs assume a website (PHP + JS includes). A desktop (Tauri) adaptation must host the `simbriefsubmit` flow in a webview/popup; this specific adaptation is not documented by SimBrief and should be prototyped against the live popup before committing to it.
4. Terms of use/redistribution for the API (beyond "contact us with your intended use") were not verified — check the Navigraph/SimBrief terms before shipping Stage 2.
5. AIRAC cycle context for generated plans follows the *user's* SimBrief/Navigraph subscription — plans generated via the popup inherit the pilot's cycle, not FlightDeck's navdata cycle. This must be surfaced in the UI (cycle mismatch is a known source of "procedure not found" errors).

---

## Target 3 — MSFS 2024 EFB Flight Plan XML

### Official source

https://docs.flightsimulator.com/msfs2024/html/5_Content_Configuration/Mission_XML_Files/EFB_Flight_Plan_XML_Properties.htm — "EFB Flight Plan XML (PLN File) Properties" (official MSFS 2024 SDK documentation). **The format IS publicly documented** (the legacy mission/activity PLN format is a separate page: "Flight Plan XML (PLN File) Properties", which the EFB page explicitly distinguishes itself from).

The EFB PLN "is not used for missions nor activities and is *only* used by the EFB when selecting to save or load a PLN file."

### Schema summary

Root and container:

```xml
<SimBase.Document>
    <FlightPlan.FlightPlan>
        ...
    </FlightPlan.FlightPlan>
</SimBase.Document>
```

- `<SimBase.Document>` is required at the top; everything sits inside `<FlightPlan.FlightPlan>`. None of the elements have attributes (only the `id` attribute on `<ATCWaypoint>`).

Required sub-elements of `<FlightPlan.FlightPlan>`:
- `<Title>` — shown in the EFB; convention "[departure] to [arrival]". (Display only; no sim effect.)
- `<Descr>` — short description shown in the EFB.
- `<FPType>` — `VFR` or `IFR`.
- `<CruisingAlt>` — filed cruising altitude in **feet** (e.g. `28000`).
- `<AppVersion>` — container with `<AppVersionMajor>`; **must be 12 or greater** for MSFS 2024.

Optional sub-elements:
- `<DepartureID>` / `<DestinationID>` — airport ICAO, 4 chars typical, up to 8. If omitted, the plan starts/ends at the first/last en-route waypoint.

`<DepartureDetails>` (optional) — departure runway + SID:
- `<RunwayNumberFP>`: `1`–`36`, or compass words `NORTH`/`NORTHEAST`/`EAST`/`SOUTHEAST`/`SOUTH`/`SOUTHWEST`/`WEST`/`NORTHWEST`
- `<RunwayDesignatorFP>`: `LEFT` / `CENTER` / `RIGHT` / `WATER` / `A` / `B` (omit = no designator)
- `<DepartureFP>`: SID name (e.g. `BLOKR7`)
- `<TransitionFP>`: SID transition name (e.g. `RBS`); **omit = direct transition** (must also be omitted if `<DepartureFP>` is omitted)
- `<DepartureVisualPattern>` (optional container for VFR pattern)

`<ArrivalDetails>` (optional) — arrival runway + STAR:
- `<RunwayNumberFP>`, `<RunwayDesignatorFP>`, `<TransitionFP>` (omit = direct; omit if no `<ArrivalFP>`), `<ArrivalFP>` (STAR name, e.g. `AARCH2`)

`<ApproachDetails>` (optional) — approach:
- `<ApproachTypeFP>` — **required if an approach is specified**: `ILS`, `RNAV`, `LOCALIZER`, `VOR`, `NDB`, `LDA`, `SDF`, `GPS`, `VORDME`, `NDBDME`, `LOCALIZER_BACK_COURSE`
- `<RunwayNumberFP>`, `<RunwayDesignatorFP>` (runway for the approach)
- `<SuffixFP>` — optional, e.g. `A` for "VOR A"
- `<TransitionFP>` — approach transition (e.g. `JOT`); omit = direct to final
- `<ApproachVisualPattern>` (optional container)

`<ATCWaypoint>` (zero or more) — the en-route legs:
- `<ATCWaypointType>`: `Airport` / `VOR` / `NDB` / `Intersection` for navdata fixes; `User` for custom lat/lon points
- `<WorldPosition>` — **only for `User` waypoints**; navdata waypoints resolve their position from the simulator's nav database. Format: degrees/minutes/seconds groups separated by commas, optional signed altitude in feet: `N52° 22' 42.75", E13° 31' 14.27",+006000.00`
- `<ICAO>` — **required** container: `<ICAORegion>` (2-char ARINC-424 region code, e.g. `K5`; required when type is *not* `User`), `<ICAOIdent>` (required, ≤8 chars; for `User` waypoints any unique descriptive identifier, no repeats within the plan), `<ICAOAirport>` (optional; the airport a terminal facility relates to, for disambiguation)
- Optional `id` attribute on `<ATCWaypoint>` (human-readable name, useful for custom POIs)

### Waypoint/procedure encoding rules

- **No lat/lon for navdata waypoints.** Unlike the legacy format, the EFB PLN intentionally omits `WorldPosition` for fixed facilities; positions are resolved from navdata at load. (Rationale given by Asobo staff on the dev forum: facility positions shift between AIRAC cycles, and fixed coordinates in the file could conflict with the sim's database.)
- **Airways are not encoded.** There is no airway element — the en-route portion is a flat sequence of fixes. Airway context must be resolved from your own navdata if needed for display.
- **Altitudes on en-route legs**: legacy PLN had per-waypoint altitudes; the EFB spec only documents altitude inside `<WorldPosition>` for `User` waypoints ("optional desired altitude") and `<CruisingAlt>` for the plan. Do not assume per-fix altitude constraints survive EFB import.
- **Procedures are by name only** (`<DepartureFP>BLOKR7</DepartureFP>`, `<ArrivalFP>AARCH2</ArrivalFP>`, `<ApproachTypeFP>ILS</ApproachTypeFP>` + runway). The EFB matches them against the sim's navdata at load. **This means: never invent a procedure name — the recommendation engine's "navdataCycle" field must be the cycle the procedure name was verified against.**
- ICAO region codes follow ARINC-424 (e.g. `K5` for JOT VOR). Region is required for non-`User` waypoints (the SDK doc sentence appears reversed, but a dev-support reply confirmed the intended rule — see HONESTY NOTES).

### Minimal correct example (KJFK → EIDW, IFR — placeholder procedures)

> NOTE: Procedure names and runways below are **illustrative placeholders** in the SDK's documented shape, not verified real-world data for EI106.

```xml
<SimBase.Document>
    <FlightPlan.FlightPlan>
        <DepartureID>KJFK</DepartureID>
        <DestinationID>EIDW</DestinationID>
        <Title>KJFK to EIDW</Title>
        <Descr>Aer Lingus EI106 KJFK-EIDW</Descr>
        <FPType>IFR</FPType>
        <CruisingAlt>34000</CruisingAlt>
        <AppVersion>
            <AppVersionMajor>12</AppVersionMajor>
        </AppVersion>
        <DepartureDetails>
            <RunwayNumberFP>4</RunwayNumberFP>
            <RunwayDesignatorFP>LEFT</RunwayDesignatorFP>
            <DepartureFP>MERIT5</DepartureFP>
            <TransitionFP>RBV</TransitionFP>
        </DepartureDetails>
        <ATCWaypoint>
            <ATCWaypointType>Intersection</ATCWaypointType>
            <ICAO>
                <ICAORegion>K2</ICAORegion>
                <ICAOIdent>RBV</ICAOIdent>
            </ICAO>
        </ATCWaypoint>
        <ATCWaypoint>
            <ATCWaypointType>User</ATCWaypointType>
            <WorldPosition>N50° 00' 00.00", W030° 00' 00.00",+034000.00</WorldPosition>
            <ICAO>
                <ICAOIdent>NATFIX1</ICAOIdent>
            </ICAO>
        </ATCWaypoint>
        <ATCWaypoint>
            <ATCWaypointType>Intersection</ATCWaypointType>
            <ICAO>
                <ICAORegion>E2</ICAORegion>
                <ICAOIdent>VATRY</ICAOIdent>
            </ICAO>
        </ATCWaypoint>
        <ArrivalDetails>
            <RunwayNumberFP>28</RunwayNumberFP>
            <RunwayDesignatorFP>LEFT</RunwayDesignatorFP>
            <ArrivalFP>OSGAR1X</ArrivalFP>
        </ArrivalDetails>
        <ApproachDetails>
            <ApproachTypeFP>ILS</ApproachTypeFP>
            <RunwayNumberFP>28</RunwayNumberFP>
            <RunwayDesignatorFP>LEFT</RunwayDesignatorFP>
        </ApproachDetails>
    </FlightPlan.FlightPlan>
</SimBase.Document>
```

### Verified differences from the legacy (FSX/MSFS2020) mission PLN

1. **No `WorldPosition` on navdata waypoints** (legacy included it on every fix). Only `User` waypoints carry coordinates in the EFB format.
2. **Departures/arrivals/approaches live in dedicated elements** (`DepartureDetails`/`ArrivalDetails`/`ApproachDetails`) instead of being encoded as procedure waypoints inline in the leg list.
3. **`AppVersionMajor` must be ≥ 12** (legacy used 10 / `version="1,0"`).
4. **Runway selection encoding changed**: `<RunwayNumberFP>`/`<RunwayDesignatorFP>` (EFB) vs legacy `<DeparturePosition>` etc.
5. The two formats are mutually incompatible — the legacy format is for missions/activities, the EFB format only for the EFB save/load flow.

### HONESTY NOTES — EFB PLN

1. The SDK documentation itself has acknowledged errors, documented on the official MSFS DevSupport forum: the prose example says "ILS 12L" while the code shows runway 12 RIGHT (https://devsupport.flightsimulator.com/t/efb-pln-sdk-documentation-issues-errors/16740); the `ICAORegion` "required for User waypoints" sentence is reversed — it is required for *non*-User waypoints (https://devsupport.flightsimulator.com/t/is-efb-pln-icaoregion-only-required-for-user-waypoints-a-sdk-docs-error/12641).
2. Community developers report the EFB does not always import files that match the SDK doc exactly, and that exported EFB files contain elements not covered by the spec (e.g. a `WorldLocation` element reported by third-party devs). **Validation strategy: generate from the spec, then round-trip through the actual MSFS 2024 EFB and diff — the sim is the ground truth, not the doc.**
3. XML element order may matter to the sim's parser (DevSupport report); emit elements in the order shown in the SDK example.
4. The spec documents no XSD from Microsoft; community-built XSDs derived from the doc exist but are not authoritative.
5. No programmatic injection path into the EFB is documented (SimConnect's flight-plan load updates the legacy ATC plan, not the EFB display, per community reports). FlightDeck's realistic sync story is: write the `.pln` file and have the user load it via the EFB's own Load menu — or investigate aircraft-specific avionics APIs separately.

---

## Cross-target notes for FlightDeck architecture

- AeroAPI gives filed route *text* (`route`) plus a decoded fix list (`/flights/{id}/route`) — but decode coverage outside CONUS is weak, so the KJFK→EIDW historical replay will likely need the raw `route` string parsed against FlightDeck's own navdata rather than trusting the decoded fixes.
- Neither AeroAPI nor SimBrief Stage 1 supplies SIDs/STARs/runways reliably: AeroAPI gives `actual_runway_off/on` "when known"; SimBrief OFP contains planned SID/STAR fields. The procedure *recommendation* (runway/SID/STAR/approach) remains FlightDeck's own engine — exactly as the brief's Feature C requires.
- AeroAPI terms: historical replay needs Standard tier ($100/month min, historical access) — the Personal tier cannot legally/technically serve the "Historical Replay" mode.

---

## Target 4 — OpenSky Network (free historical ADS-B)

Verified 2026-10-13 against the official docs (https://openskynetwork.github.io/opensky-api/rest.html,
API 1.4.0) **and live against the API**.

### Endpoints used by FlightDeck

- `GET /flights/departure?airport={ICAO}&begin={unix}&end={unix}` — departures in a window.
  The window **must cover more than two days (UTC)**; FlightDeck queries `[date-1d 00:00Z, date+2d 00:00Z)`.
  404 when no flights. Batch-updated nightly → previous days available (fine for Historical Replay).
- `GET /tracks/all?icao24={hex}&time={unix}` — trajectory for an aircraft at a time.
  **Experimental, and tracks are NOT available more than 30 days in the past.**
  Path entries: `[time, lat, lon, baro_altitude_m, true_track, on_ground]`.
  Waypoints are decimated (≥15 min or significant change) — the general movement pattern, not full resolution.

### Response shapes (defensively parsed)

- Flight: `{icao24, firstSeen, estDepartureAirport, lastSeen, estArrivalAirport, callsign}` —
  callsign is 8-char space-padded (e.g. `"EIN106  "`); airports are **estimated** (`est*`).
- Track: `{icao24, startTime, endTime, callsign, path}`.

### Auth — the critical live finding

**Anonymous requests to /flights/* and /tracks/* return HTTP 403 "You cannot access historical flights"**
(verified live 2026-10-13; `/states/all` works anonymously, so this is policy, not a network issue).
Historical access requires a **free** OpenSky account with an API client (OAuth2 client credentials,
token endpoint `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token`).
No payment. Quota: 4,000 credits/day per endpoint bucket (states/tracks/flights independent).
Cost: a historical departure search ~180 credits (3 day-partitions, the minimum accepted window);
a track fetch ~30 credits. Results cached 24 h in FlightDeck.

### HONESTY NOTES — OpenSky

1. OpenSky provides NO filed route, NO runways, NO aircraft type/registration in the flight object —
   FlightDeck reports all of these as unavailable rather than guessing.
2. `estDepartureAirport`/`estArrivalAirport` are estimates: marked `inferred`, with the estimate named in the note.
3. Track waypoints are decimated; first/last points are "expected departure/arrival or when the aircraft
   entered/left reception range" — approximate, noted as such.
4. A >2-day departure window can contain the same daily flight on adjacent days: FlightDeck picks the
   departure closest to midday UTC of the target date and reports the candidate count.

### What FlightDeck does NOT use

- `adsb.lol` / ADS-B Exchange: no documented free historical API suitable for this flow.
- OpenSky Trino/MinIO: full historical state vectors, but a heavyweight interface for a desktop app;
  the REST flights/tracks endpoints suffice for replay.

---

## Target 5 — adsb.aero (free historical ADS-B archive)

Verified 2026-10-13 against the official OpenAPI spec (https://adsb.aero/api/docs,
raw: https://adsb.aero/api/openapi.json, "adsb.aero API" 0.1.0) **and live against the API**.
FlightDeck's primary Historical Replay source as of 2026-10-13.

### Endpoints used

- `GET /api/v1/data-range` → `{first_date, last_date}`. Archive covered 2025-04-07 → 2026-10-13
  when verified. FlightDeck checks this FIRST so out-of-range dates get an honest answer.
- `POST /api/v1/query` — flight search. Body: `{match: {callsign_prefix}, start_from, end_date,
  limit, include_path}`. `start_from` inclusive / `end_date` exclusive bounds on `start_ts`;
  keyset `cursor` pagination; `limit` 1–10,000 (FlightDeck uses 25, `include_path: false`).
- `GET /api/v1/flights/{flight_id}` — full trajectory. `flight_id` = `<icao24>:<start_ts_utc>`
  (e.g. `4ca74e:2026-10-09T01:52:24Z`).

### Response shapes

- Flight summary/detail: `flight_id, icao24, callsign` (most common observed, or null),
  `icao_type, registration, model, year, operator` (airframes reference table; null when unknown),
  `start_ts/end_ts`, `start_point/end_point` (GeoJSON PointZ `[lon, lat, alt_ft]`),
  `start_airport_ident/end_airport_ident` (**nearest airport within 5 km**, or null),
  `point_count` (simplified), `raw_point_count`.
- Trajectory: `path` = GeoJSON **MultiLineString** (each element one contiguous sub-sequence —
  multiple = coverage gaps; "the stored path keeps its gaps; they are what the map draws",
  per the project's own design-spec), `timestamps` = unix seconds per vertex per sub-sequence,
  plus sparse `[[ts, value]]` timeseries `path_gs` (knots), `path_tracks` (deg), `path_vr`,
  `path_ias`, `alt_correction_ft` (QNH correction, not applied — raw observed altitudes kept).

### Callsign matching + identity verification

`callsign_prefix` matching is **prefix-only, case-insensitive, hyphens ignored** — so
`EIN106` could match a lookalike. FlightDeck converts the user's IATA number (EI106 → EIN106)
via the existing normalizer, then verifies identity before accepting: exact callsign match,
departure date match, and departure/arrival airport agreement with the request (null airport
idents are tolerated with an explicit note; disagreements reject the candidate).

### Auth / limits / terms

- **No authentication required** (no security schemes in the spec; verified live).
- **No rate-limit headers observed.** The project's design-spec enforces result limits
  (1–10,000/page) server-side. FlightDeck stays polite: small pages, a descriptive
  User-Agent, and its own 24 h result cache. No documented ToS page found; usage is
  ordinary read-only historical lookup.

### Live verification — EI106 2026-10-09 (the reference flight)

Query `{"callsign_prefix":"EIN106","start_from":"2026-10-09","end_date":"2026-10-10"}`
returned exactly one flight: `4ca74e:2026-10-09T01:52:24Z` — callsign EIN106, A333,
**registration EI-EAV** (matches the FlightAware reference exactly), KJFK → EIDW,
01:52:24Z → 07:17:43Z, 190 simplified / 1,344 raw positions.
**Verdict: the exact track IS available, but incomplete** — two contiguous segments
(92 + 98 positions) with a **~3h17m mid-Atlantic oceanic gap** (03:07Z–06:24Z,
46.9N 61.8W → 53.0N 15.6W). The gap is surfaced as a first-class `CoverageGap`
(warning text + map polyline break); nothing is interpolated across it.
