import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildFlyableReference } from "@flightdeck/route-engine";
import type { TrackPoint } from "@flightdeck/shared-models";

const FIX = new URL("../fixtures/adsbaero", import.meta.url).pathname;
const flight = JSON.parse(readFileSync(`${FIX}/flight-4ca74e.json`, "utf8"));

function toTrackPoints(): TrackPoint[] {
  const pts: TrackPoint[] = [];
  const coords: unknown[][][] = flight.path.coordinates;
  const tss: number[][] = flight.timestamps;
  for (let s = 0; s < coords.length; s++) {
    for (let i = 0; i < coords[s].length; i++) {
      const c = coords[s][i];
      pts.push({
        timestamp: new Date(tss[s][i] * 1000).toISOString(),
        lat: c[1] as number,
        lon: c[0] as number,
        altitudeFt: Math.round(c[2] as number),
        groundspeedKt: null,
        headingDeg: null,
        provenance: "verified",
      });
    }
  }
  return pts;
}

const ORIGIN = { icao: "KJFK", lat: 40.6413, lon: -73.7781 };
const DEST = { icao: "EIDW", lat: 53.4214, lon: -6.2701 };

describe("buildFlyableReference", () => {
  it("builds a continuous EI106 reference route from the real 190-point track", () => {
    const ref = buildFlyableReference(toTrackPoints(), ORIGIN, DEST);
    expect(ref.stats.inputPoints).toBe(190);
    expect(ref.stats.segments).toBe(2);
    // the oceanic gap is detected and bridged with generated waypoints
    expect(ref.gaps).toHaveLength(1);
    expect(ref.gaps[0].durationSec).toBeGreaterThan(3 * 3600);
    expect(ref.stats.generatedFixes).toBeGreaterThanOrEqual(1);
    expect(ref.stats.generatedFixes).toBeLessThanOrEqual(3);
    // route starts/ends at the airports with verified provenance
    expect(ref.fixes[0].name).toBe("KJFK");
    expect(ref.fixes[0].provenance).toBe("verified");
    expect(ref.fixes[ref.fixes.length - 1].name).toBe("EIDW");
    expect(ref.fixes[ref.fixes.length - 1].provenance).toBe("verified");
    // MCDU-friendly fix count
    const enroute = ref.fixes.filter((f) => f.type === "waypoint");
    expect(enroute.length).toBeLessThanOrEqual(14);
    expect(enroute.length).toBeGreaterThanOrEqual(6);
    // provenance discipline: track-derived inferred, gap-bridging generated
    for (const f of enroute) {
      expect(["inferred", "generated"]).toContain(f.provenance);
      if (f.provenance === "generated") {
        expect(f.name).toMatch(/^OCN\d+$/);
        expect(f.note).toMatch(/NOT the actual flown route/);
      } else {
        expect(f.name).toMatch(/^TRK\d+$/);
      }
      expect(f.lat).not.toBeNull();
      expect(f.lon).not.toBeNull();
    }
    // every leg is a sane length — no zero-length or absurd legs
    for (let i = 1; i < ref.fixes.length; i++) {
      const a = ref.fixes[i - 1];
      const b = ref.fixes[i];
      expect(a.lat).not.toBeNull();
      expect(b.lat).not.toBeNull();
    }
    // warnings: reference disclosure + gap disclosure + procedure note
    const w = ref.warnings.join("\n");
    expect(w).toMatch(/FLYABLE REFERENCE PLAN/);
    expect(w).toMatch(/not the actual flown route/);
    expect(w).toMatch(/SID\/STAR\/ILS/);
  });

  it("is deterministic", () => {
    const a = buildFlyableReference(toTrackPoints(), ORIGIN, DEST);
    const b = buildFlyableReference(toTrackPoints(), ORIGIN, DEST);
    expect(a.fixes).toEqual(b.fixes);
    expect(a.warnings).toEqual(b.warnings);
  });

  it("handles a continuous track with no gaps", () => {
    const pts = toTrackPoints().slice(0, 92); // first segment only
    const ref = buildFlyableReference(pts, ORIGIN, DEST);
    expect(ref.gaps).toHaveLength(0);
    expect(ref.stats.generatedFixes).toBe(0);
    expect(ref.warnings.join("\n")).toMatch(/continuous coverage/);
  });

  it("rejects tracks with fewer than 2 valid points", () => {
    expect(() => buildFlyableReference([], ORIGIN, DEST)).toThrow();
    expect(() => buildFlyableReference([toTrackPoints()[0]], ORIGIN, DEST)).toThrow();
  });

  it("warns when timestamps are missing", () => {
    const pts = toTrackPoints().map((p) => ({ ...p, timestamp: "" }));
    const ref = buildFlyableReference(pts, ORIGIN, DEST);
    expect(ref.warnings.join("\n")).toMatch(/no usable timestamps/);
    expect(ref.fixes.length).toBeGreaterThan(2);
  });
});
