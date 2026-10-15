/** Geometric procedure selection from live sim navdata: nearest-transition wins. */
import { describe, expect, it } from "vitest";
import { planFlight } from "@flightdeck/route-engine";
import type { AirportNavData, Procedure, RouteFix } from "@flightdeck/shared-models";

const CONF = { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] } as const;

function simProc(
  kind: "SID" | "STAR" | "APPROACH",
  id: string,
  airport: string,
  runway: string,
  transitions: Record<string, { lat: number; lon: number }>,
  approachKind: "ILS" | "RNAV" | null = null,
): Procedure {
  const transitionPositions: Record<string, { lat: number; lon: number }> = {};
  for (const [k, v] of Object.entries(transitions)) transitionPositions[k] = v;
  return {
    id, kind, airport, runway,
    transitions: Object.keys(transitions),
    transitionPositions,
    approachKind, waypoints: [], constraints: [],
    navdataCycle: "2610", provenance: "verified",
    note: "live sim navdata via SimConnect facility data",
  };
}

function airport(icao: string, procedures: Procedure[], runways: { id: string; headingDeg: number }[]): AirportNavData {
  return {
    airport: { icao, name: `${icao} Intl`, position: { lat: 0, lon: 0 } },
    runways: runways.map((r) => ({ id: r.id, headingDeg: r.headingDeg, lengthFt: 10000 })),
    procedures,
    navdataCycle: "2610",
    provenance: "verified",
  };
}

const FIXES: RouteFix[] = [
  { name: "KJFK", lat: 40.6413, lon: -73.7781, type: "origin", provenance: "verified" },
  { name: "TRK01", lat: 46.9283, lon: -61.7733, type: "waypoint", provenance: "inferred" },
  { name: "TRK05", lat: 53.4217, lon: -6.2617, type: "waypoint", provenance: "inferred" },
  { name: "EIDW", lat: 53.4214, lon: -6.2701, type: "destination", provenance: "verified" },
];

function planWith(depProcs: Procedure[], arrProcs: Procedure[]) {
  return planFlight({
    origin: airport("KJFK", depProcs, [{ id: "31L", headingDeg: 310 }]),
    destination: airport("EIDW", arrProcs, [{ id: "28L", headingDeg: 280 }]),
    aircraft: null,
    filedFixes: FIXES,
    mode: "current",
    historicalRunwayDeparture: "31L",
    historicalRunwayArrival: "28L",
    windOrigin: null,
    windDestination: null,
    cruiseAltitudeFt: 37000,
    flightNumber: "EI106",
    date: "2026-10-09",
  });
}

describe("geometric procedure selection (sim navdata)", () => {
  it("picks the SID whose transition is nearest the first enroute fix", () => {
    const { plan } = planWith(
      [
        simProc("SID", "SKORR4", "KJFK", "31L", { SKORR: { lat: 40.9, lon: -72.5 } }), // east, toward TRK01
        simProc("SID", "GAYLE1", "KJFK", "31L", { GAYLE: { lat: 40.5, lon: -74.8 } }), // west, away
      ],
      [],
    );
    expect(plan.procedures.sid.procedureId).toBe("SKORR4");
    expect(plan.procedures.sid.transition).toBe("SKORR");
    expect(plan.procedures.sid.selectionReasons.some((r) => r.includes("nearest published transition"))).toBe(true);
  });

  it("a transition matching the filed route by name still outranks geometry", () => {
    const { plan } = planWith(
      [
        simProc("SID", "SKORR4", "KJFK", "31L", { SKORR: { lat: 40.9, lon: -72.5 } }),
        // MERIT is far from TRK01 but ON the filed route by name
        simProc("SID", "MERIT5", "KJFK", "31L", { MERIT: { lat: 41.0, lon: -75.5 } }),
      ],
      [],
    );
    // MERIT is not in FIXES; add it to prove name-match wins — use a variant plan
    const fixesWithMerit = [
      FIXES[0],
      { name: "MERIT", lat: 41.38, lon: -73.13, type: "waypoint", provenance: "verified" } as RouteFix,
      FIXES[1], FIXES[2], FIXES[3],
    ];
    const { plan: p2 } = planFlight({
      origin: airport("KJFK", [
        simProc("SID", "SKORR4", "KJFK", "31L", { SKORR: { lat: 40.9, lon: -72.5 } }),
        simProc("SID", "MERIT5", "KJFK", "31L", { MERIT: { lat: 41.0, lon: -75.5 } }),
      ], [{ id: "31L", headingDeg: 310 }]),
      destination: airport("EIDW", [], [{ id: "28L", headingDeg: 280 }]),
      aircraft: null, filedFixes: fixesWithMerit, mode: "current",
      historicalRunwayDeparture: "31L", historicalRunwayArrival: "28L",
      windOrigin: null, windDestination: null, cruiseAltitudeFt: 37000,
      flightNumber: "EI106", date: "2026-10-09",
    });
    expect(p2.procedures.sid.procedureId).toBe("MERIT5");
    expect(p2.procedures.sid.transition).toBe("MERIT");
    expect(plan.procedures.sid.procedureId).toBe("SKORR4"); // sanity: geometry won without the name match
  });

  it("picks the STAR whose transition is nearest the last enroute fix", () => {
    const { plan } = planWith(
      [],
      [
        simProc("STAR", "BAGSO1L", "EIDW", "28L", { BAGSO: { lat: 53.9, lon: -7.6 } }), // ~45nm from TRK05
        simProc("STAR", "LOMKI1L", "EIDW", "28L", { LOMKI: { lat: 51.8, lon: -8.6 } }), // ~130nm away
        simProc("APPROACH", "ILS28L", "EIDW", "28L", {}, "ILS"),
        simProc("APPROACH", "RNAV28L", "EIDW", "28L", {}, "RNAV"),
      ],
    );
    expect(plan.procedures.star.procedureId).toBe("BAGSO1L");
    expect(plan.procedures.star.transition).toBe("BAGSO");
    expect(plan.procedures.approach.procedureId).toBe("ILS28L");
    expect(plan.procedures.approach.runway).toBe("28L");
  });

  it("verified sim procedures carry no synthetic-data warning", () => {
    const { plan } = planWith(
      [simProc("SID", "SKORR4", "KJFK", "31L", { SKORR: { lat: 40.9, lon: -72.5 } })],
      [simProc("APPROACH", "ILS28L", "EIDW", "28L", {}, "ILS")],
    );
    expect(plan.procedures.sid.warnings.some((w) => w.includes("synthetic"))).toBe(false);
    expect(plan.procedures.sid.validationStatus).not.toBe("invalid");
  });

  it("no procedures for the runway stays honest (vectors), never invents", () => {
    const { plan } = planWith(
      [simProc("SID", "SKORR4", "KJFK", "31R", { SKORR: { lat: 40.9, lon: -72.5 } })], // wrong runway
      [],
    );
    expect(plan.procedures.sid.procedureId).toBeNull();
    expect(plan.procedures.sid.warnings.some((w) => w.includes("vectors"))).toBe(true);
  });
});
