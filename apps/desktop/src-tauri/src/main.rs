// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// FlightDeck desktop shell.
//
// This is intentionally minimal: the entire product UI is the existing
// React/Vite frontend in apps/desktop, loaded by the WebView. There is no
// Rust-side business logic here. The .NET SimConnect bridge is a SEPARATE
// sidecar process (see services/simconnect-bridge) — Tauri does not embed
// or manage it; the UI reads telemetry from the planning API via fetch()
// at http://localhost:8124, which needs no special Tauri capability.

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running FlightDeck");
}
