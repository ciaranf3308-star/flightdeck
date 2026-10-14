/** MSFS 2024 EFB PLN exporter: spec compliance + honesty invariants. */
import { describe, expect, it } from "vitest";
import {
  exportMsfs2024Pln,
  formatDms,
  formatWorldPosition,
  parseMsfs2024Pln,
  parseWorldPosition,
  PlnExportError,
  splitRunway,
} from "@flightdeck/msfs-export";
import type { FlightPlan, Procedure } from "@flightdeck/shared-models";

function basePlan(overrides: Partial<FlightPlan> = {}): FlightPlan {
  return {
    id: "plan-test",
    flightNumber: "EI106",
    date: "2026-10-09",
    mode: "historical",
    origin: { icao: "KJFK", name: "John F Kennedy Intl", position: { lat: 40.64, lon: -73.77 } },
    destination: { icao: "EIDW", name: "Dublin Intl", position: { lat: 53.42, lon: -6.27 } },
    aircraftType: "A333",
    registration: "EI-EAV",
    fixes: [
      { name: "KJFK", lat: 40.64, lon: -73.77, type: "origin", provenance: "verified" },
      { name: "MERIT", lat: 41.38195, lon: -73.1374306, type: "reporting_point", provenance: "verified" },
      { name: "N503B", lat: null, lon: null, type: "nat", provenance: "unavailable", note: "no coords" },
      { name: "EIDW", lat: 53.42, lon: -6.27, type: "destination", provenance: "verified" },
    ],
    cruiseAltitudeFt: 35000,
    procedures: {
      departureRunway: { procedureId: null, runway: "31L", transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      sid: { procedureId: "REAL-SID", runway: "31L", transition: "MERIT", navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      arrivalRunway: { procedureId: null, runway: "28L", transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      star: { procedureId: "REAL-STAR", runway: "28L", transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      approach: { procedureId: "REAL-ILS", runway: "28L", transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
    },
    overrides: {},
    navdataCycle: "X",
    sourceRouteKind: "filed",
    warnings: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const VERIFIED_PROC = (id: string, kind: "SID" | "STAR" | "APPROACH", approachKind: null | "ILS" = null): Procedure => ({
  id, kind, airport: "KJFK", runway: "31L", transitions: [], approachKind,
  waypoints: [], constraints: [], navdataCycle: "X", provenance: "verified",
});
const SYNTH_PROC = (id: string): Procedure => ({ ...VERIFIED_PROC(id, "SID"), provenance: "generated" });

const ctxFor = (procs: Procedure[]) => ({ findProcedure: (id: string | null) => procs.find((p) => p.id === id) ?? null });

describe("splitRunway", () => {
  it("encodes 31L and 04", () => {
    expect(splitRunway("31L")).toEqual({ number: 31, designator: "LEFT" });
    expect(splitRunway("04")).toEqual({ number: 4 });
  });
  it("rejects garbage instead of guessing", () => {
    expect(() => splitRunway("XYZ")).toThrow(PlnExportError);
  });
});

describe("WorldPosition formatting", () => {
  it("round-trips through parse", () => {
    const s = formatWorldPosition(41.38195, -73.1374306, 35000);
    expect(s).toMatch(/^N41°/);
    const p = parseWorldPosition(s)!;
    expect(p.lat).toBeCloseTo(41.38195, 4);
    expect(p.lon).toBeCloseTo(-73.1374306, 4);
    expect(p.altFt).toBe(35000);
  });
  it("formats DMS components", () => {
    expect(formatDms(40.6399281, true)).toMatch(/^N40° 38'/);
  });
});

describe("exportMsfs2024Pln", () => {
  const ctx = ctxFor([
    VERIFIED_PROC("REAL-SID", "SID"),
    VERIFIED_PROC("REAL-STAR", "STAR"),
    VERIFIED_PROC("REAL-ILS", "APPROACH", "ILS"),
  ]);

  it("emits the EFB document structure per the SDK spec", () => {
    const out = exportMsfs2024Pln(basePlan(), ctx);
    expect(out.xml).toContain("<SimBase.Document>");
    expect(out.xml).toContain("<FlightPlan.FlightPlan>");
    expect(out.xml).toContain("<AppVersionMajor>12</AppVersionMajor>");
    expect(out.xml).toContain("<DepartureID>KJFK</DepartureID>");
    expect(out.xml).toContain("<DestinationID>EIDW</DestinationID>");
    expect(out.xml).toContain("<RunwayNumberFP>31</RunwayNumberFP>");
    expect(out.xml).toContain("<RunwayDesignatorFP>LEFT</RunwayDesignatorFP>");
    expect(out.xml).toContain("<DepartureFP>REAL-SID</DepartureFP>");
    expect(out.xml).toContain("<ApproachTypeFP>ILS</ApproachTypeFP>");
    expect(out.format).toBe("msfs2024-efb-pln/1.0");
  });

  it("excludes coordinate-less fixes and lists them with reasons", () => {
    const out = exportMsfs2024Pln(basePlan(), ctx);
    expect(out.includedFixes).toEqual(["MERIT"]);
    expect(out.excludedFixes.map((f) => f.name)).toContain("N503B");
    expect(out.xml).not.toContain("N503B");
  });

  it("omits synthetic fixture procedure names with a warning", () => {
    const plan = basePlan();
    plan.procedures.sid.procedureId = "SYN-SID-31L-1";
    const out = exportMsfs2024Pln(plan, ctxFor([SYNTH_PROC("SYN-SID-31L-1")]));
    expect(out.xml).not.toContain("<DepartureFP>");
    expect(out.warnings.join(" ")).toMatch(/synthetic fixture/i);
  });

  it("refuses to invent a cruising altitude", () => {
    expect(() => exportMsfs2024Pln(basePlan({ cruiseAltitudeFt: null }), ctx)).toThrow(PlnExportError);
  });

  it("round-trips through the parser", () => {
    const out = exportMsfs2024Pln(basePlan(), ctx);
    const parsed = parseMsfs2024Pln(out.xml);
    expect(parsed.departureId).toBe("KJFK");
    expect(parsed.destinationId).toBe("EIDW");
    expect(parsed.departureRunway).toBe("31L");
    expect(parsed.approachRunway).toBe("28L");
    expect(parsed.approachType).toBe("ILS");
    expect(parsed.cruisingAltFt).toBe(35000);
    expect(parsed.fixes.map((f) => f.name)).toEqual(["MERIT"]);
    expect(parsed.fixes[0].lat).toBeCloseTo(41.38195, 3);
  });

  it("flags legacy (< 12) AppVersion on import", () => {
    const out = exportMsfs2024Pln(basePlan(), ctx).xml.replace(
      "<AppVersionMajor>12</AppVersionMajor>",
      "<AppVersionMajor>10</AppVersionMajor>",
    );
    const parsed = parseMsfs2024Pln(out);
    expect(parsed.warnings.join(" ")).toMatch(/legacy/i);
  });
});
