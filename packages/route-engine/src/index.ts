/**
 * Deterministic route-planning and procedure-selection engine (Feature C).
 *
 * Pipeline per slot (departure runway, SID, arrival runway, STAR, approach):
 *   1. HARD CONSTRAINTS — eliminate impossible options (missing runway,
 *      insufficient length, incompatible approach kind, unknown procedure).
 *   2. RANKING — deterministic ordering (wind components, capability, then
 *      lexical tie-break). Never random, never by wind alone for approaches.
 *   3. CONFIDENCE — derived from listed evidence only. No invented percentages.
 *
 * Missing data (wind, NOTAMs, navdata gaps) is represented as uncertainty in
 * evidenceMissing / warnings — never silently defaulted.
 */
import { haversineNm } from "./flyable.js";
import type {
  AircraftProfile,
  AirportNavData,
  ApproachKind,
  Confidence,
  FlightPlan,
  PlanMode,
  Procedure,
  ProcedureRecommendation,
  RouteFix,
  Runway,
  ValidationStatus,
} from "@flightdeck/shared-models";

export interface WindSample {
  directionDeg: number; // direction wind comes FROM
  speedKt: number;
  source: string; // e.g. "manual entry", "METAR KJFK 131450Z"
}

export interface EngineInputs {
  origin: AirportNavData;
  destination: AirportNavData;
  aircraft: AircraftProfile | null;
  /** filed route fixes (may be empty) */
  filedFixes: RouteFix[];
  mode: PlanMode;
  /** provider-reported actual runways (historical mode preference) */
  historicalRunwayDeparture: string | null;
  historicalRunwayArrival: string | null;
  windOrigin: WindSample | null;
  windDestination: WindSample | null;
  cruiseAltitudeFt: number | null;
  flightNumber: string;
  date: string;
}

export interface EngineOutput {
  plan: FlightPlan;
}

// ---------------------------------------------------------------------------
// Evidence-based confidence
// ---------------------------------------------------------------------------
export function buildConfidence(
  evidenceFor: string[],
  evidenceAgainst: string[],
  evidenceMissing: string[],
): Confidence {
  const total = evidenceFor.length + evidenceAgainst.length + evidenceMissing.length;
  const score = total === 0 ? 0 : evidenceFor.length / total;
  const level =
    total === 0
      ? "unknown"
      : evidenceAgainst.length === 0 && score >= 0.75
        ? "high"
        : score >= 0.45
          ? "medium"
          : "low";
  return { level, score: Math.round(score * 100) / 100, evidenceFor, evidenceAgainst, evidenceMissing };
}

function noConfidence(reason: string): Confidence {
  return { level: "unknown", score: 0, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [reason] };
}

// ---------------------------------------------------------------------------
// Wind math
// ---------------------------------------------------------------------------
/** headwind (+) / tailwind (-) and crosswind components for a runway heading */
export function windComponents(runwayHeadingDeg: number, wind: WindSample): { headwindKt: number; crosswindKt: number } {
  // wind.directionDeg is the direction wind comes FROM (METAR convention).
  // Headwind is positive when the wind opposes the aircraft's motion.
  const rel = ((wind.directionDeg - runwayHeadingDeg) * Math.PI) / 180;
  const headwindKt = wind.speedKt * Math.cos(rel);
  const crosswindKt = Math.abs(wind.speedKt * Math.sin(rel));
  return { headwindKt: Math.round(headwindKt * 10) / 10, crosswindKt: Math.round(crosswindKt * 10) / 10 };
}

// ---------------------------------------------------------------------------
// Hard-constraint validation
// ---------------------------------------------------------------------------
export interface RunwayCheck {
  runway: Runway | null;
  ok: boolean;
  reasons: string[]; // why it failed, empty when ok
  warnings: string[];
}

export function checkRunway(runway: Runway | undefined, aircraft: AircraftProfile | null): RunwayCheck {
  if (!runway) return { runway: null, ok: false, reasons: ["Runway not found in navigation data."], warnings: [] };
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (aircraft?.minRunwayLengthFt != null && runway.lengthFt < aircraft.minRunwayLengthFt) {
    reasons.push(
      `Runway ${runway.id} length ${runway.lengthFt} ft below aircraft minimum ${aircraft.minRunwayLengthFt} ft.`,
    );
  }
  if (aircraft?.minRunwayLengthFt == null) {
    warnings.push("Aircraft runway-length requirement unknown; length check skipped.");
  }
  return { runway, ok: reasons.length === 0, reasons, warnings };
}

// ---------------------------------------------------------------------------
// Runway selection
// ---------------------------------------------------------------------------
const MAX_CROSSWIND_KT = 25; // planning gate; exceeded => warning, not elimination

export function selectRunway(
  airport: AirportNavData,
  opts: {
    wind: WindSample | null;
    aircraft: AircraftProfile | null;
    historicalRunway: string | null;
    mode: PlanMode;
    role: "departure" | "arrival";
  },
): ProcedureRecommendation {
  const navdataCycle = airport.navdataCycle;
  const forE: string[] = [];
  const against: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];

  // Historical mode: trust the provider-reported actual runway when it exists
  // in navdata and passes hard constraints.
  if (opts.mode === "historical" && opts.historicalRunway) {
    const rwy = airport.runways.find((r) => r.id === opts.historicalRunway);
    const check = checkRunway(rwy, opts.aircraft);
    if (check.ok && rwy) {
      forE.push(`Provider-reported actual ${opts.role} runway ${rwy.id}.`);
      forE.push(`Runway ${rwy.id} exists in navdata cycle ${navdataCycle}.`);
      if (opts.aircraft?.minRunwayLengthFt != null)
        forE.push(`Length ${rwy.lengthFt} ft satisfies aircraft minimum.`);
      else missing.push("Aircraft runway-length requirement unknown.");
      if (opts.wind) {
        const { headwindKt, crosswindKt } = windComponents(rwy.headingDeg, opts.wind);
        forE.push(`Wind ${opts.wind.directionDeg}°/${opts.wind.speedKt}kt gives ${headwindKt}kt headwind component.`);
        if (crosswindKt > MAX_CROSSWIND_KT) {
          against.push(`Crosswind component ${crosswindKt}kt exceeds ${MAX_CROSSWIND_KT}kt planning gate.`);
          warnings.push(`Crosswind ${crosswindKt}kt on ${rwy.id} exceeds planning gate — verify limits.`);
        }
      } else {
        missing.push("Wind data unavailable; historical runway kept without wind validation.");
        warnings.push("Wind unknown — historical runway accepted on provider evidence alone.");
      }
      return {
        procedureId: null, runway: rwy.id, transition: null, navdataCycle,
        selectionReasons: forE, warnings,
        confidence: buildConfidence(forE, against, missing),
        validationStatus: against.length ? "valid_with_warnings" : "valid",
      };
    }
    if (opts.historicalRunway && !rwy) {
      missing.push(`Provider-reported runway ${opts.historicalRunway} not in navdata.`);
      warnings.push(`Historical runway ${opts.historicalRunway} not found in ${airport.airport.icao} navdata; selecting from available runways.`);
    }
    if (opts.historicalRunway && rwy && !check.ok) {
      against.push(...check.reasons);
      warnings.push(`Historical runway ${rwy.id} fails hard constraints: ${check.reasons.join(" ")}`);
    }
  }

  // Current-conditions (or fallback): filter by hard constraints, rank deterministically.
  const candidates: { rwy: Runway; headwind: number | null; crosswind: number | null }[] = [];
  for (const rwy of airport.runways) {
    const check = checkRunway(rwy, opts.aircraft);
    if (!check.ok) continue; // hard constraint elimination
    warnings.push(...check.warnings);
    if (opts.wind) {
      const { headwindKt, crosswindKt } = windComponents(rwy.headingDeg, opts.wind);
      candidates.push({ rwy, headwind: headwindKt, crosswind: crosswindKt });
    } else {
      candidates.push({ rwy, headwind: null, crosswind: null });
    }
  }
  if (candidates.length === 0) {
    return {
      procedureId: null, runway: null, transition: null, navdataCycle,
      selectionReasons: [], warnings: [...warnings, `No ${opts.role} runway passes hard constraints at ${airport.airport.icao}.`],
      confidence: noConfidence("No suitable runway in navdata."),
      validationStatus: "invalid",
    };
  }
  candidates.sort((a, b) => {
    if (a.headwind != null && b.headwind != null && a.headwind !== b.headwind) return b.headwind - a.headwind;
    if (b.rwy.lengthFt !== a.rwy.lengthFt) return b.rwy.lengthFt - a.rwy.lengthFt;
    return a.rwy.id.localeCompare(b.rwy.id);
  });
  const best = candidates[0];
  const reasons = [`${best.rwy.id} passes all hard constraints (${best.rwy.lengthFt} ft).`];
  if (best.headwind != null) {
    reasons.push(`Best headwind component: ${best.headwind}kt (wind ${opts.wind!.directionDeg}°/${opts.wind!.speedKt}kt).`);
    forE.push(...reasons);
    if (best.crosswind! > MAX_CROSSWIND_KT) {
      against.push(`Crosswind ${best.crosswind}kt exceeds ${MAX_CROSSWIND_KT}kt planning gate.`);
      warnings.push(`Crosswind ${best.crosswind}kt on ${best.rwy.id} exceeds planning gate — verify limits.`);
    }
  } else {
    reasons.push("Wind unknown — longest suitable runway selected.");
    forE.push(...reasons);
    missing.push("Wind data unavailable for runway ranking.");
    warnings.push("No wind data: runway chosen by length/capability only. Check METAR before flying.");
  }
  if (!opts.aircraft) {
    missing.push("No aircraft profile selected; compatibility checks skipped.");
    warnings.push("Select an aircraft profile for runway-length and approach compatibility checks.");
  }
  return {
    procedureId: null, runway: best.rwy.id, transition: null, navdataCycle,
    selectionReasons: forE, warnings,
    confidence: buildConfidence(forE, against, missing),
    validationStatus: against.length ? "valid_with_warnings" : "valid",
  };
}

// ---------------------------------------------------------------------------
// Procedure (SID/STAR/approach) selection
// ---------------------------------------------------------------------------
function selectProcedure(
  airport: AirportNavData,
  kind: "SID" | "STAR" | "APPROACH",
  runwayId: string | null,
  filedFixes: RouteFix[],
  aircraft: AircraftProfile | null,
  preferIls: boolean,
): ProcedureRecommendation {
  const navdataCycle = airport.navdataCycle;
  const warnings: string[] = [];
  const forE: string[] = [];
  const against: string[] = [];
  const missing: string[] = [];

  if (!runwayId) {
    return {
      procedureId: null, runway: null, transition: null, navdataCycle,
      selectionReasons: [], warnings: [`No runway selected — cannot choose a ${kind}.`],
      confidence: noConfidence("Runway selection failed."),
      validationStatus: "invalid",
    };
  }
  const pool = airport.procedures.filter((p) => p.kind === kind && p.runway === runwayId);
  if (pool.length === 0) {
    missing.push(`No ${kind} for runway ${runwayId} in navdata.`);
    warnings.push(`Navdata has no ${kind} for ${runwayId}; fly the runway heading / vectors.`);
    return {
      procedureId: null, runway: runwayId, transition: null, navdataCycle,
      selectionReasons: [], warnings,
      confidence: buildConfidence(forE, against, missing),
      validationStatus: "unknown",
    };
  }

  // Hard constraints: approach-kind compatibility with the aircraft.
  let candidates = pool;
  if (kind === "APPROACH" && aircraft) {
    const compatible = pool.filter(
      (p) => p.approachKind && aircraft.supportedApproachKinds.includes(p.approachKind),
    );
    if (compatible.length === 0) {
      against.push(`Aircraft supports ${aircraft.supportedApproachKinds.join("/")} but navdata has ${pool.map((p) => p.approachKind).join("/")} for ${runwayId}.`);
      warnings.push("No compatible approach in navdata for this aircraft — procedure left unselected.");
      return {
        procedureId: null, runway: runwayId, transition: null, navdataCycle,
        selectionReasons: [], warnings,
        confidence: buildConfidence(forE, against, missing),
        validationStatus: "invalid",
      };
    }
    candidates = compatible;
    forE.push(`Approach-kind compatibility verified against ${aircraft.label}.`);
  } else if (kind === "APPROACH" && !aircraft) {
    missing.push("No aircraft profile; approach compatibility unchecked.");
  }

  // Ranking: prefer a transition that matches the filed route (continuity),
  // then geometric proximity when transition coordinates are known (live sim
  // navdata), then ILS preference for approaches, then lexical (deterministic).
  const fixNames = new Set(filedFixes.map((f) => f.name));
  // Reference fix for geometry: first fix after departure for SIDs, last fix
  // before destination for STARs/approaches. Falls back to the raw ends when
  // fix types are absent.
  const refFix =
    kind === "SID"
      ? (filedFixes.find((f) => f.type !== "origin" && f.lat != null && f.lon != null) ?? filedFixes[0])
      : ([...filedFixes].reverse().find((f) => f.type !== "destination" && f.lat != null && f.lon != null) ??
        filedFixes[filedFixes.length - 1]);
  const refPos = refFix && refFix.lat != null && refFix.lon != null ? { lat: refFix.lat, lon: refFix.lon } : null;
  const scored = candidates.map((p) => {
    let score = 0;
    const matchedTransition = p.transitions.find((t) => fixNames.has(t));
    if (matchedTransition) score += 10;
    // Geometric continuity: nearest published transition to the route end.
    // 6 pts at 0 nm, decaying to 0 at 1200 nm. Only applies when the sim
    // supplied transition coordinates.
    let geoTransition: string | null = null;
    let geoDistNm: number | null = null;
    if (refPos && p.transitionPositions) {
      for (const t of p.transitions) {
        const pos = p.transitionPositions[t];
        if (!pos) continue;
        const d = haversineNm(refPos.lat, refPos.lon, pos.lat, pos.lon);
        if (geoDistNm == null || d < geoDistNm) {
          geoDistNm = d;
          geoTransition = t;
        }
      }
      if (geoDistNm != null) score += Math.max(0, 6 - geoDistNm / 200);
    }
    if (kind === "APPROACH" && preferIls && p.approachKind === "ILS") score += 5;
    if (kind === "APPROACH" && p.approachKind === "ILS") score += 2; // ILS still outranks RNAV by capability
    return { p, score, matchedTransition: matchedTransition ?? null, geoTransition, geoDistNm };
  });
  scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id));
  const best = scored[0];

  forE.push(`${kind} ${best.p.id} exists in navdata cycle ${navdataCycle} for runway ${runwayId}.`);
  if (best.matchedTransition) forE.push(`Transition ${best.matchedTransition} matches the filed route (continuity).`);
  else if (best.geoTransition && best.geoDistNm != null)
    forE.push(
      `Transition ${best.geoTransition} is the nearest published transition to the ${kind === "SID" ? "first" : "last"} route fix (${Math.round(best.geoDistNm)} nm).`,
    );
  else {
    missing.push("No filed-route fix matches a published transition.");
    warnings.push(`${best.p.id} has no transition on the filed route — expect vectors or a discontinuity.`);
  }
  if (kind === "APPROACH") {
    if (best.p.approachKind === "ILS" && preferIls) forE.push("ILS preferred: available and aircraft-compatible.");
    else if (best.p.approachKind !== "ILS") {
      against.push("No suitable ILS approach available for this runway/aircraft.");
      warnings.push(`ILS unavailable or incompatible — ${best.p.approachKind} selected instead.`);
    }
  }
  if (best.p.provenance === "generated")
    warnings.push(`${best.p.id} is synthetic fixture data, not a published procedure — for testing only.`);

  return {
    procedureId: best.p.id,
    runway: runwayId,
    transition: best.matchedTransition ?? best.geoTransition,
    navdataCycle,
    selectionReasons: forE,
    warnings,
    confidence: buildConfidence(forE, against, missing),
    validationStatus: against.length ? "valid_with_warnings" : "valid",
  };
}

// ---------------------------------------------------------------------------
// Route continuity
// ---------------------------------------------------------------------------
function checkContinuity(
  sid: ProcedureRecommendation,
  star: ProcedureRecommendation,
  fixes: RouteFix[],
): string[] {
  const warnings: string[] = [];
  if (fixes.length === 0) {
    warnings.push("No filed route fixes — continuity between procedures and en-route cannot be verified.");
    return warnings;
  }
  const names = fixes.map((f) => f.name);
  if (sid.transition && !names.includes(sid.transition))
    warnings.push(`SID transition ${sid.transition} not found in filed fixes.`);
  if (star.transition && !names.includes(star.transition))
    warnings.push(`STAR transition ${star.transition} not found in filed fixes.`);
  const noCoords = fixes.filter((f) => f.lat == null);
  if (noCoords.length > 0)
    warnings.push(
      `${noCoords.length} filed fix(es) lack coordinates (${noCoords.map((f) => f.name).join(", ")}); the exported plan omits them.`,
    );
  return warnings;
}

// ---------------------------------------------------------------------------
// Top-level planner
// ---------------------------------------------------------------------------
let planCounter = 0;

export function planFlight(inputs: EngineInputs): EngineOutput {
  const {
    origin, destination, aircraft, filedFixes, mode,
    historicalRunwayDeparture, historicalRunwayArrival,
    windOrigin, windDestination, cruiseAltitudeFt, flightNumber, date,
  } = inputs;

  const depRwy = selectRunway(origin, {
    wind: windOrigin, aircraft, historicalRunway: historicalRunwayDeparture, mode, role: "departure",
  });
  const arrRwy = selectRunway(destination, {
    wind: windDestination, aircraft, historicalRunway: historicalRunwayArrival, mode, role: "arrival",
  });

  const sid = selectProcedure(origin, "SID", depRwy.runway, filedFixes, aircraft, false);
  const star = selectProcedure(destination, "STAR", arrRwy.runway, filedFixes, aircraft, false);
  const approach = selectProcedure(destination, "APPROACH", arrRwy.runway, filedFixes, aircraft, true);

  const warnings = [
    ...depRwy.warnings, ...arrRwy.warnings, ...sid.warnings, ...star.warnings, ...approach.warnings,
    ...checkContinuity(sid, star, filedFixes),
  ];

  const plan: FlightPlan = {
    id: `plan-${Date.now()}-${++planCounter}`,
    flightNumber,
    date,
    mode,
    origin: origin.airport,
    destination: destination.airport,
    aircraftType: aircraft?.icaoType ?? null,
    registration: null,
    fixes: filedFixes,
    cruiseAltitudeFt,
    procedures: {
      departureRunway: depRwy, sid, arrivalRunway: arrRwy, star, approach,
    },
    overrides: {},
    navdataCycle: origin.navdataCycle,
    sourceRouteKind: filedFixes.length > 0 ? "filed" : "none",
    warnings,
    createdAt: new Date().toISOString(),
  };
  return { plan };
}

/** Player override: replace one slot's procedure, re-validated. */
export function applyOverride(
  plan: FlightPlan,
  airport: AirportNavData,
  slot: "sid" | "star" | "approach" | "departureRunway" | "arrivalRunway",
  procedureId: string | null,
  runwayId: string | null,
): FlightPlan {
  const next: FlightPlan = { ...plan, procedures: { ...plan.procedures }, overrides: { ...plan.overrides } };
  if (slot === "departureRunway" || slot === "arrivalRunway") {
    const rwy = airport.runways.find((r) => r.id === runwayId);
    const check = checkRunway(rwy, null);
    const rec: ProcedureRecommendation = {
      procedureId: null, runway: runwayId, transition: null, navdataCycle: airport.navdataCycle,
      selectionReasons: [`Player override: runway ${runwayId}.`],
      warnings: check.ok ? [] : check.reasons,
      confidence: buildConfidence(["Player-selected."], check.ok ? [] : check.reasons, ["Engine ranking bypassed by override."]),
      validationStatus: check.ok ? "valid" : "invalid",
    };
    next.procedures[slot] = rec;
    next.overrides[slot] = runwayId ?? "(none)";
    // A new runway changes which procedures are valid — re-select the
    // dependent slots unless the player explicitly overrode them. This keeps
    // one runway change from silently leaving stale (or empty) procedures.
    if (slot === "departureRunway" && next.overrides["sid"] === undefined) {
      next.procedures.sid = selectProcedure(airport, "SID", runwayId, plan.fixes, null, false);
    }
    if (slot === "arrivalRunway") {
      if (next.overrides["star"] === undefined) {
        next.procedures.star = selectProcedure(airport, "STAR", runwayId, plan.fixes, null, false);
      }
      if (next.overrides["approach"] === undefined) {
        next.procedures.approach = selectProcedure(airport, "APPROACH", runwayId, plan.fixes, null, true);
      }
    }
    return next;
  }
  const proc: Procedure | undefined = airport.procedures.find((p) => p.id === procedureId);
  const rec: ProcedureRecommendation = {
    procedureId: procedureId ?? null,
    runway: proc?.runway ?? runwayId,
    transition: null,
    navdataCycle: airport.navdataCycle,
    selectionReasons: proc ? [`Player override: ${proc.kind} ${proc.id}.`, "Exists in navdata."] : [],
    warnings: proc
      ? proc.provenance === "generated"
        ? [`${proc.id} is synthetic fixture data — for testing only.`]
        : []
      : [`Procedure ${procedureId} not found in navdata — override invalid.`],
    confidence: proc
      ? buildConfidence(["Player-selected.", "Exists in navdata."], [], ["Engine ranking bypassed by override."])
      : noConfidence("Procedure not in navdata."),
    validationStatus: proc ? "valid" : "invalid",
  };
  next.procedures[slot] = rec;
  next.overrides[slot] = procedureId ?? "(none)";
  return next;
}

export type { ApproachKind };

export { buildFlyableReference, type FlyableEndpoint, type FlyableGap, type FlyableReference } from "./flyable.js";
