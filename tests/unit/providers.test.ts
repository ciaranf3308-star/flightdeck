/** Flight provider contracts: normalization, error states, fixture honesty. */
import { describe, expect, it } from "vitest";
import {
  FixturesProvider,
  FlightLookupError,
  classifyHttpError,
  mapFix,
  normalizeFlightNumber,
} from "@flightdeck/flight-providers";

const FIXTURES = new URL("../fixtures", import.meta.url).pathname;

describe("normalizeFlightNumber", () => {
  it("maps EI106 to ICAO EIN106", () => {
    expect(normalizeFlightNumber("EI106").icaoIdent).toBe("EIN106");
  });
  it("tolerates spaces and lowercase", () => {
    expect(normalizeFlightNumber("ei 106").icaoIdent).toBe("EIN106");
  });
  it("keeps 3-letter ICAO prefixes", () => {
    expect(normalizeFlightNumber("EIN106").icaoIdent).toBe("EIN106");
  });
  it("rejects garbage", () => {
    expect(() => normalizeFlightNumber("hello")).toThrow(FlightLookupError);
  });
});

describe("classifyHttpError", () => {
  it("maps 401->unauthorized, 429->rate_limited, 404->empty, 500->network_error", () => {
    expect(classifyHttpError(401)).toBe("unauthorized");
    expect(classifyHttpError(429)).toBe("rate_limited");
    expect(classifyHttpError(404)).toBe("empty");
    expect(classifyHttpError(500)).toBe("network_error");
  });
});

describe("mapFix", () => {
  it("marks fixes without coordinates as unavailable, not guessed", () => {
    const fix = mapFix({ name: "N503B", latitude: null, longitude: null, type: "UNKNOWN" });
    expect(fix.lat).toBeNull();
    expect(fix.provenance).toBe("unavailable");
    expect(fix.name).toBe("N503B"); // name preserved verbatim
  });
  it("maps VOR types", () => {
    const fix = mapFix({ name: "HFD", latitude: 41.64, longitude: -72.54, type: "VOR-DME (NAVAID)" });
    expect(fix.type).toBe("vor");
    expect(fix.provenance).toBe("verified");
  });
});

describe("FixturesProvider (EI106 2026-10-09 real snapshot)", () => {
  const fp = new FixturesProvider({ fixturesRoot: FIXTURES });

  it("returns the real recorded flight with honest provenance", async () => {
    const r = await fp.lookupFlight("EI106", "2026-10-09");
    expect(r.state).toBe("ok");
    expect(r.origin.value?.icao).toBe("KJFK");
    expect(r.destination.value?.icao).toBe("EIDW");
    expect(r.aircraftType.value).toBe("A333");
    expect(r.registration.value).toBe("EI-EAV");
    expect(r.actualRunwayDeparture.value).toBe("31L");
    expect(r.actualRunwayArrival.value).toBe("28L");
    expect(r.filedCruiseAltitudeFt.value).toBe(35000);
    // filed_altitude came as flight level: must be labelled inferred, not verified-as-feet
    expect(r.filedCruiseAltitudeFt.provenance).toBe("inferred");
  });

  it("keeps filed vs recorded track separate", async () => {
    const r = await fp.lookupFlight("EI106", "2026-10-09");
    expect(r.filedRoute.value?.length).toBe(15);
    expect(r.recordedTrack.value?.length).toBe(389);
  });

  it("marks coordinate-less oceanic fixes unavailable, keeps names", async () => {
    const r = await fp.lookupFlight("EI106", "2026-10-09");
    const noCoords = r.filedRoute.value!.filter((f) => f.lat == null);
    expect(noCoords.length).toBeGreaterThan(0);
    expect(noCoords.map((f) => f.name)).toContain("N503B");
    for (const f of noCoords) expect(f.provenance).toBe("unavailable");
  });

  it("returns explicit empty state for unknown fixtures", async () => {
    const r = await fp.lookupFlight("EI999", "2026-10-09");
    expect(r.state).toBe("empty");
    expect(r.origin.value).toBeNull();
    expect(r.origin.provenance).toBe("unavailable");
  });
});
