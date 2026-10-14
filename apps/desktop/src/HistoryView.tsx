import { useEffect, useState } from "react";
import { api, type HistoryOption, type HistoryResponse, type PlanResponse, type StoredImport } from "./api";
import { PlanResults } from "./components/PlanDisplay";
import { pushRecentLookup } from "./library";
import type { AircraftProfile, TrackKind } from "@flightdeck/shared-models";

function TrackKindBadge({ kind }: { kind: TrackKind }) {
  const map: Record<TrackKind, { label: string; cls: string; title: string }> = {
    verified: {
      label: "Verified track",
      cls: "verified",
      title: "Real recorded ADS-B/provider track.",
    },
    imported: {
      label: "Imported data",
      cls: "inferred",
      title: "User-supplied file — taken as-is, not independently verified.",
    },
    reconstructed: {
      label: "Reconstructed — not the actual flight",
      cls: "generated",
      title: "Great-circle reference route. Never the actual flown route.",
    },
    unavailable: { label: "No track", cls: "unavailable", title: "No position history from this source." },
  };
  const m = map[kind];
  return (
    <span className={`prov ${m.cls}`} title={m.title}>
      {m.label}
    </span>
  );
}

export default function HistoryView() {
  const [flightNumber, setFlightNumber] = useState("EI106");
  const [date, setDate] = useState("2026-10-09");
  const [origin, setOrigin] = useState("KJFK");
  const [destination, setDestination] = useState("EIDW");
  const [aircraftId, setAircraftId] = useState("");
  const [profiles, setProfiles] = useState<AircraftProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [planning, setPlanning] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<HistoryResponse | null>(null);
  const [reconSearched, setReconSearched] = useState(false);
  const [planResp, setPlanResp] = useState<PlanResponse | null>(null);
  const [imports, setImports] = useState<StoredImport[]>([]);
  const [impFlight, setImpFlight] = useState("EI106");
  const [impDate, setImpDate] = useState("2026-10-09");
  const [impMsg, setImpMsg] = useState("");
  const [cruiseAlt, setCruiseAlt] = useState("");

  useEffect(() => {
    api.aircraft().then((r) => {
      setProfiles(r.profiles);
      const a333 = r.profiles.find((p) => p.icaoType === "A333");
      if (a333) setAircraftId(a333.id);
    }).catch(() => {});
    api.imports.list().then(setImports).catch(() => {});
  }, []);

  async function find(allowReconstruction: boolean) {
    setLoading(true);
    setError("");
    setResult(null);
    setPlanResp(null);
    setReconSearched(allowReconstruction);
    try {
      const r = await api.history({
        flightNumber,
        date,
        origin: origin.trim() || undefined,
        destination: destination.trim() || undefined,
        allowReconstruction,
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Historical lookup failed.");
    } finally {
      setLoading(false);
    }
  }

  async function planFrom(opt: HistoryOption) {
    setPlanning(opt.source);
    setError("");
    try {
      // Track-based sources: build a separate navigable IFR reference route.
      // The recorded track stays a historical reference overlay — it is never
      // the plan's legs.
      let planFixes = opt.planFixes;
      let planWarnings = opt.planWarnings;
      if (opt.track.length >= 2) {
        const fly = await api.flyable(opt.lookup);
        planFixes = fly.fixes;
        planWarnings = [...opt.planWarnings, ...fly.warnings];
      }
      const r = await api.plan({
        mode: "historical",
        lookup: opt.lookup,
        planFixes,
        planWarnings,
        aircraftProfileId: aircraftId || undefined,
        cruiseAltitudeFt: cruiseAlt.trim() ? Number(cruiseAlt) : undefined,
      });
      setPlanResp(r);
      pushRecentLookup({
        flightNumber: r.lookup.flightNumber,
        date: r.lookup.date,
        origin: r.lookup.origin.value?.icao ?? null,
        destination: r.lookup.destination.value?.icao ?? null,
      });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Planning failed.");
    } finally {
      setPlanning(null);
    }
  }

  async function uploadFile(file: File) {
    setImpMsg("");
    try {
      const content = await file.text();
      const r = await api.imports.upload({ flightNumber: impFlight, date: impDate, filename: file.name, content });
      setImpMsg(`Saved "${file.name}" — ${r.import.pointCount} positions for ${impFlight} on ${impDate}.`);
      setImports(await api.imports.list());
    } catch (e) {
      setImpMsg(`Import failed: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  async function removeImport(id: string) {
    await api.imports.remove(id);
    setImports(await api.imports.list());
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Historical Replay — no paid subscription needed</h2>
        <div className="sub">
          FlightDeck looks for past-flight data from free and your own sources, in order:{" "}
          <b>adsb.aero</b> (free ADS-B archive, no account needed), <b>your imported track files</b> (CSV/GPX/KML),{" "}
          <b>OpenSky Network</b> (free account required), then an{" "}
          <b>explicitly labelled reconstructed reference</b>. A paid FlightAware key is strictly optional — if one is
          configured it is tried (after the free sources), otherwise it is skipped without breaking anything.
        </div>
        <div className="row">
          <div className="field" style={{ marginBottom: 0, minWidth: 150 }}>
            <label>Flight number</label>
            <input value={flightNumber} onChange={(e) => setFlightNumber(e.target.value)} placeholder="EI106" />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 170 }}>
            <label>Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 120 }}>
            <label>Origin (for OpenSky)</label>
            <input value={origin} onChange={(e) => setOrigin(e.target.value.toUpperCase())} placeholder="KJFK" maxLength={4} />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 120 }}>
            <label>Destination</label>
            <input value={destination} onChange={(e) => setDestination(e.target.value.toUpperCase())} placeholder="EIDW" maxLength={4} />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>Aircraft profile</label>
            <select value={aircraftId} onChange={(e) => setAircraftId(e.target.value)}>
              <option value="">Auto (from lookup)</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <button className="btn" onClick={() => void find(false)} disabled={loading || !flightNumber || !date}>
              {loading ? <><span className="spin" />Searching…</> : "Find historical data"}
            </button>
          </div>
        </div>
        <div className="faint mt" style={{ fontSize: 12 }}>
          OpenSky needs the origin airport and a free OpenSky API client (no payment — add it in Settings;
          anonymous requests are rejected by OpenSky). Detailed tracks only cover the last 30 days — older
          flights return times and airports but no track.
        </div>
      </div>

      {error && <div className="errbox" style={{ marginBottom: 16 }}>{error}</div>}

      {planResp && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--green)" }}>
          <PlanResults initial={planResp} />
        </div>
      )}

      {result && !planResp && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Sources checked</h2>
            <div className="kv">
              {result.attempts.map((a) => (
                <div key={a.source} style={{ display: "contents" }}>
                  <dt>{a.label}</dt>
                  <dd>
                    <span className="row" style={{ gap: 8 }}>
                      <TrackKindBadge kind={a.trackKind} />
                      <span className={a.found ? "" : "faint"}>{a.detail}</span>
                    </span>
                  </dd>
                </div>
              ))}
            </div>
            {!reconSearched && (
              <div className="mt">
                <div className="sub" style={{ marginBottom: 8 }}>
                  Nothing usable found? You can reconstruct a clearly-labelled great-circle reference route. It will
                  never be presented as the actual flown route.
                </div>
                <button className="btn ghost" onClick={() => void find(true)} disabled={loading}>
                  Reconstruct reference route
                </button>
              </div>
            )}
          </div>

          {result.options.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>Plan from a source</h2>
              <div className="sub">Each option plans the full workflow — procedures, MSFS 2024 EFB export, autopilot guidance — with its source shown throughout. For recorded tracks, the plan is a separate navigable IFR reference route; the observed positions stay a historical reference overlay on the map, never the plan's legs.</div>
              <div className="field" style={{ maxWidth: 220, marginBottom: 12 }}>
                <label>Cruise altitude, ft (optional)</label>
                <input value={cruiseAlt} onChange={(e) => setCruiseAlt(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 35000" inputMode="numeric" />
                <span className="faint" style={{ fontSize: 12 }}>
                  Used when the source has no altitude (e.g. reconstructions). Track sources already derive it from the recorded altitudes.
                </span>
              </div>
              {result.options.map((o, i) => (
                <div key={`${o.source}-${i}`} className="row" style={{ justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderTop: i > 0 ? "1px solid var(--line)" : "none" }}>
                  <span className="row" style={{ gap: 10 }}>
                    <strong>{o.label}</strong>
                    <TrackKindBadge kind={o.trackKind} />
                    <span className="faint">{o.detail}</span>
                  </span>
                  <button className="btn small" onClick={() => void planFrom(o)} disabled={planning !== null}>
                    {planning === o.source ? "Planning…" : o.track.length >= 2 ? "Build flyable IFR plan" : "Plan from this source"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div className="card">
        <h2>Import your own track data</h2>
        <div className="sub">
          Upload a recorded track (CSV with time/lat/lon/altitude columns, GPX, or KML). It is stored locally and
          matched to the flight number and date in Historical Replay. Imports are labelled as imported — never as
          verified provider data.
        </div>
        <div className="row">
          <div className="field" style={{ marginBottom: 0, minWidth: 140 }}>
            <label>Flight number</label>
            <input value={impFlight} onChange={(e) => setImpFlight(e.target.value)} placeholder="EI106" />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 160 }}>
            <label>Date</label>
            <input type="date" value={impDate} onChange={(e) => setImpDate(e.target.value)} />
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <label className="btn ghost" style={{ cursor: "pointer" }}>
              Choose track file…
              <input
                type="file"
                accept=".csv,.gpx,.kml"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadFile(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        {impMsg && <div className="mt faint">{impMsg}</div>}
        {imports.length > 0 && (
          <div className="mt">
            <h2 style={{ fontSize: 14 }}>Saved imports</h2>
            <div className="kv">
              {imports.map((im) => (
                <div key={im.id} style={{ display: "contents" }}>
                  <dt>{im.flightNumber} · {im.date}</dt>
                  <dd>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="mono">{im.filename}</span>
                      <button className="linkbtn danger" onClick={() => void removeImport(im.id)}>Delete</button>
                    </span>
                  </dd>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
