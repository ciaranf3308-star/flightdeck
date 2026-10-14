/**
 * User-imported track files — the "bring your own data" historical source.
 *
 * Supported formats (parsed defensively, dependency-free):
 * - CSV  — header row with some of: time/timestamp, lat/latitude, lon/lng/longitude,
 *          alt_ft/altitude_ft (feet) or alt_m/altitude_m/elev_m (meters -> ft).
 *          Time may be ISO-8601 or unix seconds.
 * - GPX  — <trkpt lat=".." lon=".."> with <time> and <ele> (meters -> ft).
 * - KML  — <coordinates>lon,lat,alt ...</coordinates> (alt meters -> ft).
 *
 * Provenance is ALWAYS "imported": the data is taken as-is from the user's
 * file and is not independently verified. The filename is recorded as the
 * source. Nothing is ever synthesized to fill gaps.
 */
import type { TrackPoint } from "@flightdeck/shared-models";

export type ImportFormat = "csv" | "gpx" | "kml";

export interface ParsedImport {
  format: ImportFormat;
  filename: string;
  points: TrackPoint[];
  warnings: string[];
}

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

const M_TO_FT = 3.28084;

function detectFormat(filename: string, content: string): ImportFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".gpx")) return "gpx";
  if (lower.endsWith(".kml")) return "kml";
  if (lower.endsWith(".csv")) return "csv";
  const t = content.trimStart().slice(0, 200).toLowerCase();
  if (t.startsWith("<gpx")) return "gpx";
  if (t.startsWith("<kml") || t.includes("<coordinates>")) return "kml";
  return "csv";
}

function parseTime(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    // heuristics: >1e12 = ms, >1e9 = s
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

function validLatLon(lat: number | null, lon: number | null): lat is number {
  return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

function splitCsvLine(line: string): string[] {
  // minimal CSV: handles quoted fields with commas
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === "," || c === ";") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(content: string, source: string): { points: TrackPoint[]; warnings: string[] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new ImportParseError("CSV has no data rows.");
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""));
  const find = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iTime = find("time", "timestamp", "datetime", "utc");
  const iLat = find("lat", "latitude");
  const iLon = find("lon", "lng", "long", "longitude");
  const iAltFt = find("altft", "altitudeft", "altitude", "alt");
  const iAltM = find("altm", "altitudem", "elevm", "ele", "elevationm");
  if (iLat < 0 || iLon < 0) {
    throw new ImportParseError(
      `CSV needs latitude and longitude columns (found header: ${lines[0].trim()}).`,
    );
  }
  const warnings: string[] = [];
  if (iTime < 0) warnings.push("No time column — points will be ordered by file order with synthetic spacing.");
  if (iAltFt < 0 && iAltM < 0) warnings.push("No altitude column — altitudes recorded as unknown.");
  const points: TrackPoint[] = [];
  const base = Date.now();
  lines.slice(1).forEach((line, idx) => {
    const cols = splitCsvLine(line);
    const lat = num(cols[iLat]);
    const lon = num(cols[iLon]);
    if (!validLatLon(lat, lon)) return;
    const altFt = iAltFt >= 0 ? num(cols[iAltFt]) : iAltM >= 0 && num(cols[iAltM]) != null ? Math.round((num(cols[iAltM]) as number) * M_TO_FT) : null;
    const ts = iTime >= 0 ? parseTime(cols[iTime] ?? "") : new Date(base + idx * 1000).toISOString();
    points.push({
      timestamp: ts ?? new Date(base + idx * 1000).toISOString(),
      lat: lat as number,
      lon: lon as number,
      altitudeFt: altFt,
      groundspeedKt: null,
      headingDeg: null,
      provenance: "imported",
    });
  });
  if (points.length < 2) throw new ImportParseError("CSV yielded fewer than 2 valid positions.");
  return { points, warnings };
}

function parseGpx(content: string): { points: TrackPoint[]; warnings: string[] } {
  const warnings: string[] = [];
  const points: TrackPoint[] = [];
  const re = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"\s*>([\s\S]*?)<\/trkpt\s*>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  const base = Date.now();
  while ((m = re.exec(content)) !== null) {
    const lat = num(m[1]);
    const lon = num(m[2]);
    if (!validLatLon(lat, lon)) continue;
    const inner = m[3];
    const tM = /<time>([^<]+)<\/time>/i.exec(inner);
    const eM = /<ele>([^<]+)<\/ele>/i.exec(inner);
    const eleM = eM ? num(eM[1]) : null;
    points.push({
      timestamp: (tM && parseTime(tM[1])) || new Date(base + idx * 1000).toISOString(),
      lat: lat as number,
      lon: lon as number,
      altitudeFt: eleM == null ? null : Math.round(eleM * M_TO_FT),
      groundspeedKt: null,
      headingDeg: null,
      provenance: "imported",
    });
    idx++;
  }
  if (points.length < 2) {
    throw new ImportParseError("GPX yielded fewer than 2 valid <trkpt> positions.");
  }
  if (points.some((p) => p.altitudeFt == null)) warnings.push("Some track points have no elevation.");
  return { points, warnings };
}

function parseKml(content: string): { points: TrackPoint[]; warnings: string[] } {
  const warnings: string[] = ["KML carries no timestamps — points are ordered as listed."];
  const points: TrackPoint[] = [];
  const base = Date.now();
  const re = /<coordinates>([\s\S]*?)<\/coordinates>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(content)) !== null) {
    const tuples = m[1].trim().split(/\s+/);
    for (const t of tuples) {
      const parts = t.split(",");
      if (parts.length < 2) continue;
      const lon = num(parts[0]);
      const lat = num(parts[1]);
      if (!validLatLon(lat, lon)) continue;
      const altM = parts.length >= 3 ? num(parts[2]) : null;
      points.push({
        timestamp: new Date(base + idx * 1000).toISOString(),
        lat: lat as number,
        lon: lon as number,
        altitudeFt: altM == null ? null : Math.round(altM * M_TO_FT),
        groundspeedKt: null,
        headingDeg: null,
        provenance: "imported",
      });
      idx++;
    }
  }
  if (points.length < 2) throw new ImportParseError("KML yielded fewer than 2 valid coordinates.");
  return { points, warnings };
}

/** Parse a user-supplied track file. Never throws for unknown content — throws ImportParseError with a clear reason. */
export function parseTrackFile(filename: string, content: string): ParsedImport {
  if (!content || content.trim().length === 0) throw new ImportParseError("File is empty.");
  if (content.length > 10 * 1024 * 1024) throw new ImportParseError("File is larger than 10 MB — trim the track first.");
  const format = detectFormat(filename, content);
  const { points, warnings } =
    format === "gpx" ? parseGpx(content) : format === "kml" ? parseKml(content) : parseCsv(content, filename);
  return { format, filename, points, warnings };
}
