/**
 * iniBuilds company-route (.fpl) exporter — PROOF OF CONCEPT.
 *
 * Status: NOT verified in-sim. The format below is reconstructed from:
 *  1. The open-source "routefinder-to-inibuilds-.fpl-converter" (GitHub,
 *     targets the iniBuilds A350 — same vendor, same company-route concept).
 *  2. A Microsoft Flight Simulator Forums report (Jan 2025) of a SimBrief
 *     "iniBuilds .fpl" download loading into the DEFAULT A330-300 via the
 *     MCDU company-route field from
 *     `WASM/MSFS2024/microsoft-aircraft-a330/work/flightplans`.
 *
 * What the format carries: airline, flight id, nav cycle, ADEP/ADES/ALTN,
 * cruise altitude, and an ordered waypoint list (ident + coordinates).
 * What it does NOT carry: SIDs, STARs, approaches, runways — those are
 * selected on the MCDU DEPARTURE/ARRIVAL pages after the route loads.
 * (The forum reporter confirmed exactly this: route correct, "No Runways,
 *  No SIDs, nothing".)
 *
 * HONESTY RULES:
 *  - Refuses export when cruise altitude is unknown (never invents one).
 *  - Fixes without coordinates are excluded and reported, never guessed.
 *  - The ALTN line is emitted as `NONE` with a warning when no alternate is
 *    supplied — never invents an alternate airport.
 *  - Every result carries a `poc` warning: do not present this as verified
 *    until it loads in the real simulator.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FlightPlan } from "@flightdeck/shared-models";

export const INIBUILDS_FPL_FORMAT = "inibuilds-company-route-fpl/0.1-poc";

export class FplExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FplExportError";
  }
}

export interface CompanyRouteOptions {
  /** alternate airport ICAO for the ALTN header; null/omitted -> "NONE" + warning */
  alternateIcao?: string | null;
  /** arrival field elevation fallback for the ADES line (ft); default 2700 */
  arrivalAltitudeFt?: number;
}

/** IATA -> ICAO airline codes we know; falls back to the raw letters. */
const AIRLINE_ICAO: Record<string, string> = { EI: "EIN" };

function splitFlightNumber(flightNumber: string): { airline: string; fltid: string } {
  const m = flightNumber.trim().toUpperCase().match(/^([A-Z]{2,3})(\d{1,4}[A-Z]?)$/);
  if (!m) return { airline: "FDN", fltid: "000" };
  return { airline: AIRLINE_ICAO[m[1]] ?? m[1], fltid: m[2] };
}

/** MCDU-safe ident: uppercase alphanumeric, max 10 chars. */
function sanitizeIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10) || "FIX";
}

export interface IniBuildsFplResult {
  fpl: string;
  /** e.g. "KJFKEIDW01.fpl" — entered WITHOUT extension in the MCDU CO ROUTE field */
  filename: string;
  format: string;
  includedFixes: string[];
  excludedFixes: { name: string; reason: string }[];
  warnings: string[];
}

export function exportIniBuildsFpl(plan: FlightPlan, options: CompanyRouteOptions = {}): IniBuildsFplResult {
  if (plan.cruiseAltitudeFt == null) {
    throw new FplExportError("Cruise altitude unknown — refusing to emit a company route with an invented CRUISE.");
  }
  const warnings: string[] = [
    "POC — format reconstructed from community tooling, NOT yet verified in the simulator. Do not claim it loads until tested in MSFS 2024 with the default A330-300.",
    "Company routes carry the en-route waypoints only — SID/STAR/approach/runway are selected on the MCDU DEPARTURE/ARRIVAL pages after loading.",
  ];
  const excludedFixes: { name: string; reason: string }[] = [];
  const includedFixes: string[] = [];

  const adep = plan.origin.icao.toUpperCase();
  const ades = plan.destination.icao.toUpperCase();
  const { airline, fltid } = splitFlightNumber(plan.flightNumber);
  const cruise = Math.round(plan.cruiseAltitudeFt);
  const cycle = plan.navdataCycle && plan.navdataCycle !== "X" ? plan.navdataCycle : "0000";
  const altn = options.alternateIcao?.trim().toUpperCase() || "NONE";
  if (altn === "NONE") warnings.push("No alternate supplied — ALTN emitted as NONE; the MCDU may ignore it.");
  const arrivalAlt = options.arrivalAltitudeFt ?? 2700;

  const enroute = plan.fixes.filter((f) => f.type !== "origin" && f.type !== "destination");
  const lines: string[] = [];
  const seen = new Set<string>();
  const uniqueIdent = (raw: string): string => {
    let ident = sanitizeIdent(raw);
    let n = 1;
    while (seen.has(ident)) ident = `${ident.slice(0, 9)}${n++}`;
    seen.add(ident);
    return ident;
  };

  const o = plan.origin.position;
  const d = plan.destination.position;
  lines.push(`1 ${adep} ADEP 100.000000 ${o.lat.toFixed(6)} ${o.lon.toFixed(6)}`);
  seen.add(adep);
  includedFixes.push(plan.origin.icao);

  for (const fix of enroute) {
    if (fix.lat == null || fix.lon == null) {
      excludedFixes.push({ name: fix.name, reason: "No coordinates — omitted (company-route waypoints require lat/lon)." });
      continue;
    }
    // Type 11 = ordinary waypoint (we carry no navaid frequency data to
    // distinguish VOR/ADF; the MCDU resolves named idents from navdata).
    const ident = uniqueIdent(fix.name);
    lines.push(`11 ${ident} DRCT ${cruise.toFixed(6)} ${fix.lat.toFixed(6)} ${fix.lon.toFixed(6)}`);
    includedFixes.push(fix.name);
  }

  lines.push(`1 ${ades} ADES ${arrivalAlt.toFixed(6)} ${d.lat.toFixed(6)} ${d.lon.toFixed(6)}`);
  seen.add(ades);
  includedFixes.push(plan.destination.icao);

  const header = [
    `AIRLINE ${airline}`,
    `FLTID ${fltid}`,
    `CYCLE ${cycle}`,
    `ADEP ${adep}`,
    `ADES ${ades}`,
    `ALTN ${altn}`,
    `CRUISE ${cruise}`,
    ``,
  ];
  const fpl = header.join("\n") + "\n" + lines.join("\n") + "\n";
  return {
    fpl,
    filename: `${adep}${ades}01.fpl`,
    format: INIBUILDS_FPL_FORMAT,
    includedFixes,
    excludedFixes,
    warnings,
  };
}

/**
 * Locate the default A330-300's company-route folder on a Windows PC.
 * Checks the Steam edition path first, then the Microsoft Store edition.
 * Returns null when neither exists (wrong platform, sim not installed, or
 * the folder was never created).
 */
export function detectA330FlightplansDir(): string | null {
  if (process.platform !== "win32") return null;
  const appdata = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates: string[] = [];
  if (appdata) {
    candidates.push(
      join(appdata, "Microsoft Flight Simulator 2024", "WASM", "MSFS2024", "microsoft-aircraft-a330", "work", "flightplans"),
    );
  }
  if (localAppData) {
    candidates.push(
      join(
        localAppData,
        "Packages",
        "Microsoft.Limitless_8wekyb3d8bbwe",
        "LocalState",
        "WASM",
        "MSFS2024",
        "microsoft-aircraft-a330",
        "work",
        "flightplans",
      ),
    );
  }
  for (const dir of candidates) {
    try {
      if (existsSync(dir)) return dir;
    } catch {
      /* ignore */
    }
  }
  return null;
}
