/**
 * Pure parser for MSFS SimConnect facility-data payloads (no dependencies).
 *
 * The fetcher defines the facility definition in this exact field order:
 *
 *   OPEN AIRPORT
 *     N_RUNWAYS, N_DEPARTURES, N_ARRIVALS, N_APPROACHES        (INT32 each)
 *     OPEN RUNWAY
 *       PRIMARY_NUMBER, PRIMARY_DESIGNATOR,                   (INT32 each)
 *       SECONDARY_NUMBER, SECONDARY_DESIGNATOR,                (INT32 each)
 *       PRIMARY_ILS_ICAO, SECONDARY_ILS_ICAO                  (CHAR[8] each)
 *     CLOSE RUNWAY                                            (x N_RUNWAYS)
 *     OPEN DEPARTURE
 *       NAME                                                   (CHAR[8])
 *       N_RUNWAY_TRANSITIONS, N_ENROUTE_TRANSITIONS            (INT32 each)
 *       OPEN RUNWAY_TRANSITION: RUNWAY_NUMBER, RUNWAY_DESIGNATOR (INT32 each)
 *       OPEN ENROUTE_TRANSITION: NAME                          (CHAR[8])
 *     CLOSE DEPARTURE                                         (x N_DEPARTURES)
 *     (same for ARRIVAL)
 *     OPEN APPROACH
 *       TYPE, SUFFIX, RUNWAY_NUMBER, RUNWAY_DESIGNATOR,        (INT32 each)
 *       N_TRANSITIONS                                          (INT32)
 *       OPEN APPROACH_TRANSITION: NAME                         (CHAR[8])
 *     CLOSE APPROACH                                          (x N_APPROACHES)
 *   CLOSE AIRPORT
 *
 * The sim returns the requested fields concatenated in definition order
 * (possibly split across several facilityData messages — the fetcher
 * concatenates them before calling parseAirportFacility).
 *
 * Field types per the MSFS SDK docs: counts/numbers/designators are INT32
 * (little-endian), names/ICAOs are CHAR[8] (NUL-padded ASCII).
 */

export class FacilityParseError extends Error {}

/** Minimal reader over a Buffer/Uint8Array. */
export function createReader(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let o = 0;
  const need = (n, what) => {
    if (o + n > b.length) throw new FacilityParseError(`facility payload truncated reading ${what}`);
  };
  return {
    get remaining() {
      return b.length - o;
    },
    i32() {
      need(4, "int32");
      const v = b.readInt32LE(o);
      o += 4;
      return v;
    },
    c8() {
      need(8, "char[8]");
      const s = b.toString("ascii", o, o + 8).replace(/\0+$/, "").trim();
      o += 8;
      return s;
    },
  };
}

function sanityCount(n, max, what) {
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new FacilityParseError(`facility payload failed sanity check: ${what}=${n}`);
  }
  return n;
}

/** 31 + designator enum -> "31L". Returns null for non-runway numbers. */
export function runwayName(number, designator) {
  if (number < 1 || number > 36) return null;
  const d = designator === 1 ? "L" : designator === 2 ? "R" : designator === 3 ? "C" : "";
  return String(number).padStart(2, "0") + d;
}

/** Approach SUFFIX int -> "Z"/"Y"/... or "" when blank. */
export function approachSuffixChar(suffix) {
  if (suffix >= 65 && suffix <= 90) return String.fromCharCode(suffix); // A-Z
  if (suffix >= 48 && suffix <= 57) return String.fromCharCode(suffix); // 0-9
  return "";
}

/**
 * SimConnect APPROACH TYPE int -> FlightDeck approach kind.
 * Returns null for types with no EFB mapping (skipped, not invented).
 */
export function approachKindOf(type) {
  switch (type) {
    case 4:
      return "ILS";
    case 10:
    case 1: // GPS -> RNAV
      return "RNAV";
    case 2:
    case 8: // VORDME
      return "VOR";
    case 3:
    case 9: // NDBDME
      return "NDB";
    default:
      return null; // UNDEFINED, LOCALIZER, SDF, LDA, LOC_BC: no EFB mapping
  }
}

function readProcedure(r, kind) {
  const name = r.c8();
  const nRt = sanityCount(r.i32(), 60, "N_RUNWAY_TRANSITIONS");
  const nEt = sanityCount(r.i32(), 60, "N_ENROUTE_TRANSITIONS");
  const runways = [];
  for (let i = 0; i < nRt; i++) {
    const rn = runwayName(r.i32(), r.i32());
    if (rn) runways.push(rn);
  }
  const transitions = [];
  for (let i = 0; i < nEt; i++) {
    const t = r.c8();
    if (t) transitions.push(t);
  }
  return { kind, name, runways, transitions };
}

/**
 * Parse the concatenated facility payload for one airport.
 * Returns { runways: [{runway, ils}], sids, stars, approaches }.
 * Throws FacilityParseError on truncation or insane counts — never returns
 * half-parsed data that could be mistaken for real procedures.
 */
export function parseAirportFacility(payload) {
  const r = createReader(payload);
  const nRunways = sanityCount(r.i32(), 200, "N_RUNWAYS");
  const nDepartures = sanityCount(r.i32(), 500, "N_DEPARTURES");
  const nArrivals = sanityCount(r.i32(), 500, "N_ARRIVALS");
  const nApproaches = sanityCount(r.i32(), 500, "N_APPROACHES");

  const runways = [];
  for (let i = 0; i < nRunways; i++) {
    const p = runwayName(r.i32(), r.i32());
    const s = runwayName(r.i32(), r.i32());
    const pIls = r.c8();
    const sIls = r.c8();
    if (p) runways.push({ runway: p, ils: pIls || null });
    if (s) runways.push({ runway: s, ils: sIls || null });
  }

  const sids = [];
  for (let i = 0; i < nDepartures; i++) sids.push(readProcedure(r, "SID"));
  const stars = [];
  for (let i = 0; i < nArrivals; i++) stars.push(readProcedure(r, "STAR"));

  const approaches = [];
  for (let i = 0; i < nApproaches; i++) {
    const type = r.i32();
    const suffix = approachSuffixChar(r.i32());
    const runway = runwayName(r.i32(), r.i32());
    const nTrans = sanityCount(r.i32(), 60, "N_TRANSITIONS");
    const transitions = [];
    for (let t = 0; t < nTrans; t++) {
      const name = r.c8();
      if (name) transitions.push(name);
    }
    const kind = approachKindOf(type);
    if (kind && runway) {
      approaches.push({
        kind: "APPROACH",
        approachType: kind,
        // Label only: the PLN carries approach type + runway, never this name.
        name: `${kind}${suffix}${runway}`,
        runways: [runway],
        transitions,
      });
    }
  }

  return { runways, sids, stars, approaches };
}

/**
 * Convert parsed facility data to the planning API's SimProcedureInput shape
 * (POST /api/navdata/procedures). transitionPositions are omitted — the
 * route engine falls back to non-geometric ranking without them.
 */
export function toSimProcedureInputs(parsed) {
  const out = [];
  for (const s of parsed.sids) {
    if (!s.name) continue;
    out.push({ kind: "SID", name: s.name, runways: s.runways, transitions: s.transitions, transitionPositions: {} });
  }
  for (const s of parsed.stars) {
    if (!s.name) continue;
    out.push({ kind: "STAR", name: s.name, runways: s.runways, transitions: s.transitions, transitionPositions: {} });
  }
  for (const a of parsed.approaches) {
    out.push({
      kind: "APPROACH",
      name: a.name,
      runways: a.runways,
      transitions: a.transitions,
      transitionPositions: {},
      approachType: a.approachType,
    });
  }
  return out;
}
