import { useEffect, useState } from "react";
import { api, type PlanResponse } from "./api";
import HomeView from "./HomeView";
import HistoryView from "./HistoryView";
import { PlanResults } from "./components/PlanDisplay";
import { lib, pushRecentLookup, type Category } from "./library";
import type {
  AircraftProfile,
  FlightLookupResult,
  FlightPlan,
} from "@flightdeck/shared-models";

type View = "home" | "plan" | "history" | "simbrief" | "telemetry" | "settings";

interface PlanSeed {
  flightNumber: string;
  date: string;
  nonce: number;
}

export default function App() {
  const [view, setView] = useState<View>("home");
  const [planSeed, setPlanSeed] = useState<PlanSeed | null>(null);
  const [libRefresh, setLibRefresh] = useState(0);
  const [packaged, setPackaged] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<{ latestVersion: string } | null>(null);

  useEffect(() => {
    api.health().then((h) => setPackaged(h.packaged === true)).catch(() => {});
    api.updateStatus().then((s) => {
      if (s.updateAvailable && s.latestVersion) setUpdateInfo({ latestVersion: s.latestVersion });
    }).catch(() => {});
  }, []);

  async function quit() {
    if (!window.confirm("Quit FlightDeck? This stops the background services.")) return;
    setQuitting(true);
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch {
      /* the server exits mid-response; a failed fetch is expected */
    }
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#0b0f1a;color:#e6edf7;font-family:system-ui">FlightDeck has stopped. You can close this window.</div>';
  }

  const goPlan = (flightNumber: string, date: string) => {
    setPlanSeed({ flightNumber, date, nonce: Date.now() });
    setView("plan");
  };

  const navLabel = (v: View) =>
    v === "home" ? "Library" : v === "plan" ? "Flight Plan" : v === "history" ? "Historical" : v === "simbrief" ? "SimBrief" : v === "telemetry" ? "Live Telemetry" : "Settings";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <h1>FLIGHTDECK<small>MSFS 2024 planning companion</small></h1>
        </div>
        <nav>
          {(["home", "plan", "history", "simbrief", "telemetry", "settings"] as View[]).map((v) => (
            <button key={v} className={`navbtn ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
              {navLabel(v)}
            </button>
          ))}
          {packaged && (
            <button className="navbtn" onClick={() => void quit()} disabled={quitting} title="Stop FlightDeck's background services">
              {quitting ? "Quitting…" : "⏻ Quit"}
            </button>
          )}
        </nav>
      </header>
      {updateInfo && (
        <div style={{ background: "var(--amber-bg, #3a2c10)", borderBottom: "1px solid var(--amber, #f5a524)", padding: "8px 16px", display: "flex", gap: 12, alignItems: "center", justifyContent: "center" }}>
          <span>FlightDeck <b>{updateInfo.latestVersion}</b> is available.</span>
          <button className="btn ghost small" onClick={() => setView("settings")}>Update in Settings</button>
          <button className="btn ghost small" onClick={() => setUpdateInfo(null)}>Dismiss</button>
        </div>
      )}
      <main className="main">
        {view === "home" && (
          <HomeView
            onSearch={goPlan}
            onOpenSaved={(f) => goPlan(f.flightNumber, f.date)}
            refreshToken={libRefresh}
          />
        )}
        {view === "plan" && (
          <PlanView
            seed={planSeed}
            onBack={() => setView("home")}
            onSaved={() => setLibRefresh((n) => n + 1)}
          />
        )}
        {view === "history" && <HistoryView />}
        {view === "simbrief" && <SimBriefView />}
        {view === "telemetry" && <TelemetryView />}
        {view === "settings" && <SettingsView />}
      </main>
      <footer className="footer">
        FlightDeck is a planning aid. Always verify procedures against current charts and your simulator's navdata before flying.
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flight Plan view
// ---------------------------------------------------------------------------
function PlanView({ seed, onBack, onSaved }: { seed: PlanSeed | null; onBack: () => void; onSaved: () => void }) {
  const [flightNumber, setFlightNumber] = useState(seed?.flightNumber ?? "EI106");
  const [date, setDate] = useState(seed?.date ?? "2026-10-09");
  const [mode, setMode] = useState<"historical" | "current">("historical");
  const [aircraftId, setAircraftId] = useState("");
  const [profiles, setProfiles] = useState<AircraftProfile[]>([]);
  const [windO, setWindO] = useState({ dir: "", spd: "" });
  const [windD, setWindD] = useState({ dir: "", spd: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resp, setResp] = useState<PlanResponse | null>(null);

  useEffect(() => {
    api.aircraft().then((r) => {
      setProfiles(r.profiles);
      const a333 = r.profiles.find((p) => p.icaoType === "A333");
      if (a333) setAircraftId(a333.id);
    }).catch(() => {});
  }, []);

  async function search(fn: string = flightNumber, d: string = date) {
    setLoading(true);
    setError("");
    setResp(null);
    try {
      const wind = (w: { dir: string; spd: string }) =>
        w.dir !== "" && w.spd !== "" ? { directionDeg: Number(w.dir), speedKt: Number(w.spd), source: "manual entry" } : null;
      const r = await api.plan({
        flightNumber: fn, date: d, mode,
        aircraftProfileId: aircraftId || undefined,
        windOrigin: mode === "current" ? wind(windO) : null,
        windDestination: mode === "current" ? wind(windD) : null,
      });
      setResp(r);
      pushRecentLookup({
        flightNumber: r.lookup.flightNumber,
        date: r.lookup.date,
        origin: r.lookup.origin.value?.icao ?? null,
        destination: r.lookup.destination.value?.icao ?? null,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // When opened from the library (or the home search), run the lookup immediately.
  useEffect(() => {
    if (seed) {
      setFlightNumber(seed.flightNumber);
      setDate(seed.date);
      void search(seed.flightNumber, seed.date);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn ghost small" onClick={onBack}>← Library</button>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Flight lookup</h2>
        <div className="sub">Enter a commercial flight number and date. Partial data is shown as-is — unavailable fields are labelled, never filled in.</div>
        <div className="row">
          <div className="field" style={{ marginBottom: 0, minWidth: 150 }}>
            <label>Flight number</label>
            <input value={flightNumber} onChange={(e) => setFlightNumber(e.target.value)} placeholder="EI106" />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 170 }}>
            <label>Date (departure)</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0, minWidth: 220 }}>
            <label>Aircraft profile</label>
            <select value={aircraftId} onChange={(e) => setAircraftId(e.target.value)}>
              <option value="">Auto (from lookup)</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div style={{ minWidth: 300 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Planning mode</label>
              <div className="mode-toggle">
                <button className={mode === "historical" ? "active" : ""} onClick={() => setMode("historical")}>
                  Historical Replay<small>Prefer the recorded route &amp; runways</small>
                </button>
                <button className={mode === "current" ? "active" : ""} onClick={() => setMode("current")}>
                  Current Conditions<small>Best route for today's wind &amp; aircraft</small>
                </button>
              </div>
            </div>
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <button className="btn" onClick={() => void search()} disabled={loading || !flightNumber || !date}>
              {loading ? <><span className="spin" />Planning…</> : "Look up & plan"}
            </button>
          </div>
        </div>
        {mode === "current" && (
          <div className="row mt">
            <div className="field" style={{ marginBottom: 0, minWidth: 130 }}>
              <label>Wind origin (°/kt)</label>
              <div className="row">
                <input style={{ width: 70 }} placeholder="270" value={windO.dir} onChange={(e) => setWindO({ ...windO, dir: e.target.value })} />
                <input style={{ width: 70 }} placeholder="10" value={windO.spd} onChange={(e) => setWindO({ ...windO, spd: e.target.value })} />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0, minWidth: 130 }}>
              <label>Wind destination (°/kt)</label>
              <div className="row">
                <input style={{ width: 70 }} placeholder="280" value={windD.dir} onChange={(e) => setWindD({ ...windD, dir: e.target.value })} />
                <input style={{ width: 70 }} placeholder="8" value={windD.spd} onChange={(e) => setWindD({ ...windD, spd: e.target.value })} />
              </div>
            </div>
            <span className="faint" style={{ alignSelf: "flex-end", paddingBottom: 10 }}>
              Optional — without wind, runways are ranked by suitability only and confidence reflects that.
            </span>
          </div>
        )}
      </div>

      {error && <div className="errbox" style={{ marginBottom: 16 }}>{error}</div>}

      {resp && (
        <PlanResults
          initial={resp}
          header={
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span className="faint">Plan ready — save it to your library to keep it.</span>
              <SaveFlightButton lookup={resp.lookup} plan={resp.plan} onSaved={onSaved} />
            </div>
          }
        />
      )}
    </div>
  );
}

function SaveFlightButton({ lookup, plan, onSaved }: { lookup: FlightLookupResult; plan: FlightPlan; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<Category[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) lib.categories.list().then(setCats).catch(() => setCats([]));
  }, [open ]);

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function save() {
    setSaving(true);
    setError("");
    try {
      await lib.flights.save({
        flightNumber: lookup.flightNumber,
        date: lookup.date,
        origin: lookup.origin.value?.icao ?? null,
        destination: lookup.destination.value?.icao ?? null,
        aircraftType: lookup.aircraftType.value ?? null,
        registration: lookup.registration.value ?? null,
        depRunway: lookup.actualRunwayDeparture.value ?? null,
        arrRunway: lookup.actualRunwayArrival.value ?? null,
        cruiseAltitude: lookup.filedCruiseAltitudeFt.value ?? null,
        routeNames: plan.fixes.map((f) => f.name),
        categoryIds: sel,
        note: note.trim(),
      });
      setOpen(false);
      setSavedTick(true);
      setSel([]);
      setNote("");
      onSaved();
      setTimeout(() => setSavedTick(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the flight.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        {savedTick ? "✓ Saved to library" : "Save flight"}
      </button>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 12, borderColor: "var(--accent)" }}>
      <h2 style={{ fontSize: 15 }}>Save {lookup.flightNumber} <span className="faint">· {lookup.date}</span> to your library</h2>
      {cats.length > 0 && (
        <div className="field">
          <label>Categories</label>
          <div className="catchips">
            {cats.map((c) => (
              <button
                key={c.id}
                className={`catchip${sel.includes(c.id) ? " active" : ""}`}
                onClick={() => toggle(c.id)}
              >
                <span className="dot" style={{ background: c.color }} />
                {c.name}
              </button>
            ))}
          </div>
          <span className="faint" style={{ fontSize: 12 }}>Create categories from the Library home page.</span>
        </div>
      )}
      <div className="field">
        <label>Note (optional)</label>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Great transatlantic for the A330 — fly on VATSIM"
          maxLength={2000}
        />
      </div>
      {error && <div className="errbox" style={{ marginBottom: 8 }}>{error}</div>}
      <div className="row">
        <button className="btn" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save to library"}
        </button>
        <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SimBrief view (Stage 1: read-only OFP import)
// ---------------------------------------------------------------------------
function SimBriefView() {
  const [user, setUser] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ofp, setOfp] = useState<import("@flightdeck/shared-models").SimBriefOfpSummary | null>(null);
  const [notFound, setNotFound] = useState(false);

  async function fetch() {
    setLoading(true); setError(""); setOfp(null); setNotFound(false);
    try {
      const r = await api.simbrief(user || undefined);
      if (r.found && r.ofp) setOfp(r.ofp);
      else setNotFound(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <h2>SimBrief OFP import</h2>
      <div className="sub">
        Read-only import of your latest SimBrief operational flight plan (documented Pilot ID / username fetch).
        Plan <em>generation</em> needs SimBrief developer credentials and is not available here — this view imports only.
      </div>
      <div className="row">
        <div className="field" style={{ marginBottom: 0, minWidth: 240 }}>
          <label>SimBrief username or Pilot ID</label>
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="e.g. 123456" />
        </div>
        <div style={{ alignSelf: "flex-end" }}>
          <button className="btn" onClick={fetch} disabled={loading}>{loading ? "Fetching…" : "Fetch latest OFP"}</button>
        </div>
      </div>
      {error && <div className="errbox mt">{error}</div>}
      {notFound && <div className="warnbox mt">No SimBrief OFP on file for this user. Generate one in SimBrief Dispatch first.</div>}
      {ofp && (
        <div className="mt">
          <div className="kv">
            <dt>Flight</dt><dd>{ofp.flightNumber ?? "—"} {ofp.callsign ? `(${ofp.callsign})` : ""}</dd>
            <dt>Route</dt><dd>{ofp.origin ?? "?"} → {ofp.destination ?? "?"}</dd>
            <dt>Aircraft</dt><dd>{ofp.aircraftType ?? "—"}</dd>
            <dt>SID / STAR</dt><dd>{ofp.sid ?? "—"} / {ofp.star ?? "—"}</dd>
            <dt>Route fixes</dt><dd>{ofp.routeFixes.length > 0 ? ofp.routeFixes.join(" ") : "—"}</dd>
            <dt>Alternate</dt><dd>{ofp.alternate ?? "—"}</dd>
            <dt>AIRAC</dt><dd>{ofp.airacCycle ?? "—"}</dd>
          </div>
          <div className="faint mt" style={{ fontSize: 12 }}>
            Missing fields are shown as — : the fetcher only returns what SimBrief has on file. To use this OFP in the planner, enter its flight number and date in Flight Plan.
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telemetry view — live when the bridge is running, honest when it is not
// ---------------------------------------------------------------------------
interface TelemSample {
  lat: number | null; lon: number | null; altitudeFt: number | null;
  groundspeedKt: number | null; headingDeg: number | null; verticalSpeedFpm: number | null;
  onGround: boolean | null; autopilotMaster: boolean | null; timestamp?: string;
}

function TelemetryView() {
  const [live, setLive] = useState<{ connected: boolean; sample: TelemSample | null }>({ connected: false, sample: null });

  useEffect(() => {
    let stop = false;
    async function poll() {
      try {
        const r = await fetch("/api/telemetry/latest").then((x) => x.json());
        if (!stop) setLive({ connected: !!r.connected, sample: r.sample ?? null });
      } catch { /* bridge/API unreachable: stay in not-connected state */ }
    }
    poll();
    const t = setInterval(poll, 2000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const s = live.sample;
  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <h2>Live simulator telemetry</h2>
      <div className="sub">In-flight assistance: position vs planned route, next waypoint, approach guidance.</div>
      {!live.connected || !s ? (
        <>
          <div className="warnbox">
            <strong>Not connected.</strong>
            <ul>
              <li>The SimConnect bridge (<span className="mono">services/simconnect-bridge</span>) requires Windows + MSFS 2024 and is not running.</li>
              <li>No telemetry is shown rather than simulated telemetry — a fake live map would be worse than none.</li>
            </ul>
          </div>
          <div className="faint mt" style={{ fontSize: 12.5 }}>
            To enable: on your Windows PC, build <span className="mono">services/simconnect-bridge</span> with .NET 8,
            run <span className="mono">FlightDeck.SimConnectBridge.exe</span> alongside MSFS 2024, and point it at this API
            (<span className="mono">http://localhost:8124</span>). See <span className="mono">docs/simconnect.md</span>.
          </div>
        </>
      ) : (
        <div className="kv">
          <dt>Status</dt><dd><span style={{ color: "var(--green)" }}>● Connected</span> <span className="faint">{s.timestamp ?? ""}</span></dd>
          <dt>Position</dt><dd>{s.lat != null ? `${s.lat.toFixed(4)}, ${s.lon?.toFixed(4)}` : "—"}</dd>
          <dt>Altitude</dt><dd>{s.altitudeFt != null ? `${Math.round(s.altitudeFt).toLocaleString()} ft` : "—"}</dd>
          <dt>Groundspeed</dt><dd>{s.groundspeedKt != null ? `${Math.round(s.groundspeedKt)} kt` : "—"}</dd>
          <dt>Heading</dt><dd>{s.headingDeg != null ? `${Math.round(s.headingDeg)}°` : "—"}</dd>
          <dt>Vertical speed</dt><dd>{s.verticalSpeedFpm != null ? `${Math.round(s.verticalSpeedFpm)} fpm` : "—"}</dd>
          <dt>On ground</dt><dd>{s.onGround == null ? "—" : s.onGround ? "Yes" : "No"}</dd>
          <dt>Autopilot</dt><dd>{s.autopilotMaster == null ? "—" : s.autopilotMaster ? "Engaged" : "Off"}</dd>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------
function SettingsView() {
  const [settings, setSettings] = useState<Record<string, string | null>>({});
  const [provider, setProvider] = useState("auto");
  const [key, setKey] = useState("");
  const [simbriefUser, setSimbriefUser] = useState("");
  const [osClientId, setOsClientId] = useState("");
  const [osSecret, setOsSecret] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      setProvider(s.provider ?? "auto");
      setSimbriefUser(s.simbriefUser ?? "");
      setOsClientId(s.openskyClientId ?? "");
    }).catch(() => {});
  }, []);

  async function save() {
    const payload: Record<string, string> = { provider, simbriefUser, openskyClientId: osClientId.trim() };
    if (key.trim()) payload.flightAwareApiKey = key.trim();
    if (osSecret.trim()) payload.openskyClientSecret = osSecret.trim();
    const s = await api.saveSettings(payload);
    setSettings(s);
    setKey("");
    setOsSecret("");
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="card" style={{ maxWidth: 860 }}>
      <h2>Settings</h2>
      <div className="sub">Provider credentials are stored in the local FlightDeck database only — never transmitted anywhere except the provider's own API.</div>
      <div className="field" style={{ maxWidth: 320 }}>
        <label>Flight data provider</label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          <option value="auto">Auto (FlightAware when key set, else fixtures)</option>
          <option value="flightaware">FlightAware AeroAPI</option>
          <option value="fixtures">Offline fixtures</option>
        </select>
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label>FlightAware API key — optional paid add-on {settings.flightAwareKeyConfigured === "yes" && <span style={{ color: "var(--green)" }}>· configured</span>}</label>
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={settings.flightAwareKeyConfigured === "yes" ? "•••••••• (enter to replace)" : "Paste AeroAPI key"} />
        <span className="faint" style={{ fontSize: 12 }}>
          Strictly optional. Historical Replay, planning and MSFS export all work without it via the free OpenSky
          source and your own imports. A key only adds FlightAware as the first-choice source (Standard tier or
          higher for historical data; per-query fees apply).
        </span>
      </div>
      <div className="field" style={{ maxWidth: 420 }}>
        <label>OpenSky API client — free, optional</label>
        <div className="row">
          <input value={osClientId} onChange={(e) => setOsClientId(e.target.value)} placeholder="Client ID" style={{ flex: 1 }} />
          <input type="password" value={osSecret} onChange={(e) => setOsSecret(e.target.value)} placeholder={settings.openskySecretConfigured === "yes" ? "•••••••• secret set" : "Client secret"} style={{ flex: 1 }} />
        </div>
        <span className="faint" style={{ fontSize: 12 }}>
          OpenSky historical data requires a free OpenSky account (no payment): create an API client at
          opensky-network.org and paste the client ID and secret here — anonymous requests are rejected by
          OpenSky. Authenticated quota is 4,000 credits/day. Note: OpenSky tracks only cover the last 30 days.
        </span>
      </div>
      <div className="field" style={{ maxWidth: 320 }}>
        <label>SimBrief username / Pilot ID</label>
        <input value={simbriefUser} onChange={(e) => setSimbriefUser(e.target.value)} placeholder="e.g. 123456" />
      </div>
      <UpdatesSection />
      <div className="row">
        <button className="btn" onClick={save}>Save settings</button>
        {saved && <span style={{ color: "var(--green)" }}>Saved.</span>}
      </div>
    </div>
  );
}

function UpdatesSection() {
  const [st, setSt] = useState<{
    currentVersion: string; feedUrl: string | null; autoCheck: boolean; lastCheck: string | null;
    lastError: string | null; updateAvailable: boolean; latestVersion: string | null;
    notes: string | null; downloadedOk: boolean;
  } | null>(null);
  const [feedUrl, setFeedUrl] = useState("");
  const [autoCheck, setAutoCheck] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () =>
    api.updateStatus().then((s) => {
      setSt(s);
      setFeedUrl(s.feedUrl ?? "");
      setAutoCheck(s.autoCheck);
    }).catch(() => {});

  useEffect(() => { void refresh(); }, []);

  async function saveFeed() {
    setBusy("save");
    setMsg(null);
    try {
      await api.saveSettings({ updateFeedUrl: feedUrl.trim(), updateAutoCheck: autoCheck });
      await refresh();
      setMsg("Update settings saved.");
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy("check");
    setMsg(null);
    try {
      await api.updateCheck();
      await refresh();
    } catch (e) {
      setMsg(`Check failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("download");
    setMsg(null);
    try {
      await api.updateDownload();
      await refresh();
      setMsg("Download verified. Ready to install.");
    } catch (e) {
      setMsg(`Download failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!window.confirm(`Install FlightDeck ${st?.latestVersion} now? The app will restart.`)) return;
    setBusy("apply");
    try {
      await api.updateApply();
      setMsg("Installing — FlightDeck will reopen when the update finishes.");
    } catch (e) {
      setMsg(`Install failed: ${(e as Error).message}`);
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>App updates</h3>
      <div className="sub">
        FlightDeck checks the update feed you configure below. When a newer version is found it downloads
        the installer, verifies its signature hash, and installs it silently — no manual download needed.
        Your saved flights and settings are kept.
      </div>
      <div className="field" style={{ maxWidth: 520 }}>
        <label>Update feed URL (https)</label>
        <input value={feedUrl} onChange={(e) => setFeedUrl(e.target.value)} placeholder="https://example.com/flightdeck/latest.json" />
      </div>
      <div className="row" style={{ alignItems: "center" }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={autoCheck} onChange={(e) => setAutoCheck(e.target.checked)} />
          Check automatically on startup
        </label>
        <button className="btn ghost" onClick={() => void saveFeed()} disabled={busy === "save"}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button className="btn ghost" onClick={() => void check()} disabled={busy === "check" || !st?.feedUrl}>
          {busy === "check" ? "Checking…" : "Check now"}
        </button>
      </div>
      {st && (
        <div className="sub" style={{ marginTop: 8 }}>
          Installed: <b>{st.currentVersion}</b>
          {st.lastCheck && <> · last check {new Date(st.lastCheck).toLocaleString()}</>}
          {st.lastError && <> · <span style={{ color: "var(--red)" }}>{st.lastError}</span></>}
          {!st.feedUrl && <> · <span className="faint">no feed configured — automatic updates are off</span></>}
        </div>
      )}
      {st?.updateAvailable && st.latestVersion && (
        <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
          <span><b>FlightDeck {st.latestVersion}</b> is available.{st.notes ? ` ${st.notes}` : ""}</span>
          {!st.downloadedOk ? (
            <button className="btn" onClick={() => void download()} disabled={busy === "download"}>
              {busy === "download" ? "Downloading…" : "Download update"}
            </button>
          ) : (
            <button className="btn" onClick={() => void apply()} disabled={busy === "apply"}>
              {busy === "apply" ? "Installing…" : "Install & restart"}
            </button>
          )}
        </div>
      )}
      {msg && <div className="sub" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}
