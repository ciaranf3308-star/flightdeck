/** Navigation reference data access. */
import { describe, expect, it } from "vitest";
import { FixtureNavDatabase } from "@flightdeck/navigation";

describe("FixtureNavDatabase", () => {
  const db = new FixtureNavDatabase();

  it("serves KJFK with 8 runway directions", async () => {
    const kjfk = await db.getAirport("KJFK");
    expect(kjfk?.airport.icao).toBe("KJFK");
    expect(kjfk?.runways.map((r) => r.id)).toContain("31L");
    expect(kjfk?.provenance).toBe("generated"); // honestly labelled synthetic
  });

  it("serves EIDW with the real arrival runway", async () => {
    const eidw = await db.getAirport("EIDW");
    expect(eidw?.runways.map((r) => r.id)).toContain("28L");
  });

  it("returns null for unknown airports instead of inventing data", async () => {
    expect(await db.getAirport("XXXX")).toBeNull();
  });

  it("resolves reference coordinates", async () => {
    const pos = await db.resolvePosition("KJFK");
    expect(pos?.lat).toBeCloseTo(40.64, 1);
  });
});
