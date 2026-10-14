# FlightDeck SimConnect Bridge

A .NET 8 console app that reads live aircraft state from Microsoft Flight
Simulator 2024 via SimConnect and POSTs it to the FlightDeck planning API.

It runs as a **separate sidecar process** — the Tauri desktop shell does not
embed it; you start it alongside the app (see
`docs/simconnect.md` at the repo root for the full architecture).

## Prerequisites (Windows PC)

- Windows 10 / 11 (64-bit)
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)
- **Microsoft Flight Simulator 2024 running** (the bridge retries until the
  sim is up, but there is nothing to read before then)
- The MSFS 2024 SDK's managed SimConnect client installed — the
  `Microsoft.FlightSimulator.SimConnect` package is distributed with the
  SDK (SimConnect SDK section of the SDK docs), **not** via the public
  nuget.org gallery

## Package version note

The `FlightDeck.SimConnectBridge.csproj` references
`Microsoft.FlightSimulator.SimConnect` (the official managed client). The
exact package `Version` comes from your MSFS 2024 SDK installation — align
it before building:

1. Check the SDK docs / SDK installer for the shipped managed-client version.
2. Edit the `Version` attribute on the `<PackageReference>` in the `.csproj`.
3. If `dotnet restore` cannot find the package, register the SDK's local
   NuGet feed as a package source:

   ```powershell
   dotnet nuget add source "<path-to-SDK>\NuGet" --name msfs-sdk
   ```

   (use the feed path given in your SDK's SimConnect documentation).

## Build

```powershell
cd services\simconnect-bridge
dotnet build -c Release
```

Output lands in `bin\Release\net8.0\`.

## Run

```powershell
cd bin\Release\net8.0
.\FlightDeck.SimConnectBridge.exe
```

Options:

```powershell
# Post to a non-default planning API endpoint:
.\FlightDeck.SimConnectBridge.exe --api-url http://localhost:8124/api/telemetry

# Usage:
.\FlightDeck.SimConnectBridge.exe --help
```

`Ctrl+C` stops the bridge gracefully (the SimConnect connection is closed).

## What it posts

Every second, while MSFS 2024 is running and the user is in an aircraft:

```json
POST http://localhost:8124/api/telemetry
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

Read from these exact SimVars (1 Hz cadence):

| JSON field         | SimVar                       | Units             |
|--------------------|------------------------------|-------------------|
| `lat`              | `PLANE LATITUDE`             | degrees           |
| `lon`              | `PLANE LONGITUDE`            | degrees           |
| `altitudeFt`       | `PLANE ALTITUDE`             | feet              |
| `groundspeedKt`    | `GROUND VELOCITY`            | knots             |
| `headingDeg`       | `PLANE HEADING DEGREES TRUE` | degrees           |
| `verticalSpeedFpm` | `VERTICAL SPEED`             | feet per minute   |
| `onGround`         | `SIM ON GROUND`              | bool (0/1)        |
| `autopilotMaster`  | `AUTOPILOT MASTER`           | bool (0/1)        |

A value the sim does not provide is posted as `null` — **never
synthesized**. If the planning API stops receiving samples, it marks
telemetry stale after 5 s and the FlightDeck UI's Telemetry tab shows
"Not connected" rather than fake data.

## Troubleshooting

- **"SimConnect connection failed (MSFS 2024 may not be running)" repeating.**
  Start MSFS 2024 and load into a flight; the bridge retries with backoff
  (2 s → 30 s) automatically. If the sim *is* running, make sure SimConnect
  is enabled in the sim (Developer Mode → SimConnect, or the default
  local config). Third-party firewalls blocking localhost traffic to the
  sim's SimConnect port will also cause this.
- **`dotnet restore` / build cannot find `Microsoft.FlightSimulator.SimConnect`.**
  Expected until the package version is aligned with your SDK (see
  "Package version note" above). The package is not on public nuget.org.
- **Telemetry tab stuck on "Not connected" but the bridge says it posted.**
  Check the bridge isn't logging POST failures (a dead API logs at most
  once per 30 s). Verify the planning API is listening on port 8124
  (`npm run dev` in `services/planning-api`) and that `--api-url` matches.
- **Port in use.** The bridge itself opens no listening ports, so a port
  conflict is on the planning API side (8124) or MSFS's SimConnect port.
  Run `netstat -ano | findstr 8124` to find the holder.
- **Wrong values / scrambled fields.** Field order in `AircraftState`
  (Program.cs) must match the `AddToDataDefinition` call order. They are
  kept adjacent and in lockstep on purpose — if you add a simvar, add it
  to both lists in the same position.

## Secrets

There are none. The bridge takes no API keys, tokens, or credentials —
`--api-url` is a plain endpoint URL with no auth.
