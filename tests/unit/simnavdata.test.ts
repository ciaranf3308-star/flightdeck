/** Live sim navdata: cache -> overlay -> engine -> PLN export, end to end. */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { planFlight } from "@flightdeck/route-engine";
import { exportMsfs2024Pln } from "@flightdeck/msfs-export";
import { FixtureNavDatabase } from "@flightdeck/navigation";
import type { RouteFix } from "@flightdeck/shared-models";
import {
  SimNavDataOverlay,
  getSimNavdataStatus,
  initSimNavdataTables,
  simProceduresToEngine,
  storeSimNavdata,
} from "../../services/planning-api/src/simnavdata.js";

function memDb(): DatabaseSync {
  const handle = new DatabaseSync(":memory:");
  initSimNavdataTables(handle);
  return handle;
}

const KJFK_PROCS = [
  {
    kind: "SID" as const, name: "SKORR4", runways: ["31L"],
    transitions: ["SKORR"], transitionPositions: { SKORR: { lat: 40.9, lon: -72.5 } },
  },
  {
    kind: "SID" as const, name: "GAYLE1", runways: ["31L"],
    transitions: ["GAYLE"], transitionPositions: { GAYLE: { lat: 40.5, lon: -74.8 } },
  },
];
const EIDW_PROCS = [
  {
    kind: "STAR" as const, name: "BAGSO1L", runways: ["28L"],
    transitions: ["BAGSO"], transitionPositions: { BAGSO: { lat: 53.9, lon: -7.6 } },
  },
  {
    kind: "APPROACH" as const, name: "ILS28L", runways: ["28L"],
    transitions: [], transitionPositions: {}, approachType: "ILS",
  },
];

const FIXES: RouteFix[] = [
  { name: "KJFK", lat: 40.6413, lon: -73.7781, type: "origin", provenance: "verified" },
  { name: "TRK01", lat: 46.9283, lon: -61.7733, type: "waypoint", provenance: "inferred" },
  { name: "TRK05", lat: 53.4217, lon: -6.2617, type: "waypoint", provenance: "inferred" },
  { name: "EIDW", lat: 53.4214, lon: -6.2701, type: "destination", provenance: "verified" },
];

describe("live sim navdata pipeline", () => {
  it("stores and reports cached procedures", () => {
    const handle = memDb();
    const st = storeSimNavdata(handle, "kjfk", KJFK_PROCS, "SIM-2026-10-15");
    expect(st.cached).toBe(true);
    expect(st.icao).toBe("KJFK");
    expect(st.cycle).toBe("SIM-2026-10-15");
    expect(st.counts).toEqual({ SID: 2, STAR: 0, APPROACH: 0 });
    expect(getSimNavdataStatus(handle, "EIDW").cached).toBe(false);
  });

  it("maps cached rows to verified engine procedures (one per runway)", () => {
    const handle = memDb();
    storeSimNavdata(handle, "KJFK", [
      { kind: "SID", name: "SKORR4", runways: ["31L", "31R"], transitions: ["SKORR"], transitionPositions: {} },
    ]);
    const procs = simProceduresToEngine(handle, "KJFK");
    expect(procs).not.toBeNull();
    expect(procs!.length).toBe(2);
    expect(procs![0]).toMatchObject({ id: "SKORR4", kind: "SID", provenance: "verified" });
    expect(procs!.map((p) => p.runway).sort()).toEqual(["31L", "31R"]);
  });

  it("overlay replaces fixture procedures only when sim data is cached", async () => {
    const handle = memDb();
    const overlay = new SimNavDataOverlay(new FixtureNavDatabase(), handle);
    const before = await overlay.getAirport("KJFK");
    expect(before!.procedures.some((p) => p.provenance === "generated")).toBe(true);
    storeSimNavdata(handle, "KJFK", KJFK_PROCS);
    const after = await overlay.getAirport("KJFK");
    expect(after!.procedures.every((p) => p.provenance === "verified")).toBe(true);
    expect(after!.procedures.map((p) => p.id).sort()).toEqual(["GAYLE1", "SKORR4"]);
    expect(after!.navdataCycle).toMatch(/^SIM-/);
    // runways still come from fixtures (real identifiers)
    expect(after!.runways.some((r) => r.id === "31L")).toBe(true);
  });

  it("planFlight selects real SID/STAR/ILS and the PLN carries real names", async () => {
    const handle = memDb();
    storeSimNavdata(handle, "KJFK", KJFK_PROCS);
    storeSimNavdata(handle, "EIDW", EIDW_PROCS);
    const overlay = new SimNavDataOverlay(new FixtureNavDatabase(), handle);
    const origin = await overlay.getAirport("KJFK");
    const destination = await overlay.getAirport("EIDW");
    const { plan } = planFlight({
      origin: origin!, destination: destination!, aircraft: null, filedFixes: FIXES, mode: "historical",
      historicalRunwayDeparture: "31L", historicalRunwayArrival: "28L",
      windOrigin: null, windDestination: null, cruiseAltitudeFt: 37000,
      flightNumber: "EI106", date: "2026-10-09",
    });
    expect(plan.procedures.sid.procedureId).toBe("SKORR4");
    expect(plan.procedures.sid.transition).toBe("SKORR");
    expect(plan.procedures.star.procedureId).toBe("BAGSO1L");
    expect(plan.procedures.approach.procedureId).toBe("ILS28L");

    const procedures = [...origin!.procedures, ...destination!.procedures];
    const exported = exportMsfs2024Pln(
      plan,
      { findProcedure: (id) => procedures.find((p) => p.id === id) ?? null },
      {},
    );
    expect(exported.warnings.filter((w) => w.includes("synthetic"))).toEqual([]);
    expect(exported.xml).toContain("<DepartureFP>SKORR4</DepartureFP>");
    expect(exported.xml).toContain("<ArrivalFP>BAGSO1L</ArrivalFP>");
    expect(exported.xml).toContain("<ApproachTypeFP>ILS</ApproachTypeFP>");
    expect(exported.xml).toContain("<TransitionFP>SKORR</TransitionFP>");
  });
});
