/**
 * MSFS 2024 EFB Flight Plan XML (.pln) serializer + parser (Feature D).
 *
 * Implements the OFFICIAL MSFS 2024 SDK "EFB Flight Plan XML (PLN File)
 * Properties" spec (docs.flightsimulator.com/msfs2024). This is NOT the
 * legacy FSX/MSFS2020 mission PLN — the two are mutually incompatible.
 * See research/api-research.md (Target 3) for the verified schema and the
 * known SDK documentation errors.
 *
 * HONESTY RULES enforced here:
 *  - En-route fixes are emitted as `User` waypoints with provider coordinates
 *    (the SDK documents exactly this for fixes whose navdata identity we
 *    cannot verify — e.g. oceanic points). We never emit a navdata fix type
 *    with invented ARINC region codes.
 *  - Fixes WITHOUT coordinates are EXCLUDED from the file and listed in
 *    `excludedFixes` with a reason — never silently dropped, never guessed.
 *  - Procedure names are emitted ONLY when the procedure's provenance in the
 *    selected navdata cycle is verified/inferred. Synthetic fixture procedure
 *    names are omitted with a warning (the EFB matches names against the
 *    sim's own navdata at load; a fixture name would fail silently).
 *  - CruisingAlt is required by the spec; when unknown the export REFUSES
 *    rather than inventing an altitude.
 */
import type { FlightPlan, MsfsExportResult, Procedure, RouteFix } from "@flightdeck/shared-models";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

export const EFB_PLN_FORMAT = "msfs2024-efb-pln/1.0";

export class PlnExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlnExportError";
  }
}

export interface ExportOptions {
  title?: string;
  description?: string;
}

const APPROACH_TYPE_MAP: Record<string, string> = {
  ILS: "ILS",
  RNAV: "RNAV",
  VOR: "VOR",
  NDB: "NDB",
};

/** "31L" -> { number: 31, designator: "LEFT" } ; "04" -> { number: 4 } */
export function splitRunway(runway: string): { number: number; designator?: string } {
  const m = runway.trim().toUpperCase().match(/^(\d{1,2})([LCR]?)$/);
  if (!m) throw new PlnExportError(`Cannot encode runway "${runway}" for EFB PLN.`);
  const designator = m[2] === "L" ? "LEFT" : m[2] === "C" ? "CENTER" : m[2] === "R" ? "RIGHT" : undefined;
  return designator ? { number: parseInt(m[1], 10), designator } : { number: parseInt(m[1], 10) };
}

/** decimal degrees -> `N40° 38' 29.94"` */
export function formatDms(value: number, isLat: boolean): string {
  const hemi = isLat ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  const degStr = isLat ? String(deg).padStart(2, "0") : String(deg).padStart(3, "0");
  return `${hemi}${degStr}° ${String(min).padStart(2, "0")}' ${sec.toFixed(2).padStart(5, "0")}"`;
}

/** `N40° 38' 29.94",W73° 46' 44.85",+000013.00` */
export function formatWorldPosition(lat: number, lon: number, altFt: number | null): string {
  const alt = altFt == null ? "" : `,${altFt < 0 ? "-" : "+"}${Math.abs(altFt).toFixed(2).padStart(9, "0")}`;
  return `${formatDms(lat, true)},${formatDms(lon, false)}${alt}`;
}

/** Parse a WorldPosition back to decimal degrees. Returns null when unparsable. */
export function parseWorldPosition(s: string): { lat: number; lon: number; altFt: number | null } | null {
  const m = s.match(
    /([NS])(\d{1,3})°\s*(\d{1,2})'\s*([\d.]+)",\s*([EW])(\d{1,3})°\s*(\d{1,2})'\s*([\d.]+)"(?:,\s*([+-])([\d.]+))?/,
  );
  if (!m) return null;
  const lat = (parseInt(m[2], 10) + parseInt(m[3], 10) / 60 + parseFloat(m[4]) / 3600) * (m[1] === "N" ? 1 : -1);
  const lon = (parseInt(m[6], 10) + parseInt(m[7], 10) / 60 + parseFloat(m[8]) / 3600) * (m[5] === "E" ? 1 : -1);
  const altFt = m[9] ? parseFloat(m[10]) * (m[9] === "+" ? 1 : -1) : null;
  return { lat, lon, altFt };
}

export interface ExportContext {
  /** resolve a procedure id to its full record for provenance checks */
  findProcedure: (id: string | null) => Procedure | null;
}

/**
 * Decide whether a procedure NAME may be written into the PLN.
 * Only names verified against the selected navdata cycle survive; synthetic
 * fixture names are omitted with an explanatory warning.
 */
function emittableProcedureName(
  procedureId: string | null,
  ctx: ExportContext,
  warnings: string[],
  kindLabel: string,
): string | null {
  if (!procedureId) return null;
  const proc = ctx.findProcedure(procedureId);
  if (!proc) {
    warnings.push(`${kindLabel} "${procedureId}" not found in navdata — omitted from export.`);
    return null;
  }
  if (proc.provenance === "generated") {
    warnings.push(
      `${kindLabel} "${procedureId}" is synthetic fixture data (not a published procedure) — omitted from export. Add the real procedure in the EFB.`,
    );
    return null;
  }
  return proc.id;
}

export function exportMsfs2024Pln(plan: FlightPlan, ctx: ExportContext, options: ExportOptions = {}): MsfsExportResult {
  if (plan.cruiseAltitudeFt == null) {
    throw new PlnExportError(
      "Cruising altitude is unknown — the EFB PLN spec requires <CruisingAlt>. Export refused rather than inventing an altitude.",
    );
  }
  const warnings: string[] = [];
  const excludedFixes: { name: string; reason: string }[] = [];

  // En-route fixes: origin/destination are covered by DepartureID/DestinationID.
  const enroute = plan.fixes.filter((f) => f.type !== "origin" && f.type !== "destination");
  const seenIdents = new Set<string>();
  const waypoints: Record<string, unknown>[] = [];
  const includedFixes: string[] = [];

  for (const fix of enroute) {
    if (fix.lat == null || fix.lon == null) {
      excludedFixes.push({
        name: fix.name,
        reason: "Provider supplied no coordinates — omitted from the PLN (EFB User waypoints require coordinates).",
      });
      continue;
    }
    let ident = fix.name.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8) || "FIX";
    let n = 1;
    while (seenIdents.has(ident)) ident = `${ident.slice(0, 7)}${n++}`;
    seenIdents.add(ident);
    waypoints.push({
      ATCWaypointType: "User",
      WorldPosition: formatWorldPosition(fix.lat, fix.lon, plan.cruiseAltitudeFt),
      ICAO: { ICAOIdent: ident },
    });
    includedFixes.push(fix.name);
  }
  if (waypoints.length === 0) {
    warnings.push("No en-route fixes with coordinates — the PLN contains airports and procedures only.");
  }

  const p = plan.procedures;
  const fp: Record<string, unknown> = {
    Title: options.title ?? `${plan.origin.icao} to ${plan.destination.icao}`,
    Descr: options.description ?? `FlightDeck ${plan.flightNumber} ${plan.origin.icao}-${plan.destination.icao} (${plan.date})`,
    FPType: "IFR",
    CruisingAlt: plan.cruiseAltitudeFt,
    DepartureID: plan.origin.icao,
    DestinationID: plan.destination.icao,
    AppVersion: { AppVersionMajor: 12 },
  };

  // Departure details
  if (p.departureRunway.runway) {
    try {
      const r = splitRunway(p.departureRunway.runway);
      const sidName = emittableProcedureName(p.sid.procedureId, ctx, warnings, "SID");
      const dd: Record<string, unknown> = { RunwayNumberFP: r.number };
      if (r.designator) dd["RunwayDesignatorFP"] = r.designator;
      if (sidName) {
        dd["DepartureFP"] = sidName;
        if (p.sid.transition) dd["TransitionFP"] = p.sid.transition;
      }
      fp["DepartureDetails"] = dd;
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  // Arrival details
  if (p.arrivalRunway.runway) {
    try {
      const r = splitRunway(p.arrivalRunway.runway);
      const starName = emittableProcedureName(p.star.procedureId, ctx, warnings, "STAR");
      const ad: Record<string, unknown> = { RunwayNumberFP: r.number };
      if (r.designator) ad["RunwayDesignatorFP"] = r.designator;
      if (starName) {
        ad["ArrivalFP"] = starName;
        if (p.star.transition) ad["TransitionFP"] = p.star.transition;
      }
      fp["ArrivalDetails"] = ad;
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  // Approach details
  if (p.approach.procedureId && p.approach.runway) {
    const proc = ctx.findProcedure(p.approach.procedureId);
    const approachKind = proc?.approachKind ?? null;
    const efbType = approachKind ? APPROACH_TYPE_MAP[approachKind] : null;
    if (!efbType) {
      warnings.push(
        `Approach "${p.approach.procedureId}" has kind ${approachKind ?? "unknown"} — no EFB mapping; approach omitted.`,
      );
    } else if (proc && proc.provenance === "generated") {
      warnings.push(
        `Approach "${p.approach.procedureId}" is synthetic fixture data — omitted from export. Select the real approach in the EFB.`,
      );
    } else {
      try {
        const r = splitRunway(p.approach.runway);
        const apd: Record<string, unknown> = { ApproachTypeFP: efbType, RunwayNumberFP: r.number };
        if (r.designator) apd["RunwayDesignatorFP"] = r.designator;
        if (p.approach.transition) apd["TransitionFP"] = p.approach.transition;
        fp["ApproachDetails"] = apd;
      } catch (e) {
        warnings.push((e as Error).message);
      }
    }
  }

  if (waypoints.length > 0) fp["ATCWaypoint"] = waypoints;

  const builder = new XMLBuilder({ ignoreAttributes: false, format: true, suppressEmptyNode: true });
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    builder.build({ "SimBase.Document": { "FlightPlan.FlightPlan": fp } });

  return { xml, format: EFB_PLN_FORMAT, includedFixes, excludedFixes, warnings };
}

// ---------------------------------------------------------------------------
// Import: parse an EFB PLN back into a partial FlightPlan
// ---------------------------------------------------------------------------
export interface ParsedPln {
  title: string | null;
  description: string | null;
  fpType: string | null;
  cruisingAltFt: number | null;
  departureId: string | null;
  destinationId: string | null;
  departureRunway: string | null;
  departureSid: string | null;
  departureTransition: string | null;
  arrivalRunway: string | null;
  arrivalStar: string | null;
  arrivalTransition: string | null;
  approachType: string | null;
  approachRunway: string | null;
  fixes: RouteFix[];
  warnings: string[];
}

export function parseMsfs2024Pln(xml: string): ParsedPln {
  const warnings: string[] = [];
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    throw new PlnExportError(`Not a parseable PLN XML file: ${(e as Error).message}`);
  }
  const root = doc["SimBase.Document"] as Record<string, unknown> | undefined;
  const fp = root?.["FlightPlan.FlightPlan"] as Record<string, unknown> | undefined;
  if (!fp) throw new PlnExportError("Not an EFB flight plan: missing SimBase.Document/FlightPlan.FlightPlan.");

  const appMajor = (fp["AppVersion"] as Record<string, unknown> | undefined)?.["AppVersionMajor"];
  if (appMajor != null && Number(appMajor) < 12)
    warnings.push(`AppVersionMajor is ${appMajor} (< 12) — this looks like a legacy PLN, not an MSFS 2024 EFB plan.`);

  const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
  const runwayOf = (d: Record<string, unknown> | undefined): string | null => {
    if (!d) return null;
    const num = str(d["RunwayNumberFP"]);
    if (!num) return null;
    const des = str(d["RunwayDesignatorFP"]);
    const suffix = des === "LEFT" ? "L" : des === "RIGHT" ? "R" : des === "CENTER" ? "C" : "";
    return `${num.padStart(2, "0")}${suffix}`;
  };

  const dep = fp["DepartureDetails"] as Record<string, unknown> | undefined;
  const arr = fp["ArrivalDetails"] as Record<string, unknown> | undefined;
  const app = fp["ApproachDetails"] as Record<string, unknown> | undefined;

  const rawWps = fp["ATCWaypoint"];
  const wps = rawWps == null ? [] : Array.isArray(rawWps) ? rawWps : [rawWps];
  const fixes: RouteFix[] = [];
  for (const w of wps as Record<string, unknown>[]) {
    const icao = w["ICAO"] as Record<string, unknown> | undefined;
    const ident = str(icao?.["ICAOIdent"]) ?? "UNKNOWN";
    const type = str(w["ATCWaypointType"]);
    const wp = str(w["WorldPosition"]);
    if (type === "User" && wp) {
      const pos = parseWorldPosition(wp);
      if (!pos) {
        warnings.push(`Waypoint ${ident}: unparsable WorldPosition — skipped.`);
        continue;
      }
      fixes.push({ name: ident, lat: pos.lat, lon: pos.lon, type: "waypoint", provenance: "verified", note: "Parsed from EFB PLN User waypoint." });
    } else if (type && type !== "User") {
      // Navdata fix: name only — position resolved from the sim's navdata at load.
      fixes.push({ name: ident, lat: null, lon: null, type: "waypoint", provenance: "unavailable", note: `Navdata fix ${ident}; coordinates resolve from simulator navdata.` });
    }
  }

  return {
    title: str(fp["Title"]),
    description: str(fp["Descr"]),
    fpType: str(fp["FPType"]),
    cruisingAltFt: fp["CruisingAlt"] != null ? Number(fp["CruisingAlt"]) : null,
    departureId: str(fp["DepartureID"]),
    destinationId: str(fp["DestinationID"]),
    departureRunway: runwayOf(dep),
    departureSid: str(dep?.["DepartureFP"]),
    departureTransition: str(dep?.["TransitionFP"]),
    arrivalRunway: runwayOf(arr),
    arrivalStar: str(arr?.["ArrivalFP"]),
    arrivalTransition: str(arr?.["TransitionFP"]),
    approachType: str(app?.["ApproachTypeFP"]),
    approachRunway: runwayOf(app),
    fixes,
    warnings,
  };
}
