/** User-taught procedures ("teach once"): storage, selection, overlay, export. */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  UserProcedureOverlay,
  applyUserProcedures,
  deleteUserProcedure,
  getUserProcedure,
  initUserProcedureTables,
  listUserProcedures,
  saveUserProcedure,
} from "../../services/planning-api/src/userprocedures.js";
import { exportMsfs2024Pln } from "@flightdeck/msfs-export";
import type { AirportNavData, FlightPlan, Procedure } from "@flightdeck/shared-models";

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initUserProcedureTables(db);
});

function rec(procedureId: string | null, runway: string | null, warnings: string[] = []) {
  return {
    procedureId, runway, transition: "GISTI", navdataCycle: "FIXTURE-2610",
    selectionReasons: ["fixture pick"], warnings,
    confidence: { level: "high", score: 0.9, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] },
    validationStatus: "valid" as const,
  };
}

function plan(): FlightPlan {
  return {
    id: "p1", flightNumber: "EI106", date: "2026-10-09", mode: "historical",
    origin: { icao: "KJFK", name: "JFK", position: { lat: 40.64, lon: -73.77 } },
    destination: { icao: "EIDW", name: "Dublin", position: { lat: 53.42, lon: -6.27 } },
    aircraftType: "A333", registration: null,
    fixes: [],
    cruiseAltitudeFt: 37000,
    procedures: {
      departureRunway: rec(null, "31L"),
      sid: rec("SYN-SID-31L-1", "31L", ['SYN-SID-31L-1 is synthetic fixture data, not a published procedure — for testing only.']),
      arrivalRunway: rec(null, "28L"),
      star: rec("OSGAR4L", "28L", ['OSGAR4L is synthetic fixture data, not a published procedure — for testing only.']),
      approach: rec("SYN-APPR-ILS28L", "28L", ['SYN-APPR-ILS28L is synthetic fixture data — omitted from export.']),
    },
    overrides: {},
    navdataCycle: "FIXTURE-2610",
    sourceRouteKind: "filed",
    warnings: [
      'SYN-SID-31L-1 is synthetic fixture data, not a published procedure — for testing only.',
      "Some unrelated warning.",
    ],
    createdAt: new Date().toISOString(),
  } as unknown as FlightPlan;
}

describe("saveUserProcedure", () => {
  it("normalizes and round-trips", () => {
    const saved = saveUserProcedure(db, { icao: "eidw", runway: "28l", kind: "STAR", name: "bagso1l", transition: "bagso" });
    expect(saved.icao).toBe("EIDW");
    expect(saved.runway).toBe("28L");
    expect(saved.name).toBe("BAGSO1L");
    expect(saved.transition).toBe("BAGSO");
    expect(getUserProcedure(db, "EIDW", "28L", "STAR")).toEqual(saved);
  });
  it("upserts on repeat teaches", () => {
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "OLD1L" });
    const again = saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "NEW1L" });
    expect(again.name).toBe("NEW1L");
    expect(listUserProcedures(db, "EIDW")).toHaveLength(1);
  });
  it("validates approach kind, defaulting to ILS", () => {
    const d = saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "APPROACH", name: "ILS28L" });
    expect(d.approachKind).toBe("ILS");
    expect(() => saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "APPROACH", name: "X", approachKind: "GLS" })).toThrow();
  });
  it("rejects bad input instead of storing garbage", () => {
    expect(() => saveUserProcedure(db, { icao: "DUB", runway: "28L", kind: "STAR", name: "X" })).toThrow();
    expect(() => saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "  " })).toThrow();
    expect(() => saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "SIDX" as never, name: "X" })).toThrow();
  });
});

describe("list/delete", () => {
  it("lists per airport and deletes", () => {
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "BAGSO1L" });
    saveUserProcedure(db, { icao: "KJFK", runway: "31L", kind: "SID", name: "MERIT3" });
    expect(listUserProcedures(db, "EIDW")).toHaveLength(1);
    expect(listUserProcedures(db)).toHaveLength(2);
    expect(deleteUserProcedure(db, "EIDW", "28L", "STAR")).toBe(true);
    expect(deleteUserProcedure(db, "EIDW", "28L", "STAR")).toBe(false);
    expect(getUserProcedure(db, "EIDW", "28L", "STAR")).toBeNull();
  });
});

describe("applyUserProcedures", () => {
  it("replaces fixture selections and drops their warnings", () => {
    saveUserProcedure(db, { icao: "KJFK", runway: "31L", kind: "SID", name: "MERIT3", transition: "MERIT" });
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "BAGSO1L" });
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "APPROACH", name: "ILS28L", approachKind: "ILS" });
    const p = plan();
    applyUserProcedures(db, p);
    expect(p.procedures.sid.procedureId).toBe("MERIT3");
    expect(p.procedures.sid.transition).toBe("MERIT");
    expect(p.procedures.star.procedureId).toBe("BAGSO1L");
    // No fixture transition carried onto the real STAR.
    expect(p.procedures.star.transition).toBeNull();
    expect(p.procedures.approach.procedureId).toBe("ILS28L");
    expect(p.procedures.star.confidence.level).toBe("high");
    expect(p.procedures.star.validationStatus).toBe("valid");
    expect(p.procedures.star.selectionReasons[0]).toMatch(/your saved STAR/);
    expect(p.warnings).toEqual(["Some unrelated warning."]);
    // Runway slots untouched.
    expect(p.procedures.departureRunway.procedureId).toBeNull();
  });
  it("never beats an explicit per-plan override", () => {
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "BAGSO1L" });
    const p = plan();
    p.overrides = { star: "explicit" };
    applyUserProcedures(db, p);
    expect(p.procedures.star.procedureId).toBe("OSGAR4L");
  });
  it("is a no-op with nothing taught", () => {
    const p = plan();
    applyUserProcedures(db, p);
    expect(p.procedures.star.procedureId).toBe("OSGAR4L");
  });
});

const baseAirport = (icao: string): AirportNavData => ({
  airport: { icao, name: icao, position: { lat: 0, lon: 0 } },
  runways: [],
  procedures: [],
  navdataCycle: "FIXTURE-2610",
  provenance: "generated",
});

describe("UserProcedureOverlay", () => {
  const inner = {
    cycle: "FIXTURE-2610",
    getAirport: async (icao: string) => (icao === "EIDW" ? baseAirport(icao) : null),
    listAirports: async () => ["EIDW"],
    resolvePosition: async () => null,
  };
  it("exposes taught procedures as imported navdata", async () => {
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "BAGSO1L" });
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "APPROACH", name: "ILS28L", approachKind: "ILS" });
    const ov = new UserProcedureOverlay(inner, db);
    const a = await ov.getAirport("EIDW");
    expect(a?.procedures).toHaveLength(2);
    const star = a?.procedures.find((x: Procedure) => x.kind === "STAR") as Procedure;
    expect(star.id).toBe("BAGSO1L");
    expect(star.provenance).toBe("imported");
    expect(star.runway).toBe("28L");
    const appr = a?.procedures.find((x: Procedure) => x.kind === "APPROACH") as Procedure;
    expect(appr.approachKind).toBe("ILS");
    expect(await ov.getAirport("KJFK")).toBeNull();
    expect(ov.cycle).toBe("FIXTURE-2610");
  });
  it("passes through airports with nothing taught", async () => {
    const ov = new UserProcedureOverlay(inner, db);
    const a = await ov.getAirport("EIDW");
    expect(a?.procedures).toHaveLength(0);
  });
});

describe("end to end: taught procedure reaches the PLN", () => {
  it("exports real ArrivalFP/ApproachTypeFP instead of omitting", async () => {
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "STAR", name: "BAGSO1L", transition: "BAGSO" });
    saveUserProcedure(db, { icao: "EIDW", runway: "28L", kind: "APPROACH", name: "ILS28L", approachKind: "ILS" });
    const p = plan();
    applyUserProcedures(db, p);
    const inner = {
      cycle: "FIXTURE-2610",
      getAirport: async (icao: string) => (icao === "EIDW" || icao === "KJFK" ? baseAirport(icao) : null),
      listAirports: async () => ["KJFK", "EIDW"],
      resolvePosition: async () => null,
    };
    const ov = new UserProcedureOverlay(inner, db);
    const origin = await ov.getAirport("KJFK");
    const dest = await ov.getAirport("EIDW");
    const procs = [...(origin?.procedures ?? []), ...(dest?.procedures ?? [])];
    const result = exportMsfs2024Pln(p, { findProcedure: (id: string | null) => procs.find((x) => x.id === id) ?? null });
    expect(result.xml).toContain("<ArrivalFP>BAGSO1L</ArrivalFP>");
    expect(result.xml).toContain("<TransitionFP>BAGSO</TransitionFP>");
    expect(result.xml).toContain("<ApproachTypeFP>ILS</ApproachTypeFP>");
    // No synthetic warnings for taught procedures.
    expect(result.warnings.some((w) => w.includes("synthetic"))).toBe(false);
  });
});
