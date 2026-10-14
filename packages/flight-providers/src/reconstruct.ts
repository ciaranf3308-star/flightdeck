/**
 * Reference-route reconstruction — the last-resort historical source.
 *
 * When no verified or imported position history exists for a flight, we can
 * build a *reference* route: great-circle intermediates between the two
 * airports. This is explicitly NOT the actual flown route and must never be
 * presented as one:
 *
 * - every fix has provenance "generated" with a note saying so
 * - fix names are synthetic (REF01, REF02, …) — never real fix names, so a
 *   reconstructed route can never be mistaken for a filed one
 * - the plan/export carries hard warnings
 * - reconstruction only happens on explicit user opt-in (the API requires
 *   allowReconstruction: true; the UI requires a confirming click)
 *
 * The geometry itself is deterministic: same airports -> same points.
 */
import type { RouteFix } from "@flightdeck/shared-models";

export interface AirportPosition {
  icao: string;
  lat: number;
  lon: number;
}

const EARTH_NM = 3440.065;
const STEP_NM = 400;
const MAX_INTERMEDIATES = 10;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}
function toDeg(r: number): number {
  return (r * 180) / Math.PI;
}

function gcDistanceNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Great-circle intermediate point at fraction f (spherical linear interpolation). */
function gcIntermediate(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
  f: number,
): { lat: number; lon: number } {
  const lat1 = toRad(aLat);
  const lon1 = toRad(aLon);
  const lat2 = toRad(bLat);
  const lon2 = toRad(bLon);
  const d =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
        ),
      ),
    );
  if (d < 1e-12) return { lat: aLat, lon: aLon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: toDeg(Math.atan2(y, x)) };
}

export interface ReconstructedRoute {
  fixes: RouteFix[];
  warnings: string[];
  distanceNm: number;
}

/**
 * Build a reconstructed reference route. Deterministic; all fixes generated.
 * Throws when airport positions are missing — we never guess coordinates.
 */
export function reconstructReferenceRoute(origin: AirportPosition, dest: AirportPosition): ReconstructedRoute {
  for (const [label, p] of [
    ["origin", origin],
    ["destination", dest],
  ] as const) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
      throw new Error(`Cannot reconstruct: no coordinates for ${label} ${p.icao}.`);
    }
  }
  const distanceNm = gcDistanceNm(origin.lat, origin.lon, dest.lat, dest.lon);
  const n = Math.max(1, Math.min(MAX_INTERMEDIATES, Math.round(distanceNm / STEP_NM)));
  const fixes: RouteFix[] = [
    {
      name: origin.icao,
      lat: origin.lat,
      lon: origin.lon,
      type: "origin",
      provenance: "verified",
      note: "Airport position from navdata.",
    },
  ];
  for (let i = 1; i <= n; i++) {
    const f = i / (n + 1);
    const pt = gcIntermediate(origin.lat, origin.lon, dest.lat, dest.lon, f);
    fixes.push({
      name: `REF${String(i).padStart(2, "0")}`,
      lat: Math.round(pt.lat * 10000) / 10000,
      lon: Math.round(pt.lon * 10000) / 10000,
      type: "waypoint",
      provenance: "generated",
      note: "Reconstructed reference point — not an actual flown fix.",
    });
  }
  fixes.push({
    name: dest.icao,
    lat: dest.lat,
    lon: dest.lon,
    type: "destination",
    provenance: "verified",
    note: "Airport position from navdata.",
  });
  return {
    fixes,
    distanceNm: Math.round(distanceNm),
    warnings: [
      "RECONSTRUCTED REFERENCE ROUTE — this is a great-circle approximation, not the actual route this flight flew.",
      "Do not present reconstructed fixes as filed or historical waypoints.",
      "Useful for MSFS route setup and autopilot guidance practice only.",
    ],
  };
}

/**
 * Decimate a verified/imported track into plannable fixes.
 * Coordinates are real (from the track); the fix *names* are synthetic and
 * the derivation rule is recorded — provenance "inferred", never "verified".
 */
export function trackToFixes(
  points: { lat: number; lon: number }[],
  originName: string,
  destName: string,
  note: string,
  maxFixes = 24,
): RouteFix[] {
  if (points.length < 2) throw new Error("Need at least 2 track points.");
  const first = points[0];
  const last = points[points.length - 1];
  const fixes: RouteFix[] = [
    { name: originName, lat: first.lat, lon: first.lon, type: "origin", provenance: "inferred", note },
  ];
  // Prefer points where direction changes materially (turns matter for a
  // route), then top up with evenly spaced points so straight tracks still
  // get useful intermediate fixes. Deterministic in both cases.
  const target = Math.max(0, maxFixes - 2);
  const chosen = new Set<number>();
  let prevBrg: number | null = null;
  for (let i = 1; i < points.length - 1; i++) {
    const brg = Math.atan2(points[i + 1].lon - points[i].lon, points[i + 1].lat - points[i].lat);
    if (prevBrg === null || Math.abs(brg - prevBrg) > toRad(8)) {
      chosen.add(i);
      prevBrg = brg;
    }
  }
  if (chosen.size < target && points.length > 2) {
    const step = (points.length - 1) / (target + 1);
    for (let k = 1; k <= target && chosen.size < target; k++) {
      chosen.add(Math.min(points.length - 2, Math.max(1, Math.round(k * step))));
    }
  }
  const idx = [...chosen]
    .filter((i) => i > 0 && i < points.length - 1)
    .sort((a, b) => a - b)
    .slice(0, target);
  idx.forEach((i, n) => {
    const p = points[i];
    fixes.push({
      name: `TRK${String(n + 1).padStart(2, "0")}`,
      lat: Math.round(p.lat * 10000) / 10000,
      lon: Math.round(p.lon * 10000) / 10000,
      type: "waypoint",
      provenance: "inferred",
      note,
    });
  });
  fixes.push({ name: destName, lat: last.lat, lon: last.lon, type: "destination", provenance: "inferred", note });
  return fixes;
}
