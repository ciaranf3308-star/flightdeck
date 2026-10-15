/**
 * Live simulator navdata (Feature: automatic procedure selection).
 *
 * The sim's own nav database — the same one the EFB flight planner reads —
 * is queried over SimConnect facility data by the bridge
 * (`--fetch-procedures`), cached here in SQLite, and overlaid onto the
 * bundled fixture navdata. When sim procedures exist for an airport, the
 * route engine selects from them (provenance "verified", real cycle tag) and
 * the PLN exporter emits the real SID/STAR/approach names; otherwise the
 * previous fixture behavior applies unchanged.
 *
 * Cycle tagging: facility data carries no AIRAC cycle identifier, so cached
 * entries are tagged `SIM-YYYYMMDD` (the fetch date) — honest about what was
 * verified and when. If the user updates their sim navdata, refetch.
 */
import { db } from "./db.js";
import type { DatabaseSync } from "node:sqlite";
import type { NavDatabase } from "@flightdeck/navigation";
import { AirportNavData, Procedure } from "@flightdeck/shared-models";

export interface SimProcedureInput {
  kind: "SID" | "STAR" | "APPROACH";
  name: string;
  runways: string[];
  transitions: string[];
  transitionPositions: Record<string, { lat: number; lon: number }>;
  approachType?: string | null;
}

export interface SimNavdataStatus {
  icao: string;
  cached: boolean;
  cycle: string | null;
  fetchedAt: string | null;
  counts: { SID: number; STAR: number; APPROACH: number };
}

/** Tag for "verified against the sim's navdata on this date". */
export function simCycleTag(date = new Date()): string {
  return `SIM-${date.toISOString().slice(0, 10)}`;
}

/** DDL for the sim-navdata cache; called once per database handle. */
export function initSimNavdataTables(handle: DatabaseSync): void {
  handle.exec(`
CREATE TABLE IF NOT EXISTS sim_navdata_airports (
  icao TEXT PRIMARY KEY,
  cycle TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'simconnect',
  fetched_at TEXT NOT NULL,
  n_sid INTEGER NOT NULL DEFAULT 0,
  n_star INTEGER NOT NULL DEFAULT 0,
  n_approach INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sim_navdata_procedures (
  icao TEXT NOT NULL,
  kind TEXT NOT NULL, -- SID | STAR | APPROACH
  name TEXT NOT NULL,
  runways_json TEXT NOT NULL, -- e.g. ["31L","31R"]
  transitions_json TEXT NOT NULL, -- enroute transition names
  transition_positions_json TEXT NOT NULL DEFAULT '{}', -- name -> {lat,lon}
  approach_type TEXT, -- ILS | RNAV | ... (APPROACH only)
  cycle TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (icao, kind, name)
);`);
}

initSimNavdataTables(db);

export function storeSimNavdata(
  handle: DatabaseSync,
  icaoInput: string,
  procedures: SimProcedureInput[],
  cycle?: string,
): SimNavdataStatus {
  const icao = icaoInput.toUpperCase();
  const tag = cycle ?? simCycleTag();
  const fetchedAt = new Date().toISOString();
  const counts = { SID: 0, STAR: 0, APPROACH: 0 };
  const upsert = handle.prepare(`
    INSERT INTO sim_navdata_procedures
      (icao, kind, name, runways_json, transitions_json, transition_positions_json,
       approach_type, cycle, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(icao, kind, name) DO UPDATE SET
      runways_json=excluded.runways_json, transitions_json=excluded.transitions_json,
      transition_positions_json=excluded.transition_positions_json,
      approach_type=excluded.approach_type, cycle=excluded.cycle, fetched_at=excluded.fetched_at
  `);
  const txn = () => {
    handle.prepare("DELETE FROM sim_navdata_procedures WHERE icao = ?").run(icao);
    for (const p of procedures) {
      if (p.kind !== "SID" && p.kind !== "STAR" && p.kind !== "APPROACH") continue;
      if (!p.name) continue;
      upsert.run(
        icao, p.kind, p.name.toUpperCase(),
        JSON.stringify(p.runways ?? []),
        JSON.stringify(p.transitions ?? []),
        JSON.stringify(p.transitionPositions ?? {}),
        p.approachType ?? null, tag, fetchedAt,
      );
      counts[p.kind]++;
    }
    handle.prepare(`
      INSERT INTO sim_navdata_airports (icao, cycle, source, fetched_at, n_sid, n_star, n_approach)
      VALUES (?, ?, 'simconnect', ?, ?, ?, ?)
      ON CONFLICT(icao) DO UPDATE SET
        cycle=excluded.cycle, fetched_at=excluded.fetched_at,
        n_sid=excluded.n_sid, n_star=excluded.n_star, n_approach=excluded.n_approach
    `).run(icao, tag, fetchedAt, counts.SID, counts.STAR, counts.APPROACH);
  };
  txn();
  return getSimNavdataStatus(handle, icao);
}

export function getSimNavdataStatus(handle: DatabaseSync, icaoInput: string): SimNavdataStatus {
  const icao = icaoInput.toUpperCase();
  const row = handle
    .prepare("SELECT cycle, fetched_at, n_sid, n_star, n_approach FROM sim_navdata_airports WHERE icao = ?")
    .get(icao) as
    | { cycle: string; fetched_at: string; n_sid: number; n_star: number; n_approach: number }
    | undefined;
  if (!row) return { icao, cached: false, cycle: null, fetchedAt: null, counts: { SID: 0, STAR: 0, APPROACH: 0 } };
  return {
    icao, cached: true, cycle: row.cycle, fetchedAt: row.fetched_at,
    counts: { SID: row.n_sid, STAR: row.n_star, APPROACH: row.n_approach },
  };
}

/**
 * Expand sim rows into engine Procedures. A procedure serving several
 * runways becomes one Procedure per runway (the engine filters by runway),
 * all sharing the published name.
 */
export function simProceduresToEngine(handle: DatabaseSync, icaoInput: string): Procedure[] | null {
  const icao = icaoInput.toUpperCase();
  const status = getSimNavdataStatus(handle, icao);
  if (!status.cached) return null;
  const rows = handle
    .prepare(
      `SELECT kind, name, runways_json, transitions_json, transition_positions_json,
              approach_type, cycle FROM sim_navdata_procedures WHERE icao = ?`,
    )
    .all(icao) as {
    kind: string; name: string; runways_json: string; transitions_json: string;
    transition_positions_json: string; approach_type: string | null; cycle: string;
  }[];
  const out: Procedure[] = [];
  for (const r of rows) {
    let runways: string[] = [];
    let transitions: string[] = [];
    let positions: Record<string, { lat: number; lon: number }> = {};
    try {
      runways = JSON.parse(r.runways_json);
      transitions = JSON.parse(r.transitions_json);
      positions = JSON.parse(r.transition_positions_json) ?? {};
    } catch {
      continue; // corrupt row: skip rather than emit a broken procedure
    }
    const approachKind =
      r.kind === "APPROACH"
        ? (r.approach_type === "ILS" || r.approach_type === "RNAV" || r.approach_type === "VOR" || r.approach_type === "NDB"
            ? r.approach_type
            : "OTHER")
        : null;
    const runwaysOrNull = runways.length > 0 ? runways : [null];
    for (const rwy of runwaysOrNull) {
      out.push({
        id: r.name,
        kind: r.kind as "SID" | "STAR" | "APPROACH",
        airport: icao,
        runway: rwy,
        transitions,
        transitionPositions: positions,
        approachKind,
        waypoints: [],
        constraints: [],
        navdataCycle: r.cycle,
        provenance: "verified",
        note: `Live simulator navdata (${r.cycle}) via SimConnect facility data.`,
      });
    }
  }
  return out;
}

/**
 * NavDatabase overlay: when sim procedures are cached for an airport they
 * replace the fixture procedures (runways/airport info stay from fixtures).
 * Everything else passes through untouched.
 */
export class SimNavDataOverlay implements NavDatabase {
  readonly cycle: string;
  constructor(
    private readonly inner: NavDatabase,
    private readonly handle: DatabaseSync = db,
  ) {
    this.cycle = inner.cycle;
  }
  async getAirport(icao: string): Promise<AirportNavData | null> {
    const base = await this.inner.getAirport(icao);
    if (!base) return null;
    const simProcedures = simProceduresToEngine(this.handle, icao);
    if (!simProcedures) return base;
    const status = getSimNavdataStatus(this.handle, icao);
    return {
      ...base,
      procedures: simProcedures,
      navdataCycle: status.cycle ?? base.navdataCycle,
      provenance: "verified",
      note:
        `Live simulator navdata (${status.cycle ?? "unknown cycle"}) via SimConnect: ` +
        `${status.counts.SID} SIDs, ${status.counts.STAR} STARs, ${status.counts.APPROACH} approaches.`,
    };
  }
  listAirports(): Promise<string[]> {
    return this.inner.listAirports();
  }
  resolvePosition(icao: string): Promise<{ lat: number; lon: number } | null> {
    return this.inner.resolvePosition(icao);
  }
}
