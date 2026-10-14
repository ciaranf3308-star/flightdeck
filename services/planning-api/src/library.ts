/**
 * Flight library: saved flights + user categories.
 *
 * A saved flight is a lightweight snapshot of a lookup (ident, date, route,
 * aircraft, runways) plus the user's own organization: categories (many to
 * many) and a free-text note. Re-opening a saved flight re-runs lookup/plan
 * through the normal pipeline so navdata and winds are fresh — the snapshot
 * is for display and filtering, not a frozen plan.
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export interface SavedFlight {
  id: string;
  flightNumber: string;
  date: string; // YYYY-MM-DD
  origin: string | null;
  destination: string | null;
  aircraftType: string | null;
  registration: string | null;
  depRunway: string | null;
  arrRunway: string | null;
  cruiseAltitude: number | null; // feet
  routeNames: string[];
  categoryIds: string[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface SaveFlightInput {
  flightNumber: string;
  date: string;
  origin?: string | null;
  destination?: string | null;
  aircraftType?: string | null;
  registration?: string | null;
  depRunway?: string | null;
  arrRunway?: string | null;
  cruiseAltitude?: number | null;
  routeNames?: string[];
  categoryIds?: string[];
  note?: string;
}

export function initLibraryTables(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS library_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#38bdf8',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS library_flights (
  id TEXT PRIMARY KEY,
  flight_number TEXT NOT NULL,
  flight_date TEXT NOT NULL,
  origin TEXT,
  destination TEXT,
  aircraft_type TEXT,
  registration TEXT,
  dep_runway TEXT,
  arr_runway TEXT,
  cruise_altitude INTEGER,
  route_names TEXT NOT NULL DEFAULT '[]',
  category_ids TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_library_flights_updated ON library_flights(updated_at DESC);
`);
}

/** Parse a JSON-encoded string array defensively; never throws. */
export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    } catch {
      /* fall through */
    }
  }
  return [];
}

function rowToFlight(row: Record<string, unknown>): SavedFlight {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    id: String(row.id),
    flightNumber: String(row.flight_number),
    date: String(row.flight_date),
    origin: str(row.origin),
    destination: str(row.destination),
    aircraftType: str(row.aircraft_type),
    registration: str(row.registration),
    depRunway: str(row.dep_runway),
    arrRunway: str(row.arr_runway),
    cruiseAltitude: num(row.cruise_altitude),
    routeNames: parseStringArray(row.route_names),
    categoryIds: parseStringArray(row.category_ids),
    note: typeof row.note === "string" ? row.note : "",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToCategory(row: Record<string, unknown>): Category {
  return {
    id: String(row.id),
    name: String(row.name),
    color: typeof row.color === "string" && row.color.length > 0 ? row.color : "#38bdf8",
    createdAt: String(row.created_at),
  };
}

const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

export function listFlights(db: DatabaseSync): SavedFlight[] {
  const rows = db
    .prepare("SELECT * FROM library_flights ORDER BY updated_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToFlight);
}

/** Insert a saved flight. Throws on invalid flightNumber/date. */
export function saveFlight(db: DatabaseSync, input: SaveFlightInput): SavedFlight {
  const flightNumber = input.flightNumber.trim().toUpperCase();
  if (!flightNumber) throw new Error("flightNumber is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("date must be YYYY-MM-DD.");
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO library_flights
      (id, flight_number, flight_date, origin, destination, aircraft_type, registration,
       dep_runway, arr_runway, cruise_altitude, route_names, category_ids, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    flightNumber,
    input.date,
    strOrNull(input.origin),
    strOrNull(input.destination),
    strOrNull(input.aircraftType),
    strOrNull(input.registration),
    strOrNull(input.depRunway),
    strOrNull(input.arrRunway),
    typeof input.cruiseAltitude === "number" && Number.isFinite(input.cruiseAltitude)
      ? Math.round(input.cruiseAltitude)
      : null,
    JSON.stringify(parseStringArray(input.routeNames)),
    JSON.stringify(parseStringArray(input.categoryIds)),
    typeof input.note === "string" ? input.note.slice(0, 2000) : "",
    now,
    now,
  );
  const row = db.prepare("SELECT * FROM library_flights WHERE id = ?").get(id) as Record<
    string,
    unknown
  >;
  return rowToFlight(row);
}

export function findFlight(db: DatabaseSync, id: string): SavedFlight | null {
  const row = db.prepare("SELECT * FROM library_flights WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToFlight(row) : null;
}

/** Update note and/or categories. Returns null when the id does not exist. */
export function updateFlight(
  db: DatabaseSync,
  id: string,
  patch: { note?: string; categoryIds?: string[] },
): SavedFlight | null {
  const existing = findFlight(db, id);
  if (!existing) return null;
  const note = typeof patch.note === "string" ? patch.note.slice(0, 2000) : existing.note;
  const categoryIds = patch.categoryIds !== undefined ? parseStringArray(patch.categoryIds) : existing.categoryIds;
  db.prepare("UPDATE library_flights SET note = ?, category_ids = ?, updated_at = ? WHERE id = ?").run(
    note,
    JSON.stringify(categoryIds),
    new Date().toISOString(),
    id,
  );
  return findFlight(db, id);
}

export function deleteFlight(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM library_flights WHERE id = ?").run(id);
  return (result.changes as number) > 0;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export function listCategories(db: DatabaseSync): Category[] {
  const rows = db
    .prepare("SELECT * FROM library_categories ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToCategory);
}

/** Create a category. Throws on empty name. */
export function createCategory(db: DatabaseSync, name: string, color?: string): Category {
  const clean = name.trim().slice(0, 40);
  if (!clean) throw new Error("Category name is required.");
  const id = randomUUID();
  const now = new Date().toISOString();
  const safeColor = typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#38bdf8";
  db.prepare("INSERT INTO library_categories(id, name, color, created_at) VALUES(?, ?, ?, ?)").run(
    id,
    clean,
    safeColor,
    now,
  );
  return { id, name: clean, color: safeColor, createdAt: now };
}

/** Rename / recolor. Returns null when the id does not exist. */
export function updateCategory(
  db: DatabaseSync,
  id: string,
  patch: { name?: string; color?: string },
): Category | null {
  const rows = db.prepare("SELECT * FROM library_categories WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!rows) return null;
  const current = rowToCategory(rows);
  const name =
    typeof patch.name === "string" && patch.name.trim().length > 0
      ? patch.name.trim().slice(0, 40)
      : current.name;
  const color =
    typeof patch.color === "string" && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color : current.color;
  db.prepare("UPDATE library_categories SET name = ?, color = ? WHERE id = ?").run(name, color, id);
  return { ...current, name, color };
}

/**
 * Delete a category and strip it from every saved flight's category list.
 * Returns false when the id does not exist.
 */
export function deleteCategory(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM library_categories WHERE id = ?").run(id);
  if ((result.changes as number) === 0) return false;
  const flights = db.prepare("SELECT id, category_ids FROM library_flights").all() as {
    id: string;
    category_ids: string;
  }[];
  const now = new Date().toISOString();
  for (const f of flights) {
    const ids = parseStringArray(f.category_ids).filter((c) => c !== id);
    db.prepare("UPDATE library_flights SET category_ids = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(ids),
      now,
      f.id,
    );
  }
  return true;
}
