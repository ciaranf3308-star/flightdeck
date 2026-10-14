import { exportIniBuildsFpl } from "./packages/msfs-export/dist/index.js";
import { writeFileSync } from "node:fs";

// EI106 2026-10-09 flyable reference fixes (Airbus MCDU format -> decimal)
const mcdu = [
  ["TRK01", "4655.7N", "06146.4W"], ["OCN01", "5006.4N", "05136.2W"],
  ["OCN02", "5217.1N", "04014.1W"], ["OCN03", "5316.8N", "02801.7W"],
  ["TRK02", "5259.7N", "01537.2W"], ["TRK03", "5304.1N", "00805.8W"],
  ["TRK04", "5300.4N", "00641.4W"], ["TRK05", "5325.3N", "00615.7W"],
];
const dm = (s) => {
  const m = s.match(/(\d{2,3})(\d{2}\.\d)([NSWE])/);
  const v = parseInt(m[1]) + parseFloat(m[2]) / 60;
  return (m[3] === "S" || m[3] === "W") ? -v : v;
};
const fixes = [
  { name: "KJFK", lat: 40.6413, lon: -73.7781, type: "origin", provenance: "verified" },
  ...mcdu.map(([n, la, lo], i) => ({
    name: n, lat: dm(la), lon: dm(lo), type: "waypoint",
    provenance: n.startsWith("TRK") ? "inferred" : "generated",
    note: n.startsWith("TRK") ? "sampled from recorded ADS-B track" : "generated great-circle fill across coverage gap — NOT the actual flown path",
  })),
  { name: "EIDW", lat: 53.4214, lon: -6.2701, type: "destination", provenance: "verified" },
];
const plan = {
  id: "ei106-20261009", flightNumber: "EI106", date: "2026-10-09", mode: "historical",
  origin: { icao: "KJFK", name: "John F Kennedy Intl", position: { lat: 40.6413, lon: -73.7781 } },
  destination: { icao: "EIDW", name: "Dublin Intl", position: { lat: 53.4214, lon: -6.2701 } },
  aircraftType: "A333", registration: "EI-EAV", fixes, cruiseAltitudeFt: 37000,
  procedures: {
    departureRunway: { procedureId: null, runway: "31L", transition: null, navdataCycle: "2510", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
    sid: { procedureId: null, runway: null, transition: null, navdataCycle: "2510", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
    arrivalRunway: { procedureId: null, runway: "28L", transition: null, navdataCycle: "2510", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
    star: { procedureId: null, runway: null, transition: null, navdataCycle: "2510", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
    approach: { procedureId: null, runway: null, transition: null, navdataCycle: "2510", selectionReasons: [], warnings: [], confidence: { level: "high", score: 1, evidenceFor: [], evidenceAgainst: [], evidenceMissing: [] }, validationStatus: "valid" },
  },
  overrides: {}, navdataCycle: "2510", sourceRouteKind: "recorded_track",
  warnings: [], createdAt: new Date().toISOString(),
};
const r = exportIniBuildsFpl(plan);
writeFileSync(`/home/hatch/workspace/your_files/${r.filename}`, r.fpl);
console.log("wrote", r.filename);
console.log(r.fpl);
console.log("warnings:", JSON.stringify(r.warnings, null, 1));
