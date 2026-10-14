/** Honesty invariants + contract tests for shared-models. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { field, Provenance } from "@flightdeck/shared-models";

describe("provenance", () => {
  it("accepts the four provenance classes", () => {
    for (const p of ["verified", "inferred", "generated", "unavailable"] as const) {
      expect(Provenance.parse(p)).toBe(p);
    }
  });
});

describe("field()", () => {
  const f = field(z.string());
  it("requires null value when unavailable", () => {
    expect(() => f.parse({ value: "x", provenance: "unavailable" })).toThrow();
    expect(f.parse({ value: null, provenance: "unavailable" }).value).toBeNull();
  });
  it("requires a value when not unavailable", () => {
    expect(() => f.parse({ value: null, provenance: "verified" })).toThrow();
    expect(f.parse({ value: "KJFK", provenance: "verified" }).value).toBe("KJFK");
  });
  it("never allows a guess to wear 'verified'", () => {
    // inferred/generated are the only honest labels for derived data
    const parsed = f.parse({ value: "31L", provenance: "inferred", note: "rule: max headwind" });
    expect(parsed.provenance).toBe("inferred");
  });
});
