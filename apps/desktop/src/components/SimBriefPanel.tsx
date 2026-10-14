import { useMemo, useState } from "react";
import type { FlightLookupResult, FlightPlan } from "@flightdeck/shared-models";
import { buildSimBriefRoute, buildSimBriefUrl } from "../simbrief";

async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * "Get this route into your aircraft" — the MSFS 2024 EFB cannot feed the
 * iniBuilds A330's FMGC and SimConnect can't inject a flight plan, so the
 * working path is SimBrief OFP -> MCDU INIT REQUEST -> NAV. This panel removes
 * every transcription step: one click opens SimBrief with the dispatch form
 * prefilled from the plan (airline, flight number, airports, aircraft type,
 * cruise level, exact DCT route).
 */
export default function SimBriefPanel({ plan, lookup }: { plan: FlightPlan; lookup: FlightLookupResult }) {
  const [copied, setCopied] = useState<string | null>(null);
  const sb = useMemo(
    () => buildSimBriefRoute(plan.origin.icao, plan.destination.icao, plan.fixes),
    [plan.origin.icao, plan.destination.icao, plan.fixes],
  );
  const url = useMemo(
    () =>
      buildSimBriefUrl({
        flightNumber: plan.flightNumber,
        origin: plan.origin.icao,
        destination: plan.destination.icao,
        aircraftType: lookup.aircraftType.value,
        cruiseAltitudeFt: plan.cruiseAltitudeFt,
        route: sb.route,
      }),
    [plan, lookup.aircraftType.value, sb.route],
  );

  async function doCopy(text: string, key: string) {
    setCopied((await copyText(text)) ? key : null);
    if (key) window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
  }

  return (
    <div className="card mt">
      <h2>Get this route into your aircraft</h2>
      <div className="sub">
        The MSFS 2024 EFB can't load a flight plan into the iniBuilds A330's flight computer — but the MCDU can pull
        it from SimBrief. One click opens SimBrief with everything below prefilled; generate the OFP, then in the
        sim use the MCDU's <b>INIT REQUEST</b> (don't pre-select the destination on the world map, or it won't appear).
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <a className="btn" href={url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
          Open in SimBrief
        </a>
        <button className="btn ghost" onClick={() => void doCopy(sb.route, "route")}>
          {copied === "route" ? "Copied ✓" : "Copy route string"}
        </button>
      </div>
      <div className="sb-route mono">{sb.route}</div>
      {sb.skipped.length > 0 && (
        <div className="faint mt" style={{ fontSize: 12 }}>
          Not in the route string (no provider coordinates): {sb.skipped.join(", ")}
        </div>
      )}
      <ol className="sb-steps">
        <li><b>Generate</b> the OFP in SimBrief (pick your A330 airframe).</li>
        <li>In the A330: MCDU → <b>INIT → INIT REQUEST</b> to pull the flight plan in.</li>
        <li>Select SID/STAR/approach on the MCDU <b>DEPARTURE/ARRIVAL</b> pages.</li>
        <li>After takeoff: AP on, push the HDG knob → <b>NAV</b> — the flight director follows your route.</li>
      </ol>
      {sb.mcduEntries.length > 0 && (
        <details className="evidence mt">
          <summary>Manual fallback — MCDU lat/long entries ({sb.mcduEntries.length})</summary>
          <div className="row" style={{ margin: "8px 0" }}>
            <button className="btn ghost small" onClick={() => void doCopy(sb.mcduEntries.map((e) => e.entry).join("\n"), "mcdu")}>
              {copied === "mcdu" ? "Copied ✓" : "Copy all"}
            </button>
          </div>
          <div className="mcdu-list mono">
            {sb.mcduEntries.map((e) => (
              <div key={e.name} className="mcdu-row">
                <span className="faint">{e.name}</span>
                <span>{e.entry}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
