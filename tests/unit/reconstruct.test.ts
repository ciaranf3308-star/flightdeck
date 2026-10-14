import { describe, expect, it } from "vitest";
import {
  reconstructReferenceRoute,
  trackToFixes,
} from "../../packages/flight-providers/src/reconstruct.js";

const KJFK = { icao: "KJFK", lat: 40.6413, lon: -73.7781 };
const EIDW = { icao: "EIDW", lat: 53.4214, lon: -6.2701 };

describe("reconstructReferenceRoute", () => {
  it("builds a deterministic great-circle reference with synthetic names only", () => {
    const a = reconstructReferenceRoute(KJFK, EIDW);
    const b = reconstructReferenceRoute(KJFK, EIDW);
    expect(a).toEqual(b); // deterministic
    expect(a.distanceNm).toBeGreaterThan(2700);
    expect(a.distanceNm).toBeLessThan(2900); // KJFK-EIDW is ~2800nm
    expect(a.fixes[0]).toMatchObject({ name: "KJFK", type: "origin", provenance: "verified" });
    expect(a.fixes[a.fixes.length - 1]).toMatchObject({ name: "EIDW", type: "destination", provenance: "verified" });
    const mids = a.fixes.slice(1, -1);
    expect(mids.length).toBeGreaterThanOrEqual(1);
    for (const [i, f] of mids.entries()) {
      expect(f.name).toBe(`REF${String(i + 1).padStart(2, "0")}`);
      expect(f.provenance).toBe("generated");
      expect(f.lat).not.toBeNull();
      // never a real fix name that could be mistaken for a filed waypoint
      expect(f.name).not.toMatch(/^(MERIT|GISTI|OSGAR)$/);
    }
  });

  it("carries hard warnings that it is not the actual route", () => {
    const r = reconstructReferenceRoute(KJFK, EIDW);
    expect(r.warnings.some((w) => w.includes("RECONSTRUCTED"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("not the actual"))).toBe(true);
  });

  it("refuses to guess when airport coordinates are missing", () => {
    expect(() => reconstructReferenceRoute({ icao: "XXXX", lat: NaN, lon: 0 }, EIDW)).toThrow(/no coordinates/);
  });
});

describe("trackToFixes", () => {
  const pts = [
    { lat: 40.64, lon: -73.77 },
    { lat: 41.5, lon: -71.0 },
    { lat: 45.0, lon: -60.0 },
    { lat: 51.0, lon: -40.0 },
    { lat: 53.42, lon: -6.27 },
  ];
  it("derives synthetic fixes from real coordinates, labelled inferred", () => {
    const fixes = trackToFixes(pts, "KJFK", "EIDW", "test derivation note");
    expect(fixes[0]).toMatchObject({ name: "KJFK", type: "origin", provenance: "inferred" });
    expect(fixes[fixes.length - 1]).toMatchObject({ name: "EIDW", type: "destination", provenance: "inferred" });
    for (const f of fixes) {
      expect(f.note).toBe("test derivation note");
      expect(f.lat).not.toBeNull();
    }
    expect(fixes.some((f) => f.name.startsWith("TRK"))).toBe(true);
  });

  it("respects the fix cap and needs at least 2 points", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ lat: 40 + i * 0.05, lon: -73 + i * 0.3 }));
    expect(trackToFixes(many, "KJFK", "EIDW", "n", 10)).toHaveLength(10);
    expect(() => trackToFixes([{ lat: 1, lon: 2 }], "KJFK", "EIDW", "n")).toThrow();
  });
});
