# SimConnect telemetry bridge — architecture

## Data flow

```
┌──────────────┐   SimConnect (1 Hz)    ┌─────────────────────────┐   POST JSON (1 Hz)   ┌──────────────────┐   GET (poll)   ┌────────────┐
│ MSFS 2024    │ ─────────────────────▶ │ SimConnect bridge        │ ───────────────────▶ │ Planning API     │ ─────────────▶ │ FlightDeck   │
│ (sim)        │  8 simvars via         │ (dotnet console app,     │  /api/telemetry      │ :8124            │  /api/telemetry│ UI (Tauri    │
│              │  RequestDataOnSimObject│  separate sidecar process)│                      │                  │  /latest       │  / Vite)     │
└──────────────┘                        └─────────────────────────┘                      └──────────────────┘              └────────────┘
```

1. **Bridge** (`services/simconnect-bridge`, .NET 8 console app) connects to
   the local MSFS 2024 SimConnect server and requests the eight simvars below
   at **1 Hz** (`SIMCONNECT_PERIOD.SECOND`) for the user's aircraft.
2. Each sample is `POST`ed as JSON to the planning API
   (`http://localhost:8124/api/telemetry`, overridable with `--api-url`).
3. The planning API (`services/planning-api`) keeps the latest sample and its
   receive time. `GET /api/telemetry/latest` returns
   `{ connected: true, sample }` while samples are fresh, and
   `{ connected: false, sample: null }` when the last sample is older than
   the stale threshold.
4. The FlightDeck UI polls `GET /api/telemetry/latest` and renders live
   telemetry in the Telemetry tab.

## Stale-after-5-seconds rule

The planning API treats telemetry as **stale 5 seconds after the last
received sample** (`TELEMETRY_STALE_MS = 5000` in
`services/planning-api/src/server.ts`). The bridge posts at 1 Hz, so five
consecutive missed posts — or the bridge simply not running — flip the
endpoint to `connected: false`.

**Explicit contract:** without the bridge running (or with MSFS closed /
the sim crashed), the Telemetry tab shows **"Not connected"**. FlightDeck
never displays fake, placeholder, or interpolated telemetry as if it were
live sim data. Likewise, any simvar the sim does not provide is posted as
`null`, never synthesized.

## Exact simvar list (1 Hz cadence)

| JSON field         | SimVar                       | Requested units   | .NET type  |
|--------------------|------------------------------|-------------------|------------|
| `lat`              | `PLANE LATITUDE`             | `degrees`         | `FLOAT64`  |
| `lon`              | `PLANE LONGITUDE`            | `degrees`         | `FLOAT64`  |
| `altitudeFt`       | `PLANE ALTITUDE`             | `feet`            | `FLOAT64`  |
| `groundspeedKt`    | `GROUND VELOCITY`            | `knots`           | `FLOAT64`  |
| `headingDeg`       | `PLANE HEADING DEGREES TRUE` | `degrees`         | `FLOAT64`  |
| `verticalSpeedFpm` | `VERTICAL SPEED`             | `feet per minute` | `FLOAT64`  |
| `onGround`         | `SIM ON GROUND`              | `bool`            | `INT32` → bool (≠ 0) |
| `autopilotMaster`  | `AUTOPILOT MASTER`           | `bool`            | `INT32` → bool (≠ 0) |

Example POST body:

```json
{
  "lat": 40.6413,
  "lon": -73.7781,
  "altitudeFt": 35000,
  "groundspeedKt": 450,
  "headingDeg": 92.5,
  "verticalSpeedFpm": -1200,
  "onGround": false,
  "autopilotMaster": true
}
```

## Setup steps on Windows

On the user's Windows PC, in this order:

1. **Install prerequisites:** Windows 10/11, .NET 8 SDK, Rust stable via
   rustup (for the Tauri shell), Node.js 22+, WebView2 (usually
   pre-installed), and the MSFS 2024 SDK's managed SimConnect client (see
   `services/simconnect-bridge/README.md` for the package-version note).
2. **Align the SimConnect package version** in
   `services/simconnect-bridge/FlightDeck.SimConnectBridge.csproj` with
   your installed MSFS 2024 SDK, then `dotnet build -c Release`.
3. **Start the planning API:** in `services\planning-api`, `npm install`
   then `npm run dev` (listens on `http://localhost:8124`).
4. **Start MSFS 2024** and load into a flight (any aircraft).
5. **Start the bridge:**
   `services\simconnect-bridge\bin\Release\net8.0\FlightDeck.SimConnectBridge.exe`
   It connects to SimConnect (retrying with backoff if the sim isn't up
   yet) and begins posting 1 Hz samples. `Ctrl+C` stops it cleanly.
6. **Launch FlightDeck** (Tauri app or `npm run dev` in `apps\desktop`).
   The Telemetry tab flips from "Not connected" to live data within a
   second of the first posted sample.

To test the "Not connected" path: close the bridge (or MSFS) and wait
~5 seconds — the Telemetry tab must show "Not connected", never the last
known values presented as live.

## Notes for developers

- The bridge is deliberately a console app with no window handle; it polls
  `ReceiveMessage()` in a tight loop (the classic no-message-pump
  SimConnect pattern) instead of relying on Windows message dispatch.
- `SIM ON GROUND` and `AUTOPILOT MASTER` are registered as `INT32` and
  converted to booleans (`!= 0`) in `Program.cs` — the managed client has
  no native bool mapping for these.
- POST failures are logged at most once per 30 seconds and never block the
  1 Hz sample loop (a sample is dropped if the previous POST is still in
  flight).
- No secrets are involved anywhere in this pipeline — `--api-url` is a
  plain endpoint URL with no authentication.
