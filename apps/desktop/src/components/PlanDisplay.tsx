import { useEffect, useState, type ReactNode } from "react";
import { api, download, type PlanResponse, type ParsedPlnLike } from "../api";
import { FieldValue, ProvBadge, fmtUtc } from "./Provenance";
import MapView from "./MapView";
import SimBriefPanel from "./SimBriefPanel";
import type {
  AirportNavData,
  FlightLookupResult,
  FlightPlan,
  ProcedureRecommendation,
  Provenance,
} from "@flightdeck/shared-models";

/** Honest provider badge — never claims "verified" for imported/reconstructed data. */
function providerBadge(provider: string): { provenance: Provenance; title: string } {
  if (provider === "import") return { provenance: "imported", title: "Source: user-imported file" };
  if (provider === "reconstruction")
    return { provenance: "generated", title: "Source: reconstructed reference (not the actual flight)" };
  if (provider === "opensky") return { provenance: "verified", title: "Source: OpenSky Network ADS-B" };
  if (provider === "adsbaero") return { provenance: "verified", title: "Source: adsb.aero free ADS-B archive" };
  return { provenance: "verified", title: `Provider: ${provider}` };
}

/**
 * Shared plan rendering for the Flight Plan and Historical views:
 * lookup card, map, route string, procedures with overrides, PLN export.
 */
export function PlanResults({ initial, header }: { initial: PlanResponse; header?: ReactNode }) {
  const [resp, setResp] = useState(initial);
  const [showTrack, setShowTrack] = useState(true);
  const [navdata, setNavdata] = useState<Record<string, AirportNavData>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    setResp(initial);
    setError("");
  }, [initial]);

  useEffect(() => {
    let stop = false;
    (async () => {
      const nd: Record<string, AirportNavData> = {};
      for (const icao of [resp.plan.origin.icao, resp.plan.destination.icao]) {
        try {
          nd[icao] = await api.navdata(icao);
        } catch {
          /* honest: dropdowns stay empty */
        }
      }
      if (!stop) setNavdata(nd);
    })();
    return () => {
      stop = true;
    };
  }, [resp.plan]);

  async function applyOverride(slot: string, airportIcao: string, procedureId: string | null, runwayId: string | null) {
    try {
      const r = await api.override({ plan: resp.plan, slot, airportIcao, procedureId, runwayId });
      setResp({ ...resp, plan: r.plan });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      {header}
      {error && <div className="errbox" style={{ marginBottom: 16 }}>{error}</div>}
      <LookupCard lookup={resp.lookup} />
      <div className="grid32 mt">
        <div className="map-col">
          <MapView
            fixes={resp.plan.fixes}
            track={showTrack ? (resp.lookup.recordedTrack.value ?? []) : []}
            showTrack={showTrack}
            originName={resp.plan.origin.icao}
            destName={resp.plan.destination.icao}
          />
          <div className="row mt" style={{ justifyContent: "space-between" }}>
            <label className="row dim" style={{ gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={showTrack} onChange={(e) => setShowTrack(e.target.checked)} />
              Show recorded track
              {(resp.lookup.recordedTrack.value?.length ?? 0) === 0 && <span className="faint">(none available)</span>}
            </label>
            <span className="faint mono" style={{ fontSize: 11.5 }}>
              navdata {resp.plan.navdataCycle} · filed vs actual track kept separate
            </span>
          </div>
        </div>
        <div>
          <FlightStages plan={resp.plan} navdata={navdata} onOverride={applyOverride} />
        </div>
      </div>
      <ExportPanel plan={resp.plan} />
      <SimBriefPanel plan={resp.plan} lookup={resp.lookup} />
    </>
  );
}

export function LookupCard({ lookup }: { lookup: FlightLookupResult }) {
  const badge = providerBadge(lookup.provider);
  const origin = lookup.origin.value;
  const dest = lookup.destination.value;
  return (
    <div className="card bp" style={{ marginBottom: 18 }}>
      <div className="bp-head">
        <div className="bp-airline">
          <span className="bp-mark">FD</span>
          <span className="bp-airline-name">FLIGHTDECK</span>
          <span className="bp-airline-sub">MSFS 2024</span>
        </div>
        <div className="bp-flight">
          <span>{lookup.flightNumber}</span>
          <span>{lookup.date}</span>
          <ProvBadge provenance={badge.provenance} title={badge.title} />
        </div>
      </div>
      <div className="bp-route">
        <div className="bp-apt">
          <span className="bp-code">{origin?.icao ?? "···"}</span>
          <span className="bp-name">{origin?.name ?? "Unknown origin"}</span>
        </div>
        <div className="bp-arrow" aria-hidden="true">→</div>
        <div className="bp-apt">
          <span className="bp-code">{dest?.icao ?? "···"}</span>
          <span className="bp-name">{dest?.name ?? "Unknown destination"}</span>
        </div>
      </div>
      <div className="bp-grid">
        <div className="bp-cell">
          <div className="bp-label">Scheduled</div>
          <div className="bp-value"><FieldValue field={lookup.scheduledDeparture} format={fmtUtc} /></div>
        </div>
        <div className="bp-cell">
          <div className="bp-label">Actual</div>
          <div className="bp-value"><FieldValue field={lookup.actualDeparture} format={fmtUtc} /></div>
        </div>
        <div className="bp-cell">
          <div className="bp-label">Runways</div>
          <div className="bp-value">
            <FieldValue field={lookup.actualRunwayDeparture} naText="—" />
            <span className="faint"> → </span>
            <FieldValue field={lookup.actualRunwayArrival} naText="—" />
          </div>
        </div>
        <div className="bp-cell">
          <div className="bp-label">Aircraft</div>
          <div className="bp-value">
            <FieldValue field={lookup.aircraftType} naText="—" />
            {lookup.registration.value && (
              <span className="faint"> · {lookup.registration.value}</span>
            )}
          </div>
        </div>
      </div>
      <div className="bp-perf" aria-hidden="true" />
      <div className="bp-stub">
        <dl className="kv">
          <dt>Cruise (filed)</dt>
          <dd><FieldValue field={lookup.filedCruiseAltitudeFt} format={(v) => `${v.toLocaleString()} ft`} /></dd>
          <dt>Filed route</dt>
          <dd>
            {lookup.filedRoute.value ? (
              <span className="row" style={{ gap: 8 }}>
                <span>{lookup.filedRoute.value.length} fixes</span>
                <ProvBadge provenance={lookup.filedRoute.provenance} title={lookup.filedRoute.note} />
              </span>
            ) : <FieldValue field={lookup.filedRoute} naText="No filed route from provider" />}
          </dd>
          <dt>Recorded track</dt>
          <dd>
            {lookup.recordedTrack.value ? (
              <span className="row" style={{ gap: 8 }}>
                <span>{lookup.recordedTrack.value.length} positions</span>
                <ProvBadge provenance="verified" title="Provider: recorded ADS-B/radar track" />
              </span>
            ) : <FieldValue field={lookup.recordedTrack} naText="No recorded track from provider" />}
          </dd>
        </dl>
        {lookup.warnings.length > 0 && (
          <div className="warnbox mt">
            <strong>Notes</strong>
            <ul>{lookup.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          </div>
        )}
      </div>
    </div>
  );
}
/**
 * Flight stages: the plan as three stages of the flight — departure, enroute,
 * arrival — instead of a flat technical list. Each selection shows its
 * confidence and the reasoning behind it; overrides stay one click away.
 */
export function FlightStages({
  plan, navdata, onOverride,
}: {
  plan: FlightPlan;
  navdata: Record<string, AirportNavData>;
  onOverride: (slot: string, airportIcao: string, procedureId: string | null, runwayId: string | null) => void;
}) {
  const enroute = plan.fixes.filter((f) => f.type !== "origin" && f.type !== "destination");
  const ov = (slot: keyof FlightPlan["procedures"], airportIcao: string) =>
    (pid: string | null, rid: string | null) => onOverride(slot, airportIcao, pid, rid);
  return (
    <div className="card">
      <h2>Flight plan</h2>
      <div className="sub">Gate to gate, in three stages. Every selection is deterministic — the reasoning behind each one is listed, never hidden.</div>
      <div className="stages">
        <Stage n={1} phase="Departure" airport={`${plan.origin.icao} · ${plan.origin.name}`}>
          <StageProcedure
            label="Runway" rec={plan.procedures.departureRunway} kind="runway"
            airport={navdata[plan.origin.icao]} airportIcao={plan.origin.icao}
            runway={plan.procedures.departureRunway.runway} overridden={plan.overrides.departureRunway}
            onOverride={ov("departureRunway", plan.origin.icao)}
          />
          <StageProcedure
            label="SID" rec={plan.procedures.sid} kind="SID"
            airport={navdata[plan.origin.icao]} airportIcao={plan.origin.icao}
            runway={plan.procedures.departureRunway.runway} overridden={plan.overrides.sid}
            onOverride={ov("sid", plan.origin.icao)}
          />
        </Stage>
        <Stage n={2} phase="Enroute" airport={plan.cruiseAltitudeFt != null ? `Cruise FL${Math.round(plan.cruiseAltitudeFt / 100)}` : undefined}>
          <div className="stage-line">
            <span className="stage-big">{enroute.length}</span>
            <span className="stage-big-sub">enroute fixes, {plan.origin.icao} → {plan.destination.icao}</span>
          </div>
          <EnrouteFixes fixes={enroute} />
        </Stage>
        <Stage n={3} phase="Arrival" airport={`${plan.destination.icao} · ${plan.destination.name}`}>
          <StageProcedure
            label="STAR" rec={plan.procedures.star} kind="STAR"
            airport={navdata[plan.destination.icao]} airportIcao={plan.destination.icao}
            runway={plan.procedures.arrivalRunway.runway} overridden={plan.overrides.star}
            onOverride={ov("star", plan.destination.icao)}
          />
          <StageProcedure
            label="Approach" rec={plan.procedures.approach} kind="APPROACH"
            airport={navdata[plan.destination.icao]} airportIcao={plan.destination.icao}
            runway={plan.procedures.arrivalRunway.runway} overridden={plan.overrides.approach}
            onOverride={ov("approach", plan.destination.icao)}
          />
          <StageProcedure
            label="Runway" rec={plan.procedures.arrivalRunway} kind="runway"
            airport={navdata[plan.destination.icao]} airportIcao={plan.destination.icao}
            runway={plan.procedures.arrivalRunway.runway} overridden={plan.overrides.arrivalRunway}
            onOverride={ov("arrivalRunway", plan.destination.icao)}
          />
        </Stage>
      </div>
      {plan.warnings.length > 0 && (
        <div className="warnbox mt">
          <strong>Plan warnings</strong>
          <ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function Stage({ n, phase, airport, children }: { n: number; phase: string; airport?: string; children: ReactNode }) {
  return (
    <div className="stage">
      <span className="stage-node" aria-hidden="true">{n}</span>
      <div className="stage-head">
        <span className="stage-phase">{phase}</span>
        {airport && <span className="stage-apt">{airport}</span>}
      </div>
      <div className="stage-body">{children}</div>
    </div>
  );
}

function ConfidencePill({ level }: { level: string }) {
  const cls = level === "high" ? "high" : level === "medium" ? "medium" : level === "low" ? "low" : "unknown";
  const label = level === "high" ? "High confidence" : level === "medium" ? "Medium confidence" : level === "low" ? "Low confidence" : "Confidence unknown";
  return <span className={`conf ${cls}`}>{label}</span>;
}

function ValidationPill({ status }: { status: string }) {
  if (status === "valid") return <span className="prov verified">Valid</span>;
  if (status === "valid_with_warnings") return <span className="prov inferred">Valid with warnings</span>;
  if (status === "invalid") return <span className="prov unavailable">Invalid</span>;
  return <span className="prov generated">Unchecked</span>;
}

function StageProcedure({
  label, rec, kind, airport, airportIcao, runway, overridden, onOverride,
}: {
  label: string;
  rec: ProcedureRecommendation;
  kind: "runway" | "SID" | "STAR" | "APPROACH";
  airport?: AirportNavData;
  airportIcao: string;
  runway: string | null;
  overridden?: string;
  onOverride: (procedureId: string | null, runwayId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualTransition, setManualTransition] = useState("");
  const [manualApproachKind, setManualApproachKind] = useState("ILS");
  const [teachError, setTeachError] = useState("");
  const [saving, setSaving] = useState(false);
  const display = kind === "runway" ? rec.runway : rec.procedureId;
  const isSynthetic = kind !== "runway" && (!display || rec.warnings.some((w) => w.includes("synthetic fixture")));
  const options = !airport ? [] : kind === "runway"
    ? airport.runways.map((r) => ({ id: r.id, label: `${r.id} — ${r.lengthFt.toLocaleString()} ft${r.ils ? " · ILS" : ""}` }))
    : airport.procedures.filter((p) => p.kind === kind).map((p) => ({
        id: p.id,
        label: `${p.id}${p.provenance === "generated" ? " (fixture)" : ""}${p.note === "Entered by you from the simulator's EFB procedure list." ? " (saved)" : ""}`,
      }));
  const evidenceCount = rec.selectionReasons.length + rec.confidence.evidenceMissing.length;

  async function applyChange() {
    const taught = manualName.trim().toUpperCase();
    if (taught && kind !== "runway") {
      if (!runway) { setTeachError("No runway selected for this stage yet."); return; }
      setSaving(true);
      setTeachError("");
      try {
        await api.userProcedures.save({
          icao: airportIcao,
          runway,
          kind,
          name: taught,
          transition: kind === "APPROACH" ? null : (manualTransition.trim().toUpperCase() || null),
          approachKind: kind === "APPROACH" ? manualApproachKind : null,
        });
        onOverride(taught, null);
        setEditing(false);
      } catch (e) {
        setTeachError((e as Error).message);
      } finally {
        setSaving(false);
      }
      return;
    }
    onOverride(kind === "runway" ? null : choice || null, kind === "runway" ? choice || null : null);
    setEditing(false);
  }

  return (
    <div className="sproc">
      <div className="sproc-top">
        <span className="sproc-label">{label}</span>
        {overridden && <span className="prov inferred">changed</span>}
        <span className="sproc-status">
          <ConfidencePill level={rec.confidence.level} />
          <ValidationPill status={rec.validationStatus} />
        </span>
      </div>
      <div className="sproc-val">
        {display ?? <span className="none">none selected</span>}
        {kind !== "runway" && rec.transition && <span className="proc-via">via {rec.transition}</span>}
      </div>
      <details className="evidence">
        <summary>Why this was chosen{evidenceCount > 0 ? ` (${evidenceCount})` : ""}</summary>
        {rec.selectionReasons.length > 0 && <>
          <div className="for" style={{ fontWeight: 700, marginTop: 6 }}>Supporting</div>
          <ul>{rec.selectionReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </>}
        {rec.confidence.evidenceAgainst.length > 0 && <>
          <div className="against" style={{ fontWeight: 700 }}>Against</div>
          <ul>{rec.confidence.evidenceAgainst.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </>}
        {rec.confidence.evidenceMissing.length > 0 && <>
          <div className="missing" style={{ fontWeight: 700 }}>Unknown</div>
          <ul>{rec.confidence.evidenceMissing.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </>}
        {rec.warnings.length > 0 && <>
          <div style={{ fontWeight: 700, marginTop: 4 }}>Warnings</div>
          <ul>{rec.warnings.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </>}
      </details>
      {isSynthetic && (
        <div className="teach-hint">
          Not a published procedure — the EFB will show <b>None</b>. Hit <b>Change</b>, enter the
          exact name from your simulator's EFB (<b>ADD ARRIVAL</b> / <b>ADD APPROACH</b>), and
          FlightDeck remembers it for {airportIcao}{runway ? ` runway ${runway}` : ""}.
        </div>
      )}
      {!editing ? (
        <button className="change-link" onClick={() => { setEditing(true); setChoice(display ?? ""); setManualName(""); setManualTransition(""); setTeachError(""); }}>Change</button>
      ) : (
        <div className="mt">
          <div className="row">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} style={{ flex: 1 }} aria-label={`${label} procedure`}>
              <option value="">— none —</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <button className="btn small" disabled={saving} onClick={() => void applyChange()}>Apply</button>
            <button className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          {kind !== "runway" && (
            <div className="teach-box">
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Or enter the exact name from your simulator's EFB</label>
                <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder={kind === "SID" ? "e.g. MERIT3" : kind === "STAR" ? "e.g. BAGSO1L" : "e.g. ILS28L"} style={{ textTransform: "uppercase" }} />
              </div>
              <div className="row">
                {kind === "APPROACH" ? (
                  <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                    <label>Type</label>
                    <select value={manualApproachKind} onChange={(e) => setManualApproachKind(e.target.value)}>
                      {["ILS", "RNAV", "VOR", "NDB", "VISUAL", "OTHER"].map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                ) : (
                  <div className="field" style={{ marginBottom: 0, flex: 1 }}>
                    <label>Transition (optional)</label>
                    <input value={manualTransition} onChange={(e) => setManualTransition(e.target.value)} placeholder="e.g. BAGSO" style={{ textTransform: "uppercase" }} />
                  </div>
                )}
              </div>
              <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
                In the sim: EFB → <b>ADD ARRIVAL</b> / <b>ADD APPROACH</b> lists the real procedures.
                Saved for {airportIcao}{runway ? ` runway ${runway}` : ""} and reused automatically.
              </div>
            </div>
          )}
          {teachError && <div className="errbox mt">{teachError}</div>}
        </div>
      )}
    </div>
  );
}

function EnrouteFixes({ fixes }: { fixes: FlightPlan["fixes"] }) {
  const [open, setOpen] = useState(false);
  if (fixes.length === 0) return <div className="faint">No enroute fixes in this plan.</div>;
  return (
    <div>
      <button className="change-link" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide fixes" : `Show all ${fixes.length} fixes`}
      </button>
      {open && (
        <div className="route-strip mt">
          {fixes.map((f, i) => {
            const noCoords = f.lat == null;
            return (
              <span key={i} className="rs-item">
                {i > 0 && <span className="rs-sep" aria-hidden="true" />}
                <span
                  className={`rs-fix${noCoords ? " nocoords" : ""}`}
                  title={noCoords ? "No coordinates from provider — not plotted" : `${f.lat!.toFixed(4)}, ${f.lon!.toFixed(4)}${f.note ? ` — ${f.note}` : ""}`}
                >
                  {f.name}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExportPanel({ plan }: { plan: FlightPlan }) {
  const [result, setResult] = useState<{ xml: string; includedFixes: string[]; excludedFixes: { name: string; reason: string }[]; warnings: string[] } | null>(null);
  const [error, setError] = useState("");
  const [imported, setImported] = useState<ParsedPlnLike | null>(null);

  async function doExport() {
    setError("");
    try {
      const r = await api.exportPln(plan, `${plan.flightNumber} ${plan.origin.icao} to ${plan.destination.icao}`);
      setResult(r);
      download(`${plan.flightNumber}_${plan.origin.icao}-${plan.destination.icao}.pln`, r.xml);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function doImport(file: File) {
    setError("");
    try {
      const xml = await file.text();
      const p = await api.importPln(xml);
      setImported(p);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card mt">
      <h2>MSFS 2024 EFB flight plan</h2>
      <div className="sub">Official EFB PLN XML (AppVersionMajor 12). Fixes without coordinates are excluded and listed — never guessed.</div>
      <div className="row">
        <button className="btn" onClick={doExport}>Export .pln</button>
        <label className="btn ghost" style={{ cursor: "pointer" }}>
          Import .pln
          <input type="file" accept=".pln,.xml" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        </label>
      </div>
      {error && <div className="errbox mt">{error}</div>}
      {result && (
        <div className="mt">
          <div className="kv">
            <dt>Included fixes</dt><dd>{result.includedFixes.length > 0 ? result.includedFixes.join(", ") : "—"}</dd>
            <dt>Excluded fixes</dt>
            <dd>
              {result.excludedFixes.length === 0 ? "—" : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.excludedFixes.map((f, i) => <li key={i}><strong>{f.name}</strong>: {f.reason}</li>)}
                </ul>
              )}
            </dd>
          </div>
          {result.warnings.length > 0 && (
            <div className="warnbox mt"><strong>Export notes</strong>
              <ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {imported && (
        <div className="mt">
          <h2 style={{ fontSize: 14 }}>Imported plan</h2>
          <div className="kv">
            <dt>Title</dt><dd>{imported.title ?? "—"}</dd>
            <dt>Route</dt><dd>{imported.departureId ?? "?"} → {imported.destinationId ?? "?"}</dd>
            <dt>Runways</dt><dd>{imported.departureRunway ?? "—"} → {imported.approachRunway ?? imported.arrivalRunway ?? "—"}</dd>
            <dt>SID / STAR</dt><dd>{imported.departureSid ?? "—"} / {imported.arrivalStar ?? "—"}</dd>
            <dt>Approach</dt><dd>{imported.approachType ?? "—"}</dd>
            <dt>Cruise</dt><dd>{imported.cruisingAltFt != null ? `${imported.cruisingAltFt.toLocaleString()} ft` : "—"}</dd>
            <dt>Fixes</dt><dd>{imported.fixes.length}</dd>
          </div>
          {imported.warnings.length > 0 && (
            <div className="warnbox mt"><ul>{imported.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
          )}
        </div>
      )}
    </div>
  );
}

