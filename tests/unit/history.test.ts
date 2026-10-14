import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  findHistorical,
  initImportsTable,
  storeImport,
} from "../../services/planning-api/src/history.js";
import type { AirportNavData } from "@flightdeck/shared-models";

const FIX = new URL("../fixtures/opensky", import.meta.url).pathname;
const departure: unknown[] = JSON.parse(readFileSync(`${FIX}/departure-kjfk.json`, "utf8"));
const track: unknown = JSON.parse(readFileSync(`${FIX}/track.json`, "utf8"));
const AFIX = new URL("../fixtures/adsbaero", import.meta.url).pathname;
const aeroRange: unknown = JSON.parse(readFileSync(`${AFIX}/data-range.json`, "utf8"));
const aeroQuery: unknown = JSON.parse(readFileSync(`${AFIX}/query-ein106-2026-10-09.json`, "utf8"));
const aeroFlight: unknown = JSON.parse(readFileSync(`${AFIX}/flight-4ca74e.json`, "utf8"));

function nav(icao: string, lat: number, lon: number, name: string): AirportNavData {
  return {
    airport: { icao, name, position: { lat, lon } },
    runways: [],
    procedures: [],
    navdataCycle: "TEST",
    provenance: "generated",
  };
}
const navdb = {
  getAirport: async (icao: string): Promise<AirportNavData | null> =>
    icao === "KJFK" ? nav("KJFK", 40.6413, -73.7781, "New York JFK") :
    icao === "EIDW" ? nav("EIDW", 53.4214, -6.2701, "Dublin") : null,
};

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
  return async (url: string | URL | Request) => {
    const r = handler(String(url));
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as Response;
  };
}

const openskyOk = mockFetch((url) =>
  url.includes("protocol/openid-connect/token")
    ? { status: 200, body: { access_token: "test-token", expires_in: 1800 } }
    : url.includes("/flights/departure")
      ? { status: 200, body: departure }
      : { status: 200, body: track },
) as unknown as typeof fetch;
const openskyEmpty = mockFetch((url) =>
  url.includes("protocol/openid-connect/token")
    ? { status: 200, body: { access_token: "test-token", expires_in: 1800 } }
    : { status: 404, body: null },
) as unknown as typeof fetch;

// adsb.aero backed by the real 2026-10-09 EI106 fixtures (verified live)
const adsbaeroOk = mockFetch((url) =>
  url.includes("adsb.aero/api/v1/data-range")
    ? { status: 200, body: aeroRange }
    : url.includes("adsb.aero/api/v1/query")
      ? { status: 200, body: aeroQuery }
      : url.includes("adsb.aero/api/v1/flights/")
        ? { status: 200, body: aeroFlight }
        : { status: 404, body: null },
) as unknown as typeof fetch;
const adsbaeroEmpty = mockFetch((url) =>
  url.includes("adsb.aero/api/v1/data-range")
    ? { status: 200, body: aeroRange }
    : { status: 404, body: null },
) as unknown as typeof fetch;

// Patch the provider's default fetch via a tiny subclass shim: history.ts
// constructs OpenSkyProvider internally, so we inject through global fetch.
const realFetch = globalThis.fetch;

describe("findHistorical source hierarchy", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initImportsTable(db);
    globalThis.fetch = realFetch;
  });

  it("skips paid FlightAware without a key and uses OpenSky with a free API client", async () => {
    globalThis.fetch = openskyOk;
    const res = await findHistorical(db, navdb, {
      flightNumber: "EI106",
      date: "2026-10-06",
      origin: "KJFK",
      openskyClientId: "test-id",
      openskyClientSecret: "test-secret",
    });
    const fa = res.attempts.find((a) => a.source === "flightaware");
    expect(fa?.found).toBe(false);
    expect(fa?.detail).toMatch(/No API key/i);
    const os = res.attempts.find((a) => a.source === "opensky");
    expect(os?.found).toBe(true);
    expect(os?.trackKind).toBe("verified");
    expect(res.options[0].source).toBe("opensky");
    const lookup = res.options[0].lookup;
    expect(lookup.recordedTrack.value).toHaveLength(7);
    expect(lookup.recordedTrack.provenance).toBe("verified");
    expect(lookup.filedRoute.value).toBeNull(); // OpenSky has no filed routes — honest
    expect(lookup.actualRunwayDeparture.value).toBeNull(); // nor runways
    expect(res.options[0].planFixes.length).toBeGreaterThan(0);
    expect(res.options[0].planFixes[0].provenance).toBe("inferred");
    // cruise altitude honestly derived from the track (max recorded), never "filed"
    expect(res.options[0].lookup.filedCruiseAltitudeFt.value).toBe(35000);
    expect(res.options[0].lookup.filedCruiseAltitudeFt.provenance).toBe("inferred");
    expect(res.options[0].lookup.filedCruiseAltitudeFt.note).toMatch(/not the filed cruise altitude/i);
  });

  it("explains that OpenSky history needs a free API client (anonymous is rejected)", async () => {
    globalThis.fetch = openskyOk; // must not even be reached
    const res = await findHistorical(db, navdb, { flightNumber: "EI106", date: "2026-10-06", origin: "KJFK" });
    const os = res.attempts.find((a) => a.source === "opensky");
    expect(os?.found).toBe(false);
    expect(os?.detail).toMatch(/free OpenSky API client/i);
  });

  it("reports OpenSky misses honestly and falls back to imports", async () => {
    globalThis.fetch = openskyEmpty;
    storeImport(db, "EI106", "2026-10-06", "my-track.csv",
      "time,lat,lon,alt_ft\n2026-10-06T09:50:00Z,40.6413,-73.7781,0\n2026-10-06T11:00:00Z,41.5,-71.0,35000\n2026-10-06T14:00:00Z,53.4214,-6.2701,0\n");
    const res = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-06", origin: "KJFK", destination: "EIDW",
      openskyClientId: "test-id", openskyClientSecret: "test-secret",
    });
    expect(res.attempts.find((a) => a.source === "opensky")?.found).toBe(false);
    const imp = res.options.find((o) => o.source === "import");
    expect(imp?.trackKind).toBe("imported");
    expect(imp?.lookup.recordedTrack.provenance).toBe("imported");
    expect(imp?.lookup.recordedTrack.value).toHaveLength(3);
    expect(imp?.lookup.filedCruiseAltitudeFt.value).toBe(35000);
    expect(imp?.lookup.filedCruiseAltitudeFt.provenance).toBe("inferred");
  });

  it("offers reconstruction only on explicit opt-in, fully labelled", async () => {
    globalThis.fetch = openskyEmpty;
    const off = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-06", origin: "KJFK", destination: "EIDW",
      openskyClientId: "test-id", openskyClientSecret: "test-secret",
    });
    expect(off.attempts.find((a) => a.source === "reconstruction")?.found).toBe(false);
    expect(off.options.some((o) => o.source === "reconstruction")).toBe(false);

    const on = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-06", origin: "KJFK", destination: "EIDW", allowReconstruction: true,
      openskyClientId: "test-id", openskyClientSecret: "test-secret",
    });
    const recon = on.options.find((o) => o.source === "reconstruction");
    expect(recon?.trackKind).toBe("reconstructed");
    expect(recon?.track).toEqual([]); // never presented as a recorded track
    expect(recon?.lookup.recordedTrack.value).toBeNull();
    const fixes = recon?.lookup.filedRoute.value ?? [];
    expect(fixes.length).toBeGreaterThan(2);
    expect(fixes.every((f) => f.provenance === "generated" || f.provenance === "verified")).toBe(true);
    expect(fixes.filter((f) => f.provenance === "generated").every((f) => f.name.startsWith("REF"))).toBe(true);
    expect(recon?.planWarnings.some((w) => w.includes("RECONSTRUCTED"))).toBe(true);
  });

  it("tries adsb.aero first and wins with the verified EI106 track", async () => {
    globalThis.fetch = adsbaeroOk;
    const res = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-09", origin: "KJFK", destination: "EIDW",
    });
    expect(res.options[0].source).toBe("adsbaero");
    expect(res.options[0].trackKind).toBe("verified");
    const lookup = res.options[0].lookup;
    expect(lookup.provider).toBe("adsbaero");
    expect(lookup.identIcao).toBe("EIN106"); // IATA -> ICAO conversion
    expect(lookup.aircraftType.value).toBe("A333");
    expect(lookup.registration.value).toBe("EI-EAV");
    expect(lookup.registration.provenance).toBe("verified");
    expect(lookup.recordedTrack.value).toHaveLength(190);
    expect(lookup.recordedTrack.provenance).toBe("verified");
    // the real track has an oceanic coverage gap — reported, never interpolated
    expect(res.options[0].planWarnings.some((w) => w.includes("oceanic gap") || w.includes("No ADS-B coverage"))).toBe(true);
    expect(lookup.filedCruiseAltitudeFt.value).toBe(37000);
    expect(lookup.filedCruiseAltitudeFt.provenance).toBe("inferred");
    const fa = res.attempts.find((a) => a.source === "flightaware");
    expect(fa?.found).toBe(false); // paid source skipped without a key, even though it's last
  });

  it("tries sources in order: adsb.aero, import, opensky, flightaware, reconstruction", async () => {
    globalThis.fetch = adsbaeroOk;
    const res = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-09", origin: "KJFK", destination: "EIDW",
      allowReconstruction: true,
    });
    expect(res.attempts.map((a) => a.source)).toEqual([
      "adsbaero", "import", "opensky", "flightaware", "reconstruction",
    ]);
  });

  it("falls back to imports when adsb.aero has no verified flight", async () => {
    globalThis.fetch = adsbaeroEmpty;
    storeImport(db, "EI106", "2026-10-09", "my-track.csv",
      "time,lat,lon,alt_ft\n2026-10-09T01:52:00Z,40.6413,-73.7781,0\n2026-10-09T03:00:00Z,41.5,-71.0,35000\n2026-10-09T07:17:00Z,53.4214,-6.2701,0\n");
    const res = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-09", origin: "KJFK", destination: "EIDW",
    });
    expect(res.attempts.find((a) => a.source === "adsbaero")?.found).toBe(false);
    const imp = res.options.find((o) => o.source === "import");
    expect(imp?.trackKind).toBe("imported");
  });

  it("keeps every attempt visible so the UI can offer alternates", async () => {
    globalThis.fetch = openskyOk;
    storeImport(db, "EI106", "2026-10-06", "my-track.csv",
      "time,lat,lon,alt_ft\n2026-10-06T09:50:00Z,40.6413,-73.7781,0\n2026-10-06T11:00:00Z,41.5,-71.0,35000\n2026-10-06T14:00:00Z,53.4214,-6.2701,0\n");
    const res = await findHistorical(db, navdb, {
      flightNumber: "EI106", date: "2026-10-06", origin: "KJFK", destination: "EIDW",
      openskyClientId: "test-id", openskyClientSecret: "test-secret",
    });
    const sources = res.options.map((o) => o.source);
    expect(sources).toContain("opensky");
    expect(sources).toContain("import");
    expect(res.attempts).toHaveLength(5); // adsbaero, import, opensky, flightaware, reconstruction
    expect(res.attempts.map((a) => a.source)).toEqual([
      "adsbaero", "import", "opensky", "flightaware", "reconstruction",
    ]);
  });

  it("rejects invalid input as real errors", async () => {
    await expect(findHistorical(db, navdb, { flightNumber: "!!!", date: "2026-10-06" })).rejects.toThrow();
    await expect(findHistorical(db, navdb, { flightNumber: "EI106", date: "soon" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});
