# FlightDeck — Tauri desktop shell

Tauri v2 shell wrapping the existing Vite frontend (`apps/desktop`). The UI
is entirely the React app; this shell only provides the native window,
installer bundles, and the WebView runtime.

**The .NET SimConnect bridge is NOT part of this shell.** It runs as a
separate sidecar process (see `services/simconnect-bridge`). Tauri neither
embeds nor manages it — the UI reads live telemetry from the planning API
(`GET http://localhost:8124/api/telemetry/latest`) through the WebView's
`fetch()`, which needs no Tauri capability at all. The capabilities file
here is deliberately empty (least privilege).

## Prerequisites (Windows PC)

- Windows 10 / 11 (64-bit)
- [Rust stable via rustup](https://rustup.rs) (Tauri v2 needs Rust ≥ 1.77)
- Node.js 22+ (matches the rest of the monorepo)
- [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) —
  pre-installed on Windows 10 1803+ / Windows 11; the Evergreen runtime is
  downloaded by the NSIS/MSI installer on older machines
- Tauri CLI (installed per-user, no repo dependency changes):

  ```powershell
  cargo install tauri-cli
  ```

## Commands (run from this `src-tauri` directory)

```powershell
# Dev: opens the Tauri window against the Vite dev server on :5173
# (start the Vite dev server first: `npm run dev` in apps\desktop)
tauri dev

# Production build: bundles ../dist into NSIS + MSI installers
# (build the frontend first: `npm run build` in apps\desktop)
tauri build
```

Installers land in `target\release\bundle\nsis` and `target\release\bundle\msi`.

### `npm run tauri` script entries

None were added to `apps/desktop/package.json` on purpose — dependencies
were left untouched per the scaffold brief. Use the `tauri` CLI directly
(see above), or add your own scripts locally:

```json
{ "scripts": { "tauri": "tauri", "tauri:dev": "tauri dev", "tauri:build": "tauri build" } }
```

## Config notes

- `tauri.conf.json` points `build.frontendDist` at `../dist` (the Vite
  production output) and `build.devUrl` at `http://localhost:5173`.
- Window: 1440×900 default (min 1024×640), title "FlightDeck".
- Bundle targets: `nsis` + `msi` (Windows only).
- `capabilities/default.json` grants **no** permissions — the UI needs
  none. Network access to `localhost:8124` is plain WebView `fetch()` and
  is not gated by Tauri capabilities.

## Before the first `tauri build`

- **App icon:** `bundle.icon` references `icons/icon.ico`, which is not
  scaffolded. Generate it from a 1024×1024 PNG with
  `tauri icon path\to\icon.png` (writes `icons/`), or point `icon` at
  your own asset before building — the bundle step fails without an icon.
- **frontendDist:** run `npm run build` in `apps\desktop` first so
  `../dist` exists.

## Runtime order on the user's PC

1. Start the planning API (`services\planning-api`).
2. Start MSFS 2024, then the SimConnect bridge
   (`services\simconnect-bridge`).
3. Launch the FlightDeck Tauri app (or the Vite dev server directly).

Without step 2 running, the Telemetry tab shows "Not connected" — the app
never fakes telemetry data.
