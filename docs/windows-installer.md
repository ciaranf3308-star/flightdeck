# FlightDeck Windows installer

Current: `FlightDeck-Setup-0.2.1.exe` — a per-user NSIS installer (no admin rights, no UAC prompt).

> 0.2.1 fixes the "application window shows `{"error":"Not found."}`" bug from
> 0.2.0: the static-file containment check used `file.startsWith(dir + "/")`,
> which never matches Windows backslash paths, so every static request 404'd.
> It now uses a separator-aware `relative()`-based check (`isInsideDir`, unit
> tested under win32 path semantics), and the launcher verifies the frontend
> HTML (`<div id="root"`) — not just `/api/health` — before opening the window.

## What it installs

```
%LOCALAPPDATA%\Programs\FlightDeck\
  launch.vbs            hidden launcher (desktop shortcut points here via wscript.exe)
  stop.vbs              graceful stop helper (used by the uninstaller)
  flightdeck.ico        app icon
  resources\
    node\node.exe      portable Node.js v22 LTS (Windows x64) — runs the backend
    api\dist\          compiled planning API (pure JS; node:sqlite is built into Node 22+)
    api\node_modules\  zod, fast-xml-parser, strnum, @flightdeck/* (real copies)
    api\public\        built desktop SPA — served by the API itself, so the UI
                        and /api share one origin (no CORS, no config)
    api\data\          SQLite database (created on first run)
    bridge\           optional: drop a user-built FlightDeck.SimConnectBridge.exe here
```

Plus: desktop shortcut, Start Menu folder (FlightDeck + Uninstall), and an
Add/Remove Programs entry. The uninstaller stops the backend first.

## How it runs (no terminals, no npm)

1. Double-click the **FlightDeck** desktop icon.
2. `launch.vbs` starts `node.exe resources\api\dist\index.js` hidden with
   `FLIGHTDECK_PACKAGED=1`, waits for `/api/health` (45 s timeout, message box on failure).
3. The API auto-starts `resources\bridge\FlightDeck.SimConnectBridge.exe` if present
   (hidden). The bridge retries SimConnect with backoff until MSFS 2024 is running,
   then POSTs telemetry to the API. Without it, Live Telemetry reports disconnected.
4. The app opens in a dedicated Edge/Chrome `--app` window (own profile at
   `%LOCALAPPDATA%\FlightDeck\webapp-profile`, no browser chrome); falls back to the
   default browser if neither is found.
5. Quit from the app's **⏻ Quit** button (visible only in packaged mode) — calls
   `POST /api/shutdown`, which stops the API and the bridge, then shows a
   "you can close this window" page.

## Rebuilding

One command (lint → stage → installer), version from the root `package.json`:
```bash
./installer/build.sh
```
After building, publish the release: upload `FlightDeck-Setup-<version>.exe`
to your hosting and update `latest.json` (see `docs/auto-update.md`) so
installed apps pick it up automatically.
`installer/vbslint.py` validates both VBScript launchers before packaging — it
catches non-literal `Const` initializers (the 0.1.0 `launch.vbs` crash:
`Const HEALTH_URL = API_URL & "/api/health"` is illegal; VBScript Const
initializers must be literals — compile error 800A0415), unbalanced quotes,
bad line continuations, unbalanced blocks, and undeclared variables under
`Option Explicit`. It is a heuristic linter, not a VBScript compiler: it cannot
prove the scripts run on Windows, but the build stops on anything suspicious.

On Linux (as done for 0.2.1): `build.sh` expects the portable `node.exe` at
`~/workspace/.build-tools/winnode/x/node-v22.23.3-win-x64/node.exe` (override with
`NODE_EXE=...`); download from https://nodejs.org/dist/ (v22+ for node:sqlite).
`NSISDIR`/`MAKENSIS` env vars point at the NSIS install (defaults: the
Debian-extracted 3.12 in `~/workspace/.build-tools/nsis`). Build tools live
outside /tmp on purpose — /tmp is wiped between sessions.

On Windows the same script works with the NSIS Windows install.

## SimConnect bridge (optional, Windows-only build)

```powershell
cd services\simconnect-bridge
dotnet publish -c Release -r win-x64 --self-contained false -o publish
copy publish\FlightDeck.SimConnectBridge.exe %LOCALAPPDATA%\Programs\FlightDeck\resources\bridge\
```

## Honest limitations

- **Not code-signed**: Windows SmartScreen will show an "Unknown publisher" warning on
  first run. This is expected for an unsigned installer.
- **App window, not a native window**: the UI runs in an Edge/Chrome app window
  (or default browser fallback). A true native window needs the Tauri build compiled
  on Windows (`apps/desktop/src-tauri` scaffold exists; needs Rust stable).
- **Installer execution was not testable here**: the .exe was built with NSIS 3.12 on
  Linux; its PE structure is valid and the full packaged runtime (API + SPA + shutdown)
  was verified in a simulated layout, but the install/uninstall flow itself needs a
  Windows run. Report any issue and it will be fixed in the script.
- The bridge is not bundled (C# can't compile on Linux) — see above for the one-time build.
