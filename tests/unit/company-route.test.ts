/** iniBuilds company-route (.fpl) exporter PoC: format fidelity + honesty invariants. */
import { describe, expect, it } from "vitest";
import {
  detectA330FlightplansDir,
  exportIniBuildsFpl,
  FplExportError,
  INIBUILDS_FPL_FORMAT,
} from "@flightdeck/msfs-export";
import type { FlightPlan } from "@flightdeck/shared-models";

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
      { name: "TRK01", lat: 46.928, lon: -61.774, type: "waypoint", provenance: "inferred" },
      { name: "OCN01", lat: 50.107, lon: -51.604, type: "waypoint", provenance: "generated" },
      { name: "NOCORD", lat: null, lon: null, type: "waypoint", provenance: "unavailable", note: "no coords" },
      { name: "EIDW", lat: 53.42, lon: -6.27, type: "destination", provenance: "verified" },
    ],
    cruiseAltitudeFt: 37000,
    procedures: {
      departureRunway: { procedureId: null, runway: "31L", transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      sid: { procedureId: null, runway: null, transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      arrivalRunway: { procedureId: null, runway: "28L", transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      star: { procedureId: null, runway: null, transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
      approach: { procedureId: null, runway: null, transition: null, navdataCycle: "X", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
    },
    overrides: {},
    navdataCycle: "2510",
    sourceRouteKind: "filed",
    warnings: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("exportIniBuildsFpl", () => {
  it("emits the exact community-documented format", () => {
    const r = exportIniBuildsFpl(basePlan(), { alternateIcao: "EINN" });
    expect(r.format).toBe(INIBUILDS_FPL_FORMAT);
    expect(r.filename).toBe("KJFKEIDW01.fpl");
    expect(r.fpl).toBe(
      "AIRLINE EIN\n" +
        "FLTID 106\n" +
        "CYCLE 2510\n" +
        "ADEP KJFK\n" +
        "ADES EIDW\n" +
        "ALTN EINN\n" +
        "CRUISE 37000\n" +
        "\n" +
        "1 KJFK ADEP 100.000000 40.640000 -73.770000\n" +
        "11 TRK01 DRCT 37000.000000 46.928000 -61.774000\n" +
        "11 OCN01 DRCT 37000.000000 50.107000 -51.604000\n" +
        "1 EIDW ADES 2700.000000 53.420000 -6.270000\n",
    );
  });

  it("excludes fixes without coordinates and reports them", () => {
    const r = exportIniBuildsFpl(basePlan());
    expect(r.excludedFixes).toEqual([
      { name: "NOCORD", reason: "No coordinates — omitted (company-route waypoints require lat/lon)." },
    ]);
    expect(r.fpl).not.toContain("NOCORD");
    expect(r.includedFixes).toEqual(["KJFK", "TRK01", "OCN01", "EIDW"]);
  });

  it("refuses when cruise altitude is unknown instead of inventing one", () => {
    expect(() => exportIniBuildsFpl(basePlan({ cruiseAltitudeFt: null }))).toThrow(FplExportError);
  });

  it("emits ALTN NONE with a warning when no alternate is supplied", () => {
    const r = exportIniBuildsFpl(basePlan());
    expect(r.fpl).toContain("ALTN NONE\n");
    expect(r.warnings.some((w) => w.includes("ALTN"))).toBe(true);
  });

  it("always carries the PoC-unverified warning", () => {
    const r = exportIniBuildsFpl(basePlan());
    expect(r.warnings.some((w) => w.includes("NOT yet verified"))).toBe(true);
  });

  it("deduplicates idents instead of emitting duplicates", () => {
    const plan = basePlan();
    plan.fixes = [
      { name: "KJFK", lat: 40.64, lon: -73.77, type: "origin", provenance: "verified" },
      { name: "TRK01", lat: 46.9, lon: -61.7, type: "waypoint", provenance: "inferred" },
      { name: "TRK01!", lat: 47.0, lon: -61.0, type: "waypoint", provenance: "inferred" },
      { name: "EIDW", lat: 53.42, lon: -6.27, type: "destination", provenance: "verified" },
    ];
    const r = exportIniBuildsFpl(plan);
    expect(r.fpl).toContain("11 TRK01 DRCT");
    expect(r.fpl).toContain("11 TRK011 DRCT");
  });
});

describe("detectA330FlightplansDir", () => {
  it("returns null off Windows (PoC runs on Linux/macOS CI)", () => {
    if (process.platform !== "win32") expect(detectA330FlightplansDir()).toBeNull();
  });
});
