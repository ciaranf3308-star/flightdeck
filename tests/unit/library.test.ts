import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createCategory,
  deleteCategory,
  deleteFlight,
  findFlight,
  initLibraryTables,
  listCategories,
  listFlights,
  parseStringArray,
  saveFlight,
  updateCategory,
  updateFlight,
} from "../../services/planning-api/src/library.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initLibraryTables(db);
  return db;
}

describe("library store", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = freshDb();
  });

  it("saves and lists flights with categories", () => {
    const cat = createCategory(db, "Transatlantic", "#38bdf8");
    const f = saveFlight(db, {
      flightNumber: "ei106",
      date: "2026-10-09",
      origin: "KJFK",
      destination: "EIDW",
      aircraftType: "A333",
      registration: "EI-EAV",
      depRunway: "31L",
      arrRunway: "28L",
      cruiseAltitude: 35000,
      routeNames: ["KJFK", "MERIT", "EIDW"],
      categoryIds: [cat.id],
      note: "Reference flight",
    });
    expect(f.flightNumber).toBe("EI106"); // normalized
    expect(f.categoryIds).toEqual([cat.id]);
    const all = listFlights(db);
    expect(all).toHaveLength(1);
    expect(all[0].note).toBe("Reference flight");
  });

  it("rejects invalid input", () => {
    expect(() => saveFlight(db, { flightNumber: "", date: "2026-10-09" })).toThrow();
    expect(() => saveFlight(db, { flightNumber: "EI106", date: "not-a-date" })).toThrow();
    expect(() => createCategory(db, "   ")).toThrow();
  });

  it("updates note and categories; deleting a flight works", () => {
    const f = saveFlight(db, { flightNumber: "EI106", date: "2026-10-09" });
    const c1 = createCategory(db, "A", "#38bdf8");
    const c2 = createCategory(db, "B", "#a78bfa");
    const updated = updateFlight(db, f.id, { note: "hello", categoryIds: [c1.id, c2.id] });
    expect(updated?.note).toBe("hello");
    expect(updated?.categoryIds).toEqual([c1.id, c2.id]);
    expect(updateFlight(db, "nope", { note: "x" })).toBeNull();
    expect(deleteFlight(db, f.id)).toBe(true);
    expect(findFlight(db, f.id)).toBeNull();
    expect(deleteFlight(db, f.id)).toBe(false);
  });

  it("deleting a category strips it from saved flights", () => {
    const keep = createCategory(db, "Keep", "#38bdf8");
    const drop = createCategory(db, "Drop", "#f472b6");
    const f = saveFlight(db, { flightNumber: "EI106", date: "2026-10-09", categoryIds: [keep.id, drop.id] });
    expect(deleteCategory(db, drop.id)).toBe(true);
    expect(deleteCategory(db, drop.id)).toBe(false);
    const after = findFlight(db, f.id);
    expect(after?.categoryIds).toEqual([keep.id]);
    expect(listCategories(db).map((c) => c.id)).toEqual([keep.id]);
  });

  it("renames and recolors a category; falls back on bad color", () => {
    const c = createCategory(db, "Old", "#38bdf8");
    const renamed = updateCategory(db, c.id, { name: "New", color: "#fbbf24" });
    expect(renamed?.name).toBe("New");
    expect(renamed?.color).toBe("#fbbf24");
    const bad = updateCategory(db, c.id, { color: "not-a-color" });
    expect(bad?.color).toBe("#fbbf24"); // unchanged
    expect(updateCategory(db, "nope", { name: "x" })).toBeNull();
  });

  it("parseStringArray never throws and filters non-strings", () => {
    expect(parseStringArray('["a", 1, "b"]')).toEqual(["a", "b"]);
    expect(parseStringArray("garbage{")).toEqual([]);
    expect(parseStringArray(null)).toEqual([]);
    expect(parseStringArray(["x"])).toEqual(["x"]);
  });
});
