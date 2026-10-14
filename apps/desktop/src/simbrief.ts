/**
 * SimBrief handoff: turn a FlightDeck plan into (a) a SimBrief DCT route string,
 * (b) a prefilled dispatch.simbrief.com URL, and (c) Airbus MCDU lat/long entries.
 *
 * Why this exists: the MSFS 2024 universal EFB cannot feed the iniBuilds A330's
 * FMGC (confirmed by iniBuilds staff), and SimConnect can't inject a flight plan
 * either. The working path is SimBrief OFP -> MCDU INIT REQUEST -> NAV. This
 * module removes all manual transcription from that path: one click opens
 * SimBrief with airline, flight number, airports, aircraft type, cruise level
 * and the exact route prefilled.
 */
import type { RouteFix } from "@flightdeck/shared-models";

/** IATA prefix -> ICAO designator. Unknown prefixes fall back to the raw prefix. */
const AIRLINE_ICAO: Record<string, string> = {
  EI: "EIA",
  BA: "BAW",
  DL: "DAL",
  UA: "UAL",
  AA: "AAL",
  LH: "DLH",
  AF: "AFR",
  KL: "KLM",
  FR: "RYR",
  U2: "EZY",
  W6: "WZZ",
  VY: "VLG",
  IB: "IBE",
};

export interface SplitFlightNumber {
  airlineIata: string;
  airlineIcao: string;
  number: string;
  callsign: string;
}

export function splitFlightNumber(flightNumber: string): SplitFlightNumber {
  const m = flightNumber.trim().toUpperCase().match(/^([A-Z0-9]{2,3}?)([0-9]{1,4}[A-Z]?)$/);
  const airlineIata = m?.[1] ?? "";
  const number = m?.[2] ?? flightNumber.trim().toUpperCase();
  const airlineIcao = AIRLINE_ICAO[airlineIata] ?? airlineIata;
  return { airlineIata, airlineIcao, number, callsign: `${airlineIcao}${number}` };
}

/** Decimal degrees -> SimBrief DCT waypoint `4656N/06146W` (minute precision). */
export function formatSimBriefFix(lat: number, lon: number): string {
  const laD = Math.floor(Math.abs(lat));
  const laM = Math.round((Math.abs(lat) - laD) * 60);
  const loD = Math.floor(Math.abs(lon));
  const loM = Math.round((Math.abs(lon) - loD) * 60);
  // Carry minute overflow (e.g. 59.6 -> 60).
  const la = laM === 60 ? { d: laD + 1, m: 0 } : { d: laD, m: laM };
  const lo = loM === 60 ? { d: loD + 1, m: 0 } : { d: loD, m: loM };
  return (
    `${String(la.d).padStart(2, "0")}${String(la.m).padStart(2, "0")}${lat >= 0 ? "N" : "S"}` +
    `/${String(lo.d).padStart(3, "0")}${String(lo.m).padStart(2, "0")}${lon >= 0 ? "E" : "W"}`
  );
}

/** Decimal degrees -> Airbus MCDU lat/long entry `4655.7N/06146.4W`. */
export function formatMcduFix(lat: number, lon: number): string {
  const laD = Math.floor(Math.abs(lat));
  const laM = (Math.abs(lat) - laD) * 60;
  const loD = Math.floor(Math.abs(lon));
  const loM = (Math.abs(lon) - loD) * 60;
  return (
    `${String(laD).padStart(2, "0")}${laM.toFixed(1).padStart(4, "0")}${lat >= 0 ? "N" : "S"}` +
    `/${String(loD).padStart(3, "0")}${loM.toFixed(1).padStart(4, "0")}${lon >= 0 ? "E" : "W"}`
  );
}

export interface SimBriefRoute {
  /** `KJFK DCT 4656N/06146W DCT ... DCT EIDW` */
  route: string;
  /** Fixes skipped because the provider gave no coordinates. */
  skipped: string[];
  /** MCDU-format entries for the manual fallback, in plan order. */
  mcduEntries: { name: string; entry: string }[];
}

/**
 * Build the SimBrief route from plan fixes. Origin/destination become the
 * `orig`/`dest` URL params; enroute fixes with coordinates become DCT
 * lat/long waypoints (synthetic TRKxx/OCNxx names never leave the app).
 */
export function buildSimBriefRoute(origin: string, destination: string, fixes: RouteFix[]): SimBriefRoute {
  const skipped: string[] = [];
  const mcduEntries: { name: string; entry: string }[] = [];
  const legs: string[] = [];
  for (const f of fixes) {
    if (f.type === "origin" || f.type === "destination") continue;
    if (f.lat == null || f.lon == null) {
      skipped.push(f.name);
      continue;
    }
    legs.push(formatSimBriefFix(f.lat, f.lon));
    mcduEntries.push({ name: f.name, entry: formatMcduFix(f.lat, f.lon) });
  }
  const route = [origin, ...legs.flatMap((l) => ["DCT", l]), "DCT", destination].join(" ");
  return { route, skipped, mcduEntries };
}

export interface SimBriefUrlOptions {
  flightNumber: string;
  origin: string;
  destination: string;
  aircraftType: string | null; // ICAO, e.g. "A333"
  cruiseAltitudeFt: number | null;
  route: string;
}

/**
 * Prefilled SimBrief dispatch URL (pattern verified against working tools —
 * dispatch.simbrief.com/options/custom honors these params).
 */
export function buildSimBriefUrl(o: SimBriefUrlOptions): string {
  const p = new URLSearchParams();
  const split = splitFlightNumber(o.flightNumber);
  if (split.airlineIcao) p.set("airline", split.airlineIcao);
  if (split.number) p.set("fltnum", split.number);
  p.set("orig", o.origin);
  p.set("dest", o.destination);
  if (o.aircraftType) p.set("type", o.aircraftType.toUpperCase());
  if (o.route) p.set("route", o.route);
  if (o.cruiseAltitudeFt != null && o.cruiseAltitudeFt > 0) p.set("fl", String(Math.round(o.cruiseAltitudeFt / 100)));
  if (split.callsign) p.set("callsign", split.callsign);
  return `https://dispatch.simbrief.com/options/custom?${p.toString()}`;
}
