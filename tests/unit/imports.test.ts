import { describe, expect, it } from "vitest";
import { ImportParseError, parseTrackFile } from "../../packages/flight-providers/src/imports.js";

const CSV = `time,lat,lon,alt_ft
2026-10-06T09:50:00Z,40.6413,-73.7781,0
2026-10-06T11:00:00Z,41.5,-71.0,35000
2026-10-06T14:00:00Z,53.4214,-6.2701,0
`;

const CSV_UNIX_METERS = `timestamp;latitude;longitude;alt_m
1791280200;40.6413;-73.7781;0
1791291600;45.0;-60.0;10668
`;

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
<trkpt lat="40.6413" lon="-73.7781"><ele>0</ele><time>2026-10-06T09:50:00Z</time></trkpt>
<trkpt lat="45.0" lon="-60.0"><ele>10668</ele><time>2026-10-06T12:00:00Z</time></trkpt>
<trkpt lat="53.4214" lon="-6.2701"><ele>0</ele><time>2026-10-06T14:00:00Z</time></trkpt>
</trkseg></trk></gpx>`;

const KML = `<?xml version="1.0"?>
<kml><Document><Placemark><LineString><coordinates>
-73.7781,40.6413,0 -60.0,45.0,10668 -6.2701,53.4214,0
</coordinates></LineString></Placemark></Document></kml>`;

describe("track file imports", () => {
  it("parses CSV with ISO times and feet", () => {
    const r = parseTrackFile("ei106.csv", CSV);
    expect(r.format).toBe("csv");
    expect(r.points).toHaveLength(3);
    expect(r.points[1]).toMatchObject({ lat: 41.5, lon: -71.0, altitudeFt: 35000, provenance: "imported" });
    expect(r.points[0].timestamp).toBe("2026-10-06T09:50:00.000Z");
  });

  it("parses semicolon CSV with unix times and meter altitudes", () => {
    const r = parseTrackFile("track.csv", CSV_UNIX_METERS);
    expect(r.points).toHaveLength(2);
    expect(r.points[1].altitudeFt).toBe(Math.round(10668 * 3.28084));
  });

  it("parses GPX (elevation meters -> feet)", () => {
    const r = parseTrackFile("flight.gpx", GPX);
    expect(r.format).toBe("gpx");
    expect(r.points).toHaveLength(3);
    expect(r.points[1].altitudeFt).toBe(Math.round(10668 * 3.28084));
  });

  it("parses KML coordinates (lon,lat,alt) with an honest timestamp warning", () => {
    const r = parseTrackFile("flight.kml", KML);
    expect(r.format).toBe("kml");
    expect(r.points).toHaveLength(3);
    expect(r.points[0]).toMatchObject({ lat: 40.6413, lon: -73.7781 });
    expect(r.warnings.some((w) => w.includes("no timestamps"))).toBe(true);
  });

  it("rejects empty files, files without positions, and oversized files", () => {
    expect(() => parseTrackFile("x.csv", "")).toThrow(ImportParseError);
    expect(() => parseTrackFile("x.csv", "time,lat,lon\n2026-10-06T00:00:00Z,999,999\n")).toThrow(ImportParseError);
    expect(() => parseTrackFile("x.csv", "time,lat,lon\n")).toThrow(ImportParseError);
    expect(() => parseTrackFile("x.csv", "time,foo\n2026-10-06T00:00:00Z,1\n")).toThrow(/latitude and longitude/);
    expect(() => parseTrackFile("x.csv", "x".repeat(11 * 1024 * 1024))).toThrow(/10 MB/);
  });

  it("skips invalid rows but keeps valid ones", () => {
    const r = parseTrackFile(
      "x.csv",
      "time,lat,lon,alt_ft\n2026-10-06T09:50:00Z,40.6413,-73.7781,0\nbad,row\n2026-10-06T14:00:00Z,53.4214,-6.2701,0\n",
    );
    expect(r.points).toHaveLength(2);
  });
});
