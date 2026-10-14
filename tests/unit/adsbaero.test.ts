import { describe, expect, it } from "vitest";
import {
  AdsbAeroProvider,
  formatGap,
  parseDataRange,
  parseFlightSummary,
  parseTrajectory,
  verifyFlightIdentity,
} from "@flightdeck/flight-providers";
import queryFixture from "../fixtures/adsbaero/query-ein106-2026-10-09.json";
import flightFixture from "../fixtures/adsbaero/flight-4ca74e.json";
import rangeFixture from "../fixtures/adsbaero/data-range.json";

const SUMMARY = parseFlightSummary(queryFixture.flights[0])!;

function mockFetch(routes: [string, unknown][]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    for (const [needle, body] of routes) {
      if (url.includes(needle)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("adsb.aero data-range", () => {
  it("parses coverage dates", () => {
    const r = parseDataRange(rangeFixture);
    expect(r.firstDate).toBe("2025-04-07");
    expect(r.lastDate).toBe("2026-10-13");
  });
});

describe("adsb.aero flight summary", () => {
  it("parses the real EI106 record", () => {
    expect(SUMMARY.flightId).toBe("4ca74e:2026-10-09T01:52:24Z");
    expect(SUMMARY.callsign).toBe("EIN106");
    expect(SUMMARY.icaoType).toBe("A333");
    expect(SUMMARY.registration).toBe("EI-EAV");
    expect(SUMMARY.startAirportIdent).toBe("KJFK");
    expect(SUMMARY.endAirportIdent).toBe("EIDW");
  });

  it("rejects summaries without an id", () => {
    expect(parseFlightSummary({})).toBeNull();
    expect(parseFlightSummary(null)).toBeNull();
  });
});

describe("adsb.aero identity verification", () => {
  const exp = { icaoIdent: "EIN106", date: "2026-10-09", origin: "KJFK", destination: "EIDW" };

  it("accepts the real EI106 record with reasons", () => {
    const check = verifyFlightIdentity(SUMMARY, exp);
    expect(check.ok).toBe(true);
    expect(check.reasons.join(" ")).toMatch(/exactly/);
    expect(check.reasons.join(" ")).toMatch(/KJFK/);
  });

  it("rejects a callsign mismatch", () => {
    const check = verifyFlightIdentity({ ...SUMMARY, callsign: "EIN104" }, exp);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(" ")).toMatch(/rejected/);
  });

  it("rejects a date mismatch", () => {
    const check = verifyFlightIdentity({ ...SUMMARY, startTs: "2026-10-08T01:52:24Z" }, exp);
    expect(check.ok).toBe(false);
  });

  it("rejects a disagreeing airport", () => {
    const check = verifyFlightIdentity({ ...SUMMARY, endAirportIdent: "EGLL" }, exp);
    expect(check.ok).toBe(false);
  });

  it("tolerates an unidentified airport with a note", () => {
    const check = verifyFlightIdentity({ ...SUMMARY, startAirportIdent: null }, exp);
    expect(check.ok).toBe(true);
    expect(check.reasons.join(" ")).toMatch(/did not identify/);
  });
});

describe("adsb.aero trajectory parsing", () => {
  it("parses the real EI106 trajectory with its oceanic gap", () => {
    const t = parseTrajectory(flightFixture);
    expect(t.points.length).toBe(190);
    expect(t.segments).toEqual([92, 98]);
    expect(t.gaps.length).toBe(1);
    const gap = t.gaps[0];
    // ~3.3 h mid-Atlantic gap
    expect(gap.durationSec).toBeGreaterThan(3 * 3600);
    expect(gap.durationSec).toBeLessThan(4 * 3600);
    expect(formatGap(gap)).toMatch(/No ADS-B coverage for 3h/);
    expect(formatGap(gap)).toMatch(/not interpolated/);
    // every point has verified provenance, real coords, real timestamps
    for (const p of t.points) {
      expect(p.provenance).toBe("verified");
      expect(p.lat).toBeGreaterThanOrEqual(-90);
      expect(p.lat).toBeLessThanOrEqual(90);
      expect(Date.parse(p.timestamp)).toBeGreaterThan(0);
    }
    // cruise altitude preserved (ft, from [lon,lat,alt_ft])
    const alts = t.points.map((p) => p.altitudeFt ?? 0);
    expect(Math.max(...alts)).toBeGreaterThanOrEqual(36000);
  });

  it("returns empty for garbage input", () => {
    expect(parseTrajectory(null).points).toEqual([]);
    expect(parseTrajectory({}).gaps).toEqual([]);
  });
});

describe("AdsbAeroProvider.findFlight", () => {
  it("verifies identity end-to-end against fixtures", async () => {
    const p = new AdsbAeroProvider({
      fetchFn: mockFetch([
        ["/data-range", rangeFixture],
        ["/query", queryFixture],
      ]),
    });
    const found = await p.findFlight("EI106", "2026-10-09", "KJFK", "EIDW");
    expect(found.flight.registration).toBe("EI-EAV");
    expect(found.flight.icaoType).toBe("A333");
    expect(found.verifiedReasons.length).toBeGreaterThan(0);
    // IATA number converted to ICAO ident for the query
    expect(found.candidates).toBe(1);
  });

  it("reports out-of-coverage dates honestly", async () => {
    const p = new AdsbAeroProvider({ fetchFn: mockFetch([["/data-range", rangeFixture]]) });
    await expect(p.findFlight("EI106", "2024-01-01", "KJFK", "EIDW")).rejects.toMatchObject({ state: "empty" });
  });

  it("never returns an unverified lookalike", async () => {
    const lookalike = {
      ...queryFixture,
      flights: [{ ...queryFixture.flights[0], callsign: "EIN104" }],
    };
    const p = new AdsbAeroProvider({
      fetchFn: mockFetch([
        ["/data-range", rangeFixture],
        ["/query", lookalike],
      ]),
    });
    await expect(p.findFlight("EI106", "2026-10-09", "KJFK", "EIDW")).rejects.toMatchObject({ state: "empty" });
  });

  it("fetches the trajectory for a verified flight", async () => {
    const p = new AdsbAeroProvider({ fetchFn: mockFetch([["/flights/", flightFixture]]) });
    const { trajectory } = await p.getFlight("4ca74e:2026-10-09T01:52:24Z");
    expect(trajectory.points.length).toBe(190);
    expect(trajectory.gaps.length).toBe(1);
  });
});
