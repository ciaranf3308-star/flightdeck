/**
 * User-taught procedures ("teach once").
 *
 * Why this exists: the bundled navdata is synthetic fixtures, and the PLN
 * exporter refuses to emit invented procedure names — so a PLN built from
 * fixtures carries runways only, and the sim's EFB shows "Arrival: None" /
 * "Approach: None". The full-auto path (bridge --fetch-procedures reading the
 * sim's own nav database) needs a Windows bridge build the user may not have
 * done. Until then: the user reads the real procedure names off the EFB's own
 * ADD ARRIVAL / ADD APPROACH lists once per airport+runway, FlightDeck
 * remembers them, and every future plan for that airport+runway exports the
 * real names — no more manual EFB procedure selection.
 *
 * Honesty: taught names are provenance "imported" (user-supplied from the
 * sim's EFB), never "verified" — FlightDeck did not read them from navdata
 * itself. They beat fixture selection deterministically but never beat an
 * explicit per-plan override.
 */
import { db } from "./db.js";
import type { DatabaseSync } from "node:sqlite";
import type { NavDatabase } from "@flightdeck/navigation";
import { AirportNavData, ApproachKind, FlightPlan, Procedure } from "@flightdeck/shared-models";

export type UserProcedureKind = "SID" | "STAR" | "APPROACH";

export interface UserProcedure {
  icao: string;
  runway: string;
  kind: UserProcedureKind;
  name: string;
  transition: string | null;
  approachKind: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserProcedureInput {
  icao: string;
  runway: string;
  kind: UserProcedureKind;
  name: string;
  transition?: string | null;
  approachKind?: string | null;
}

/** DDL for the teach-once store; called once per database handle. */
export function initUserProcedureTables(handle: DatabaseSync): void {
  handle.exec(`
CREATE TABLE IF NOT EXISTS user_procedures (
  icao TEXT NOT NULL,
  runway TEXT NOT NULL,
  kind TEXT NOT NULL, -- SID | STAR | APPROACH
  name TEXT NOT NULL,
  transition TEXT,
  approach_kind TEXT,
  source TEXT NOT NULL DEFAULT 'user-efb',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (icao, runway, kind)
);
`);
}

function normIcao(v: unknown): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(s)) throw new Error("icao must be a 4-letter airport code.");
  return s;
}

function normName(v: unknown, field: string): string {
  const s = String(v ?? "").trim().toUpperCase();
  if (!s) throw new Error(`${field} is required.`);
  if (s.length > 32) throw new Error(`${field} is too long.`);
  return s;
}

/** Insert or replace the taught procedure for an airport+runway+kind. */
export function saveUserProcedure(handle: DatabaseSync, input: UserProcedureInput): UserProcedure {
  const icao = normIcao(input.icao);
  const runway = normName(input.runway, "runway");
  const kind = input.kind;
  if (kind !== "SID" && kind !== "STAR" && kind !== "APPROACH") throw new Error("kind must be SID, STAR or APPROACH.");
  const name = normName(input.name, "name");
  const transition = input.transition ? normName(input.transition, "transition") : null;
  let approachKind: string | null = null;
  if (kind === "APPROACH") {
    const ak = String(input.approachKind ?? "ILS").trim().toUpperCase();
    const parsed = ApproachKind.safeParse(ak);
    if (!parsed.success) throw new Error(`approachKind must be one of ${ApproachKind.options.join(", ")}.`);
    approachKind = parsed.data;
  }
  const now = new Date().toISOString();
  handle
    .prepare(
      `INSERT INTO user_procedures (icao, runway, kind, name, transition, approach_kind, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'user-efb', ?, ?)
       ON CONFLICT (icao, runway, kind) DO UPDATE SET
         name = excluded.name, transition = excluded.transition,
         approach_kind = excluded.approach_kind, updated_at = excluded.updated_at`,
    )
    .run(icao, runway, kind, name, transition, approachKind, now, now);
  return getUserProcedure(handle, icao, runway, kind) as UserProcedure;
}

export function getUserProcedure(
  handle: DatabaseSync,
  icao: string,
  runway: string,
  kind: UserProcedureKind,
): UserProcedure | null {
  const row = handle
    .prepare("SELECT * FROM user_procedures WHERE icao = ? AND runway = ? AND kind = ?")
    .get(icao.toUpperCase(), runway.toUpperCase(), kind) as Record<string, string | null> | undefined;
  if (!row) return null;
  return {
    icao: row.icao as string,
    runway: row.runway as string,
    kind: row.kind as UserProcedureKind,
    name: row.name as string,
    transition: row.transition,
    approachKind: row.approach_kind,
    source: row.source as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function listUserProcedures(handle: DatabaseSync, icao?: string): UserProcedure[] {
  const rows = (
    icao
      ? handle.prepare("SELECT * FROM user_procedures WHERE icao = ? ORDER BY runway, kind").all(icao.toUpperCase())
      : handle.prepare("SELECT * FROM user_procedures ORDER BY icao, runway, kind").all()
  ) as Record<string, string | null>[];
  return rows.map((row) => ({
    icao: row.icao as string,
    runway: row.runway as string,
    kind: row.kind as UserProcedureKind,
    name: row.name as string,
    transition: row.transition,
    approachKind: row.approach_kind,
    source: row.source as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));
}

export function deleteUserProcedure(handle: DatabaseSync, icao: string, runway: string, kind: string): boolean {
  const r = handle
    .prepare("DELETE FROM user_procedures WHERE icao = ? AND runway = ? AND kind = ?")
    .run(icao.toUpperCase(), runway.toUpperCase(), kind.toUpperCase());
  return Number(r.changes ?? 0) > 0;
}

/**
 * Exposes taught procedures as navdata so (a) the PLN exporter's
 * findProcedure resolves them — it only blocks provenance "generated" — and
 * (b) the Change dropdowns list them as "(saved)" options.
 */
export class UserProcedureOverlay implements NavDatabase {
  constructor(
    private readonly inner: NavDatabase,
    private readonly handle: DatabaseSync = db,
  ) {}

  get cycle(): string {
    return this.inner.cycle;
  }

  listAirports(): Promise<string[]> {
    return this.inner.listAirports();
  }

  resolvePosition(icao: string): Promise<{ lat: number; lon: number } | null> {
    return this.inner.resolvePosition(icao);
  }

  async getAirport(icao: string): Promise<AirportNavData | null> {
    const base = await this.inner.getAirport(icao);
    if (!base) return null;
    const taught = listUserProcedures(this.handle, icao);
    if (taught.length === 0) return base;
    const extra: Procedure[] = taught.map((u) => ({
      id: u.name,
      kind: u.kind,
      airport: icao.toUpperCase(),
      runway: u.runway,
      transitions: u.transition ? [u.transition] : [],
      transitionPositions: undefined,
      approachKind: u.kind === "APPROACH" ? ((u.approachKind ?? "ILS") as Procedure["approachKind"]) : null,
      waypoints: [],
      constraints: [],
      navdataCycle: "USER",
      provenance: "imported" as const,
      note: "Entered by you from the simulator's EFB procedure list.",
    }));
    return { ...base, procedures: [...base.procedures, ...extra] };
  }
}

/**
 * Post-planning step: for each procedure slot with a taught procedure for the
 * selected runway — and no explicit per-plan override — replace the
 * recommendation deterministically. Synthetic-fixture warnings for the
 * replaced procedure are dropped with it.
 */
export function applyUserProcedures(handle: DatabaseSync, plan: FlightPlan): void {
  const slots: { key: "sid" | "star" | "approach"; kind: UserProcedureKind; airport: string; runway: string | null }[] = [
    { key: "sid", kind: "SID", airport: plan.origin.icao, runway: plan.procedures.departureRunway.runway },
    { key: "star", kind: "STAR", airport: plan.destination.icao, runway: plan.procedures.arrivalRunway.runway },
    { key: "approach", kind: "APPROACH", airport: plan.destination.icao, runway: plan.procedures.arrivalRunway.runway },
  ];
  for (const s of slots) {
    if (!s.runway || plan.overrides[s.key]) continue;
    const taught = getUserProcedure(handle, s.airport, s.runway, s.kind);
    if (!taught) continue;
    const rec = plan.procedures[s.key];
    const oldId = rec.procedureId;
    const reason = `Using your saved ${s.kind} for ${s.airport} runway ${s.runway} — read from the simulator's EFB procedure list.`;
    plan.procedures[s.key] = {
      ...rec,
      procedureId: taught.name,
      runway: s.runway,
      // Never carry a fixture transition onto a real procedure; omit unless taught.
      transition: taught.transition,
      selectionReasons: [reason],
      warnings: [],
      confidence: { level: "high", score: 1, evidenceFor: [reason], evidenceAgainst: [], evidenceMissing: [] },
      validationStatus: "valid",
    };
    if (oldId) plan.warnings = plan.warnings.filter((w) => !w.includes(oldId));
  }
}
