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
        <div>
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
          <RouteString fixes={resp.plan.fixes} />
        </div>
        <div>
          <ProcedurePanel plan={resp.plan} navdata={navdata} onOverride={applyOverride} />
        </div>
      </div>
      <ExportPanel plan={resp.plan} />
      <SimBriefPanel plan={resp.plan} lookup={resp.lookup} />
    </>
  );
}

export function LookupCard({ lookup }: { lookup: FlightLookupResult }) {
  const badge = providerBadge(lookup.provider);
  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="plan-head">
        <div className="plan-ident">{lookup.flightNumber}</div>
        <div className="plan-route">
          {lookup.origin.value?.icao ?? "···"}<span className="arrow">→</span>{lookup.destination.value?.icao ?? "···"}
        </div>
        <span className="faint mono" style={{ fontSize: 13 }}>{lookup.date}</span>
        <span style={{ marginLeft: "auto" }}><ProvBadge provenance={badge.provenance} title={badge.title} /></span>
      </div>
      <dl className="kv">
        <dt>Route</dt>
        <dd>
          <FieldValue field={lookup.origin} format={(a) => `${a.icao} ${a.name}`} />
          <span className="faint">→</span>
          <FieldValue field={lookup.destination} format={(a) => `${a.icao} ${a.name}`} />
        </dd>
        <dt>Scheduled</dt>
        <dd>
          <FieldValue field={lookup.scheduledDeparture} format={fmtUtc} />
          <span className="faint">→</span>
          <FieldValue field={lookup.scheduledArrival} format={fmtUtc} />
        </dd>
        <dt>Actual</dt>
        <dd>
          <FieldValue field={lookup.actualDeparture} format={fmtUtc} />
          <span className="faint">→</span>
          <FieldValue field={lookup.actualArrival} format={fmtUtc} />
        </dd>
        <dt>Runways (actual)</dt>
        <dd>
          <FieldValue field={lookup.actualRunwayDeparture} naText="Not reported" />
          <span className="faint">→</span>
          <FieldValue field={lookup.actualRunwayArrival} naText="Not reported" />
        </dd>
        <dt>Aircraft</dt>
        <dd>
          <FieldValue field={lookup.aircraftType} naText="Not reported" />
          <FieldValue field={lookup.registration} naText="Not reported" />
        </dd>
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
  );
}

export function RouteString({ fixes }: { fixes: FlightLookupResult["filedRoute"]["value"] }) {
  if (!fixes || fixes.length === 0) return null;
  return (
    <div className="mt">
      <div className="sub" style={{ marginBottom: 8 }}>Filed route — fixes without provider coordinates are hatched, not plotted</div>
      <div className="route-strip">
        {fixes.map((f, i) => {
          const isApt = f.type === "origin" || f.type === "destination";
          const noCoords = f.lat == null;
          return (
            <span key={i} className="rs-item">
              {i > 0 && <span className="rs-sep" aria-hidden="true" />}
              <span
                className={`rs-fix${isApt ? " apt" : ""}${noCoords ? " nocoords" : ""}`}
                title={noCoords ? "No coordinates from provider — not plotted" : `${f.lat!.toFixed(4)}, ${f.lon!.toFixed(4)}${f.note ? ` — ${f.note}` : ""}`}
              >
                {f.name}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function ProcedurePanel({
  plan, navdata, onOverride,
}: {
  plan: FlightPlan;
  navdata: Record<string, AirportNavData>;
  onOverride: (slot: string, airportIcao: string, procedureId: string | null, runwayId: string | null) => void;
}) {
  const slots: { key: keyof FlightPlan["procedures"]; label: string; airport: string; kind: "runway" | "SID" | "STAR" | "APPROACH" }[] = [
    { key: "departureRunway", label: "Departure runway", airport: plan.origin.icao, kind: "runway" },
    { key: "sid", label: "SID", airport: plan.origin.icao, kind: "SID" },
    { key: "arrivalRunway", label: "Arrival runway", airport: plan.destination.icao, kind: "runway" },
    { key: "star", label: "STAR", airport: plan.destination.icao, kind: "STAR" },
    { key: "approach", label: "Approach", airport: plan.destination.icao, kind: "APPROACH" },
  ];
  return (
    <div className="card">
      <h2>Procedures</h2>
      <div className="sub">Deterministic selection — hard constraints first, then ranking. Confidence comes from listed evidence only.</div>
      <div className="proc-stack">
        {slots.map((s, i) => (
          <ProcedureCard
            key={s.key}
            phase={i + 1}
            label={s.label}
            rec={plan.procedures[s.key]}
            airport={navdata[s.airport]}
            kind={s.kind}
            overridden={plan.overrides[s.key]}
            onOverride={(pid, rid) => onOverride(s.key, s.airport, pid, rid)}
          />
        ))}
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

export function ProcedureCard({
  phase, label, rec, airport, kind, overridden, onOverride,
}: {
  phase: number;
  label: string;
  rec: ProcedureRecommendation;
  airport?: AirportNavData;
  kind: "runway" | "SID" | "STAR" | "APPROACH";
  overridden?: string;
  onOverride: (procedureId: string | null, runwayId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState("");
  const confColor = rec.confidence.level === "high" ? "var(--green)" : rec.confidence.level === "medium" ? "var(--accent)" : rec.confidence.level === "low" ? "var(--red)" : "var(--text-faint)";
  const display = kind === "runway" ? rec.runway : rec.procedureId;
  const options = !airport ? [] : kind === "runway"
    ? airport.runways.map((r) => ({ id: r.id, label: `${r.id} — ${r.lengthFt.toLocaleString()} ft${r.ils ? " · ILS" : ""}` }))
    : airport.procedures.filter((p) => p.kind === kind).map((p) => ({ id: p.id, label: `${p.id}${p.provenance === "generated" ? " (fixture)" : ""}` }));

  return (
    <div className="proc">
      <div className="proc-top">
        <span className="proc-phase">{phase}</span>
        <div className="proc-head">
          <h3>{label}</h3>
          {overridden && <span className="prov inferred" style={{ marginTop: 3 }}>overridden</span>}
        </div>
        <span className={`prov ${rec.validationStatus === "valid" ? "verified" : rec.validationStatus === "valid_with_warnings" ? "inferred" : rec.validationStatus === "invalid" ? "unavailable" : "generated"}`}>
          {rec.validationStatus.replace(/_/g, " ")}
        </span>
      </div>
      <div className="val">
        {display ?? <span className="none">none selected</span>}
        {kind !== "runway" && rec.transition && <span className="proc-via">via {rec.transition}</span>}
      </div>
      <div className="proc-conf">
        <div className="proc-conf-row">
          <span className="faint">Confidence</span>
          <strong style={{ color: confColor, textTransform: "capitalize" }}>{rec.confidence.level}</strong>
          <span className="faint mono">{rec.confidence.score.toFixed(2)}</span>
        </div>
        <div className="confbar"><i style={{ width: `${rec.confidence.score * 100}%`, background: confColor }} /></div>
      </div>
      <details className="evidence">
        <summary>Why this was chosen ({rec.selectionReasons.length + rec.confidence.evidenceMissing.length} evidence items)</summary>
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
      <div className="mt">
        {!editing ? (
          <button className="btn ghost small" onClick={() => { setEditing(true); setChoice(display ?? ""); }}>Override</button>
        ) : (
          <div className="row">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} style={{ flex: 1, background: "var(--bg-soft)", border: "1px solid var(--line)", color: "var(--text)", borderRadius: 8, padding: "7px 10px" }}>
              <option value="">— none —</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <button className="btn small" onClick={() => { onOverride(kind === "runway" ? null : choice || null, kind === "runway" ? choice || null : null); setEditing(false); }}>Apply</button>
            <button className="btn ghost small" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        )}
      </div>
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

