import { describe, expect, it } from "vitest";
import {
  buildSimBriefRoute,
  buildSimBriefUrl,
  formatMcduFix,
  formatSimBriefFix,
  splitFlightNumber,
} from "../../apps/desktop/src/simbrief";
import type { RouteFix } from "@flightdeck/shared-models";

describe("splitFlightNumber", () => {
  it("maps EI106 to Aer Lingus ICAO + callsign", () => {
    expect(splitFlightNumber("EI106")).toEqual({
      airlineIata: "EI",
      airlineIcao: "EIA",
      number: "106",
      callsign: "EIA106",
    });
  });
  it("falls back to the raw prefix for unknown airlines", () => {
    const s = splitFlightNumber("XX1234");
    expect(s.airlineIcao).toBe("XX");
    expect(s.callsign).toBe("XX1234");
  });
});

describe("formatSimBriefFix", () => {
  it("formats the EI106 TRK01 fix", () => {
    expect(formatSimBriefFix(46.9275, -61.7733)).toBe("4656N/06146W");
  });
  it("handles southern/eastern hemispheres", () => {
    expect(formatSimBriefFix(-33.86, 151.21)).toBe("3352S/15113E");
  });
  it("carries minute overflow", () => {
    expect(formatSimBriefFix(46.9999, -61.9999)).toBe("4700N/06200W");
  });
});

describe("formatMcduFix", () => {
  it("formats the EI106 TRK01 fix in Airbus MCDU style", () => {
    expect(formatMcduFix(46.9275, -61.7733)).toBe("4655.7N/06146.4W");
  });
});

describe("buildSimBriefRoute", () => {
  const fixes: RouteFix[] = [
    { name: "KJFK", type: "origin", lat: 40.6413, lon: -73.7781, provenance: "verified" },
    { name: "TRK01", type: "waypoint", lat: 46.9275, lon: -61.7733, provenance: "inferred" },
    { name: "MERIT", type: "waypoint", lat: null, lon: null, provenance: "unavailable" },
    { name: "EIDW", type: "destination", lat: 53.4214, lon: -6.2701, provenance: "verified" },
  ];
  it("builds a DCT route from fixes with coordinates, skipping the rest", () => {
    const r = buildSimBriefRoute("KJFK", "EIDW", fixes);
    expect(r.route).toBe("KJFK DCT 4656N/06146W DCT EIDW");
    expect(r.skipped).toEqual(["MERIT"]);
    expect(r.mcduEntries).toEqual([{ name: "TRK01", entry: "4655.7N/06146.4W" }]);
  });
});

describe("buildSimBriefUrl", () => {
  it("prefills the dispatch URL for EI106", () => {
    const url = buildSimBriefUrl({
      flightNumber: "EI106",
      origin: "KJFK",
      destination: "EIDW",
      aircraftType: "A333",
      cruiseAltitudeFt: 37000,
      route: "KJFK DCT 4656N/06146W DCT EIDW",
    });
    expect(url.startsWith("https://dispatch.simbrief.com/options/custom?")).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("airline")).toBe("EIA");
    expect(q.get("fltnum")).toBe("106");
    expect(q.get("orig")).toBe("KJFK");
    expect(q.get("dest")).toBe("EIDW");
    expect(q.get("type")).toBe("A333");
    expect(q.get("fl")).toBe("370");
    expect(q.get("callsign")).toBe("EIA106");
    expect(q.get("route")).toBe("KJFK DCT 4656N/06146W DCT EIDW");
  });
  it("omits optional params when unknown", () => {
    const q = new URL(
      buildSimBriefUrl({ flightNumber: "EI106", origin: "KJFK", destination: "EIDW", aircraftType: null, cruiseAltitudeFt: null, route: "KJFK DCT EIDW" }),
    ).searchParams;
    expect(q.get("type")).toBeNull();
    expect(q.get("fl")).toBeNull();
  });
});
