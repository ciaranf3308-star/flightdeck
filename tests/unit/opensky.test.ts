import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";import {
  OpenSkyProvider,
  callsignMatches,
  parseOpenSkyFlight,
  parseOpenSkyTrack,
  pickBestFlight,
  type OpenSkyFlight,
} from "../../packages/flight-providers/src/opensky.js";
import { FlightLookupError } from "../../packages/flight-providers/src/types.js";

const FIX = new URL("../fixtures/opensky", import.meta.url).pathname;
const departure: unknown[] = JSON.parse(readFileSync(`${FIX}/departure-kjfk.json`, "utf8"));
const track: unknown = JSON.parse(readFileSync(`${FIX}/track.json`, "utf8"));

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
  return async (url: string | URL | Request) => {
    const r = handler(String(url));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as Response;
  };
}

/** Authenticated provider (free API client) with the token exchange mocked. */
function authed(handler: (url: string) => { status: number; body: unknown }) {
  const inner = mockFetch((url) =>
    url.includes("protocol/openid-connect/token")
      ? { status: 200, body: { access_token: "tok", expires_in: 1800 } }
      : handler(url),
  );
  return new OpenSkyProvider({ clientId: "id", clientSecret: "secret", fetchFn: inner as typeof fetch });
}

describe("opensky parsing", () => {
  it("parses flight objects defensively (null icao24 dropped)", () => {
    const flights = departure.map(parseOpenSkyFlight).filter((f): f is OpenSkyFlight => f !== null);
    expect(flights).toHaveLength(3); // the null-icao24 row is dropped
    expect(flights[0]).toMatchObject({
      icao24: "4ca7c3",
      estDepartureAirport: "KJFK",
      estArrivalAirport: "EIDW",
      callsign: "EIN106",
    });
  });

  it("matches padded callsigns against ICAO idents", () => {
    expect(callsignMatches("EIN106  ", "EIN106")).toBe(true);
    expect(callsignMatches("BAW179  ", "EIN106")).toBe(false);
    expect(callsignMatches(null, "EIN106")).toBe(false);
  });

  it("picks the departure closest to the target date", () => {
    const flights = departure.map(parseOpenSkyFlight).filter((f): f is OpenSkyFlight => f !== null);
    const picked = pickBestFlight(flights, "EIN106", "2026-10-06");
    expect(picked?.flight.firstSeen).toBe(1791280200);
    expect(picked?.candidates).toBe(2);
    expect(pickBestFlight(flights, "EIN106", "2026-10-05")?.flight.firstSeen).toBe(1791193800);
    expect(pickBestFlight(flights, "DLH400", "2026-10-06")).toBeNull();
  });

  it("parses tracks: meters->feet, drops null positions", () => {
    const points = parseOpenSkyTrack(track, "OpenSky Network");
    expect(points).toHaveLength(7); // the null-lat/lon row is dropped
    expect(points[0]).toMatchObject({ lat: 40.6413, lon: -73.7781, altitudeFt: 0, provenance: "verified" });
    expect(points[2].altitudeFt).toBe(Math.round(10668.0 / 0.3048)); // 35000 ft
    expect(points[2].timestamp).toBe("2026-10-06T11:00:00.000Z");
    expect(points[6].headingDeg).toBeNull(); // null true_track stays null, not fabricated
  });
});

describe("opensky provider (mocked http)", () => {
  it("findFlight queries departures and matches the callsign", async () => {
    let seenUrl = "";
    const p = authed((url) => {
      seenUrl = url;
      return { status: 200, body: departure };
    });
    const r = await p.findFlight("EI106", "2026-10-06", "KJFK");
    expect(seenUrl).toContain("/flights/departure?airport=KJFK");
    // window must cover more than two days (UTC) per the API docs
    const q = new URL(seenUrl);
    expect(Number(q.searchParams.get("end")) - Number(q.searchParams.get("begin"))).toBeGreaterThan(2 * 86400);
    expect(r.flight.icao24).toBe("4ca7c3");
    expect(r.state).toBe("ok");
  });

  it("rejects anonymous use: historical flights need a free API client", async () => {
    const p = new OpenSkyProvider({
      fetchFn: mockFetch(() => ({ status: 200, body: departure })) as typeof fetch,
    });
    await expect(p.findFlight("EI106", "2026-10-06", "KJFK")).rejects.toMatchObject({ state: "unauthorized" });
  });

  it("maps 404 -> empty and 429 -> rate_limited", async () => {
    const p404 = authed(() => ({ status: 404, body: null }));
    await expect(p404.findFlight("EI106", "2026-10-06", "KJFK")).rejects.toMatchObject({ state: "empty" });
    const p429 = authed(() => ({ status: 429, body: null }));
    await expect(p429.findFlight("EI106", "2026-10-06", "KJFK")).rejects.toMatchObject({ state: "rate_limited" });
  });

  it("getTrack returns empty (not an error) when no track exists — e.g. the 30-day limit", async () => {
    const p = authed(() => ({ status: 404, body: null }));
    const r = await p.getTrack("4ca7c3", 1791280200);
    expect(r.state).toBe("empty");
    expect(r.points).toEqual([]);
    expect(r.note).toMatch(/30 days/);
  });

  it("getTrack parses a real track response", async () => {
    const p = authed(() => ({ status: 200, body: track }));
    const r = await p.getTrack("4ca7c3", 1791280200);
    expect(r.state).toBe("ok");
    expect(r.points).toHaveLength(7);
  });

  it("rejects invalid flight numbers and dates without calling the API", async () => {
    let called = false;
    const inner = mockFetch(() => {
      called = true;
      return { status: 200, body: [] };
    });
    const p = new OpenSkyProvider({ clientId: "id", clientSecret: "secret", fetchFn: inner as typeof fetch });
    await expect(p.findFlight("not a flight!!!", "2026-10-06", "KJFK")).rejects.toBeInstanceOf(FlightLookupError);
    await expect(p.findFlight("EI106", "yesterday", "KJFK")).rejects.toBeInstanceOf(FlightLookupError);
    expect(called).toBe(false);
  });
});
