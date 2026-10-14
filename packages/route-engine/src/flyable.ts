/**
 * Flyable reference plans from recorded tracks.
 *
 * The verified ADS-B track (e.g. the 190 adsb.aero positions for EI106) stays a
 * HISTORICAL REFERENCE — it is never the flight plan. This builder derives a
 * separate, continuous, navigable IFR reference route from the track geometry:
 *
 * - Origin/destination from navdata (verified).
 * - Enroute fixes sampled from real track positions (inferred, synthetic
 *   TRKxx names — coordinates are real, names are not).
 * - Coverage gaps (e.g. the mid-Atlantic ADS-B gap) bridged with generated
 *   great-circle waypoints (OCNxx, provenance GENERATED) — a flyable reference,
 *   NEVER presented as the actual flown route.
 *
 * The result feeds the normal plan/export pipeline, so runways and procedure
 * recommendations flow through unchanged. SID/STAR/ILS names still require
 * real navdata: with synthetic fixture data they are omitted from the PLN and
 * must be selected in the MSFS EFB — the warnings say so explicitly.
 */
import type { RouteFix, TrackPoint } from "@flightdeck/shared-models";

export interface FlyableGap {
  fromTime: string;
  toTime: string;
  durationSec: number;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
}

export interface FlyableReference {
  fixes: RouteFix[];
  warnings: string[];
  gaps: FlyableGap[];
  stats: {
    inputPoints: number;
    segments: number;
    trackFixes: number;
    generatedFixes: number;
  };
}

/** A timestamp gap of 30+ minutes starts a new coverage segment. */
const GAP_THRESHOLD_S = 30 * 60;
/** Enroute fix budget (excluding origin/destination) — MCDU-friendly. */
const MAX_ENROUTE_FIXES = 14;
/** Minimum leg length; shorter legs are merged away. */
const MIN_LEG_NM = 25;

const R_NM = 3440.065;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

function haversineNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLon = toRad(bLon - aLon);
  const y = Math.sin(dLon) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) - Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Great-circle intermediate point at fraction f between A and B. */
function intermediate(aLat: number, aLon: number, bLat: number, bLon: number, f: number): { lat: number; lon: number } {
  const lat1 = toRad(aLat);
  const lon1 = toRad(aLon);
  const lat2 = toRad(bLat);
  const lon2 = toRad(bLon);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2));
  if (d < 1e-9) return { lat: aLat, lon: aLon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return { lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), lon: toDeg(Math.atan2(y, x)) };
}

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export interface FlyableEndpoint {
  icao: string;
  lat: number;
  lon: number;
}

export function buildFlyableReference(
  track: TrackPoint[],
  origin: FlyableEndpoint,
  destination: FlyableEndpoint,
): FlyableReference {
  const pts = track.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180,
  );
  if (pts.length < 2) throw new Error("Need at least 2 valid track positions to build a flyable reference.");

  const warnings: string[] = [];
  const gaps: FlyableGap[] = [];

  // -- split into coverage segments -----------------------------------------
  const hasTimestamps = pts.some((p) => p.timestamp && Number.isFinite(Date.parse(p.timestamp)));
  if (!hasTimestamps) {
    warnings.push("Track has no usable timestamps — coverage gaps cannot be detected; the route is built as one segment.");
  }
  const segments: TrackPoint[][] = [[]];
  let prevT: number | null = null;
  let prevP: TrackPoint | null = null;
  for (const p of pts) {
    const t = p.timestamp ? Date.parse(p.timestamp) : NaN;
    if (hasTimestamps && prevT != null && prevP && Number.isFinite(t) && t - prevT > GAP_THRESHOLD_S * 1000) {
      gaps.push({
        fromTime: prevP.timestamp as string,
        toTime: p.timestamp as string,
        durationSec: Math.round((t - prevT) / 1000),
        fromLat: prevP.lat,
        fromLon: prevP.lon,
        toLat: p.lat,
        toLon: p.lon,
      });
      segments.push([]);
    }
    segments[segments.length - 1].push(p);
    if (Number.isFinite(t)) {
      prevT = t;
      prevP = p;
    }
  }

  // -- sample each segment ----------------------------------------------------
  // Budget enroute fixes across segments proportional to segment length.
  const totalPts = pts.length;
  type Chosen = { seg: number; idx: number };
  const chosen: Chosen[] = [];
  segments.forEach((seg, s) => {
    if (seg.length === 0) return;
    const budget = Math.max(2, Math.round((MAX_ENROUTE_FIXES * seg.length) / totalPts));
    const idx = new Set<number>([0, seg.length - 1]);
    // Prefer turn points: course changes matter for the route shape.
    let prevBrg: number | null = null;
    for (let i = 1; i < seg.length - 1 && idx.size < budget; i++) {
      const brg = bearingDeg(seg[i].lat, seg[i].lon, seg[i + 1].lat, seg[i + 1].lon);
      if (prevBrg === null || Math.abs(brg - prevBrg) > 10) {
        idx.add(i);
        prevBrg = brg;
      }
    }
    // Top up evenly so straight segments still get fixes.
    if (idx.size < budget && seg.length > 2) {
      const step = (seg.length - 1) / (budget + 1);
      for (let k = 1; k <= budget && idx.size < budget; k++) {
        idx.add(Math.min(seg.length - 1, Math.max(0, Math.round(k * step))));
      }
    }
    for (const i of [...idx].sort((a, b) => a - b)) chosen.push({ seg: s, idx: i });
  });
  chosen.sort((a, b) => a.seg - b.seg || a.idx - b.idx);

  // -- assemble the route, bridging gaps with generated waypoints -------------
  // Fixes are assembled with a gap tag; final TRKxx/OCNxx numbering happens
  // after the min-leg filter so names stay sequential in the flown order.
  interface PendingFix {
    lat: number;
    lon: number;
    type: "origin" | "waypoint" | "destination";
    provenance: "verified" | "inferred" | "generated";
    note: string;
    gap: FlyableGap | null;
    name?: string;
  }
  const pending: PendingFix[] = [
    {
      name: origin.icao,
      lat: origin.lat,
      lon: origin.lon,
      type: "origin",
      provenance: "verified",
      note: "Airport reference position.",
      gap: null,
    },
  ];
  const trackNote = "Position from the verified recorded track; fix name is synthetic.";

  const bridged = new Set<number>();
  for (const { seg, idx } of chosen) {
    // Bridge the coverage gap before this segment (segments after the first).
    if (seg > 0 && !bridged.has(seg)) {
      bridged.add(seg);
      const g = gaps[seg - 1];
      if (g) {
        const hours = g.durationSec / 3600;
        const k = Math.max(1, Math.min(3, Math.round(hours)));
        for (let i = 1; i <= k; i++) {
          const f = i / (k + 1);
          const ip = intermediate(g.fromLat, g.fromLon, g.toLat, g.toLon, f);
          pending.push({
            lat: Math.round(ip.lat * 10000) / 10000,
            lon: Math.round(ip.lon * 10000) / 10000,
            type: "waypoint",
            provenance: "generated",
            note:
              `Generated great-circle reference across an ADS-B coverage gap (${fmtDur(g.durationSec)}, ` +
              `${g.fromTime.slice(11, 16)}Z–${g.toTime.slice(11, 16)}Z) — NOT the actual flown route.`,
            gap: g,
          });
        }
      }
    }
    const p = segments[seg][idx];
    pending.push({
      lat: Math.round(p.lat * 10000) / 10000,
      lon: Math.round(p.lon * 10000) / 10000,
      type: "waypoint",
      provenance: "inferred",
      note: trackNote,
      gap: null,
    });
  }
  pending.push({
    name: destination.icao,
    lat: destination.lat,
    lon: destination.lon,
    type: "destination",
    provenance: "verified",
    note: "Airport reference position.",
    gap: null,
  });

  // -- enforce minimum leg length (drop clutter, keep endpoints) ---------------
  const kept: PendingFix[] = [pending[0]];
  for (let i = 1; i < pending.length; i++) {
    const prev = kept[kept.length - 1];
    const cur = pending[i];
    const isEndpoint = cur.type === "destination";
    const dist = haversineNm(prev.lat, prev.lon, cur.lat, cur.lon);
    if (dist >= MIN_LEG_NM || isEndpoint || i === pending.length - 1) {
      kept.push(cur);
    }
  }

  // -- final sequential naming + per-gap warnings --------------------------------
  let trkN = 0;
  let ocnN = 0;
  const ocnNamesByGap = new Map<FlyableGap, string[]>();
  for (const f of kept) {
    if (f.type !== "waypoint") continue;
    if (f.provenance === "generated" && f.gap) {
      ocnN++;
      f.name = `OCN${String(ocnN).padStart(2, "0")}`;
      const arr = ocnNamesByGap.get(f.gap) ?? [];
      arr.push(f.name);
      ocnNamesByGap.set(f.gap, arr);
    } else {
      trkN++;
      f.name = `TRK${String(trkN).padStart(2, "0")}`;
    }
  }
  for (const [g, names] of ocnNamesByGap) {
    warnings.push(
      `Oceanic reference (${names.join("/")}) is a generated great-circle across a ${fmtDur(g.durationSec)} ` +
        `coverage gap (${g.fromTime.slice(11, 16)}Z–${g.toTime.slice(11, 16)}Z, ` +
        `${g.fromLat.toFixed(1)}N ${Math.abs(g.fromLon).toFixed(1)}${g.fromLon < 0 ? "W" : "E"} → ` +
        `${g.toLat.toFixed(1)}N ${Math.abs(g.toLon).toFixed(1)}${g.toLon < 0 ? "W" : "E"}). ` +
        `No historical data exists for this segment — flyable reference only, not the actual flown route.`,
    );
  }
  const fixes: RouteFix[] = kept.map((f) => ({
    name: f.name as string,
    lat: f.lat,
    lon: f.lon,
    type: f.type,
    provenance: f.provenance,
    note: f.note,
  }));

  warnings.unshift(
    "FLYABLE REFERENCE PLAN — enroute legs are derived from the verified recorded-track geometry " +
      "(TRKxx, coordinates real) with generated great-circle bridging across coverage gaps (OCNxx). " +
      "This is a navigable reference route, NOT the filed route and NOT the exact historical track. " +
      "The recorded ADS-B positions remain available as a separate historical reference overlay.",
  );
  if (gaps.length === 0) {
    warnings.push("Recorded track has continuous coverage — no generated oceanic bridging was needed.");
  }
  warnings.push(
    "SID/STAR/ILS: FlightDeck's fixture navdata is synthetic, so procedure names are never exported. " +
      "Select the published procedures for the planned runways in the MSFS EFB from the simulator's own navdata.",
  );

  const trackFixes = fixes.filter((f) => f.provenance === "inferred").length;
  const generatedFixes = fixes.filter((f) => f.provenance === "generated").length;
  return {
    fixes,
    warnings,
    gaps,
    stats: { inputPoints: pts.length, segments: segments.filter((s) => s.length > 0).length, trackFixes, generatedFixes },
  };
}
