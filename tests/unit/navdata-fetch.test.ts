/** Parser for SimConnect facility payloads: verified against synthetic buffers. */
import { describe, expect, it } from "vitest";
import {
  FacilityParseError,
  approachKindOf,
  approachSuffixChar,
  parseAirportFacility,
  runwayName,
  toSimProcedureInputs,
} from "../../services/navdata-fetch/parse-facility.mjs";

// Build a payload in the exact field order the fetcher defines.
function buildPayload({ runways = [], sids = [], stars = [], approaches = [] }) {
  const parts = [];
  const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const c8 = (s) => {
    const b = Buffer.alloc(8, 0);
    b.write(s.slice(0, 8), "ascii");
    parts.push(b);
  };
  const proc = (p) => {
    c8(p.name);
    i32(p.runways.length);
    i32(p.transitions.length);
    for (const r of p.runways) {
      const m = r.match(/^(\d{2})([LRC]?)$/);
      i32(Number(m[1]));
      i32({ L: 1, R: 2, C: 3 }[m[2]] ?? 0);
    }
    for (const t of p.transitions) c8(t);
  };
  i32(runways.length);
  i32(sids.length);
  i32(stars.length);
  i32(approaches.length);
  for (const r of runways) {
    const [p, s] = [r.p, r.s];
    const pm = p.match(/^(\d{2})([LRC]?)$/);
    const sm = s.match(/^(\d{2})([LRC]?)$/);
    i32(Number(pm[1]));
    i32({ L: 1, R: 2, C: 3 }[pm[2]] ?? 0);
    i32(Number(sm[1]));
    i32({ L: 1, R: 2, C: 3 }[sm[2]] ?? 0);
    c8(r.pIls ?? "");
    c8(r.sIls ?? "");
  }
  for (const s of sids) proc(s);
  for (const s of stars) proc(s);
  for (const a of approaches) {
    i32(a.type);
    i32(a.suffix ?? 0);
    const m = a.runway.match(/^(\d{2})([LRC]?)$/);
    i32(Number(m[1]));
    i32({ L: 1, R: 2, C: 3 }[m[2]] ?? 0);
    i32(a.transitions.length);
    for (const t of a.transitions) c8(t);
  }
  return Buffer.concat(parts);
}

const SAMPLE = buildPayload({
  runways: [{ p: "31L", s: "13R", pIls: "IJFK", sIls: "" }],
  sids: [{ name: "SKORR4", runways: ["31L"], transitions: ["SKORR", "MERIT"] }],
  stars: [{ name: "BAGSO1L", runways: ["28L"], transitions: ["BAGSO"] }],
  approaches: [
    { type: 4, suffix: 0, runway: "28L", transitions: ["BAGSO"] }, // ILS
    { type: 10, suffix: 90, runway: "28L", transitions: [] }, // RNAV Z (90='Z')
    { type: 5, suffix: 0, runway: "28L", transitions: [] }, // LOCALIZER: no EFB mapping -> skipped
  ],
});

describe("runwayName / approachSuffixChar / approachKindOf", () => {
  it("formats runway ends", () => {
    expect(runwayName(31, 1)).toBe("31L");
    expect(runwayName(4, 0)).toBe("04");
    expect(runwayName(0, 1)).toBeNull();
    expect(runwayName(37, 0)).toBeNull();
  });
  it("converts suffix codes", () => {
    expect(approachSuffixChar(90)).toBe("Z");
    expect(approachSuffixChar(0)).toBe("");
  });
  it("maps approach types honestly", () => {
    expect(approachKindOf(4)).toBe("ILS");
    expect(approachKindOf(10)).toBe("RNAV");
    expect(approachKindOf(1)).toBe("RNAV");
    expect(approachKindOf(8)).toBe("VOR");
    expect(approachKindOf(9)).toBe("NDB");
    expect(approachKindOf(5)).toBeNull(); // LOCALIZER: no EFB mapping, skipped
    expect(approachKindOf(0)).toBeNull();
  });
});

describe("parseAirportFacility", () => {
  it("parses a full payload", () => {
    const p = parseAirportFacility(SAMPLE);
    expect(p.runways).toEqual([{ runway: "31L", ils: "IJFK" }, { runway: "13R", ils: null }]);
    expect(p.sids).toEqual([{ kind: "SID", name: "SKORR4", runways: ["31L"], transitions: ["SKORR", "MERIT"] }]);
    expect(p.stars).toEqual([{ kind: "STAR", name: "BAGSO1L", runways: ["28L"], transitions: ["BAGSO"] }]);
    expect(p.approaches).toHaveLength(2); // LOCALIZER skipped
    expect(p.approaches[0]).toEqual({
      kind: "APPROACH", approachType: "ILS", name: "ILS28L", runways: ["28L"], transitions: ["BAGSO"],
    });
    expect(p.approaches[1].name).toBe("RNAVZ28L");
  });
  it("parses an empty airport without failing", () => {
    const p = parseAirportFacility(buildPayload({}));
    expect(p).toEqual({ runways: [], sids: [], stars: [], approaches: [] });
  });
  it("rejects truncated payloads instead of returning half data", () => {
    expect(() => parseAirportFacility(SAMPLE.subarray(0, 10))).toThrow(FacilityParseError);
    expect(() => parseAirportFacility(SAMPLE.subarray(0, SAMPLE.length - 4))).toThrow(FacilityParseError);
  });
  it("rejects insane counts", () => {
    const bad = Buffer.alloc(16);
    bad.writeInt32LE(99999, 0);
    expect(() => parseAirportFacility(bad)).toThrow(FacilityParseError);
  });
});

describe("toSimProcedureInputs", () => {
  it("produces the API ingest shape", () => {
    const inputs = toSimProcedureInputs(parseAirportFacility(SAMPLE));
    expect(inputs).toHaveLength(4);
    const sid = inputs.find((i) => i.kind === "SID");
    expect(sid).toMatchObject({ name: "SKORR4", runways: ["31L"], transitions: ["SKORR", "MERIT"] });
    const appr = inputs.find((i) => i.kind === "APPROACH" && i.approachType === "ILS");
    expect(appr).toMatchObject({ name: "ILS28L", runways: ["28L"], approachType: "ILS" });
  });
});
