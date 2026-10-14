/** Route engine: determinism, hard constraints, evidence-based confidence. */
import { describe, expect, it } from "vitest";
import { FixtureNavDatabase } from "@flightdeck/navigation";
import {
  applyOverride,
  buildConfidence,
  planFlight,
  selectRunway,
  windComponents,
} from "@flightdeck/route-engine";
import { matchProfile } from "@flightdeck/aircraft-adapters";
import type { RouteFix } from "@flightdeck/shared-models";

const navdb = new FixtureNavDatabase();
const EIDW_FIXES: RouteFix[] = [
  { name: "GISTI", lat: null, lon: null, type: "waypoint", provenance: "unavailable" },
  { name: "OSGAR", lat: null, lon: null, type: "waypoint", provenance: "unavailable" },
];

describe("windComponents", () => {
  it("computes headwind for wind straight down the runway", () => {
    const { headwindKt, crosswindKt } = windComponents(280, { directionDeg: 280, speedKt: 10, source: "t" });
    expect(headwindKt).toBeCloseTo(10, 5);
    expect(crosswindKt).toBeCloseTo(0, 5);
  });
  it("computes crosswind for 90-degree crosswind", () => {
    const { headwindKt, crosswindKt } = windComponents(280, { directionDeg: 190, speedKt: 10, source: "t" });
    expect(headwindKt).toBeCloseTo(0, 5);
    expect(crosswindKt).toBeCloseTo(10, 5);
  });
});

describe("buildConfidence", () => {
  it("derives score from evidence fraction, not a guess", () => {
    const c = buildConfidence(["a", "b", "c"], [], ["x"]);
    expect(c.score).toBe(0.75);
    expect(c.level).toBe("high");
  });
  it("is unknown when there is no evidence at all", () => {
    const c = buildConfidence([], [], []);
    expect(c.level).toBe("unknown");
    expect(c.score).toBe(0);
  });
  it("drops below high when evidence counts against", () => {
    const c = buildConfidence(["a", "b", "c"], ["bad"], []);
    expect(c.level).not.toBe("high");
  });
});

describe("selectRunway (EIDW)", () => {
  it("historical mode trusts the provider runway when valid", async () => {
    const eidw = (await navdb.getAirport("EIDW"))!;
    const rec = selectRunway(eidw, {
      wind: null, aircraft: matchProfile("A333"), historicalRunway: "28L", mode: "historical", role: "arrival",
    });
    expect(rec.runway).toBe("28L");
    expect(rec.validationStatus).toBe("valid");
    expect(rec.selectionReasons.join(" ")).toMatch(/provider/i);
  });

  it("eliminates runways below aircraft minimum length (hard constraint)", async () => {
    const eidw = (await navdb.getAirport("EIDW"))!;
    const heavy = { ...matchProfile("A333")!, minRunwayLengthFt: 20000 };
    const rec = selectRunway(eidw, { wind: null, aircraft: heavy, historicalRunway: null, mode: "current", role: "arrival" });
    expect(rec.validationStatus).toBe("invalid");
    expect(rec.runway).toBeNull();
  });

  it("is deterministic: same inputs, same runway", async () => {
    const kjfk = (await navdb.getAirport("KJFK"))!;
    const opts = {
      wind: { directionDeg: 300, speedKt: 12, source: "t" },
      aircraft: matchProfile("A333"),
      historicalRunway: null,
      mode: "current" as const,
      role: "departure" as const,
    };
    const a = selectRunway(kjfk, opts);
    const b = selectRunway(kjfk, opts);
    expect(a.runway).toBe(b.runway);
  });

  it("flags unknown wind as uncertainty, not a silent default", async () => {
    const kjfk = (await navdb.getAirport("KJFK"))!;
    const rec = selectRunway(kjfk, {
      wind: null, aircraft: matchProfile("A333"), historicalRunway: null, mode: "current", role: "departure",
    });
    expect(rec.runway).not.toBeNull();
    expect(rec.confidence.evidenceMissing.join(" ")).toMatch(/wind/i);
  });
});

describe("planFlight (EI106 historical)", () => {
  it("recommends 31L/SID-MERIT and 28L/OSGAR4L/GISTI with ILS approach", async () => {
    const origin = (await navdb.getAirport("KJFK"))!;
    const destination = (await navdb.getAirport("EIDW"))!;
    const { plan } = planFlight({
      origin, destination,
      aircraft: matchProfile("A333"),
      filedFixes: [
        { name: "KJFK", lat: 40.64, lon: -73.77, type: "origin", provenance: "verified" },
        { name: "MERIT", lat: 41.38, lon: -73.13, type: "reporting_point", provenance: "verified" },
        ...EIDW_FIXES,
        { name: "EIDW", lat: 53.42, lon: -6.27, type: "destination", provenance: "verified" },
      ],
      mode: "historical",
      historicalRunwayDeparture: "31L",
      historicalRunwayArrival: "28L",
      windOrigin: null, windDestination: null,
      cruiseAltitudeFt: 35000,
      flightNumber: "EI106", date: "2026-10-09",
    });
    expect(plan.procedures.departureRunway.runway).toBe("31L");
    expect(plan.procedures.sid.procedureId).toBe("SYN-SID-31L-1");
    expect(plan.procedures.sid.transition).toBe("MERIT");
    expect(plan.procedures.arrivalRunway.runway).toBe("28L");
    expect(plan.procedures.star.procedureId).toBe("OSGAR4L");
    expect(plan.procedures.star.transition).toBe("GISTI");
    expect(plan.procedures.approach.procedureId).toBe("SYN-APPR-ILS28L");
  });

  it("never selects an approach purely by wind: ILS outranks RNAV on capability", async () => {
    const destination = (await navdb.getAirport("EIDW"))!;
    const origin = (await navdb.getAirport("KJFK"))!;
    // Strong wind favoring 28R, but both 28L/28R have ILS — approach must be ILS-kind regardless
    const { plan } = planFlight({
      origin, destination,
      aircraft: matchProfile("A333"),
      filedFixes: EIDW_FIXES,
      mode: "current",
      historicalRunwayDeparture: null, historicalRunwayArrival: null,
      windOrigin: { directionDeg: 310, speedKt: 25, source: "t" },
      windDestination: { directionDeg: 280, speedKt: 25, source: "t" },
      cruiseAltitudeFt: 35000,
      flightNumber: "T", date: "2026-10-09",
    });
    const appr = plan.procedures.approach;
    if (appr.procedureId) {
      expect(appr.procedureId).toMatch(/ILS/);
    }
  });
});

describe("applyOverride", () => {
  it("re-validates player overrides and marks them as such", async () => {
    const origin = (await navdb.getAirport("KJFK"))!;
    const destination = (await navdb.getAirport("EIDW"))!;
    const { plan } = planFlight({
      origin, destination, aircraft: matchProfile("A333"), filedFixes: [],
      mode: "current", historicalRunwayDeparture: null, historicalRunwayArrival: null,
      windOrigin: null, windDestination: null, cruiseAltitudeFt: 35000,
      flightNumber: "T", date: "2026-10-09",
    });
    const next = applyOverride(plan, origin, "departureRunway", null, "04L");
    expect(next.procedures.departureRunway.runway).toBe("04L");
    expect(next.procedures.departureRunway.selectionReasons.join(" ")).toMatch(/override/i);
    expect(next.overrides["departureRunway"]).toBe("04L");
  });

  it("marks unknown override procedures invalid, never silent", async () => {
    const destination = (await navdb.getAirport("EIDW"))!;
    const origin = (await navdb.getAirport("KJFK"))!;
    const { plan } = planFlight({
      origin, destination, aircraft: matchProfile("A333"), filedFixes: [],
      mode: "current", historicalRunwayDeparture: null, historicalRunwayArrival: null,
      windOrigin: null, windDestination: null, cruiseAltitudeFt: 35000,
      flightNumber: "T", date: "2026-10-09",
    });
    const next = applyOverride(plan, destination, "star", "NOT-A-REAL-STAR", null);
    expect(next.procedures.star.validationStatus).toBe("invalid");
  });
});
