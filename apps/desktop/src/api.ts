/** Typed client for the FlightDeck planning API. */
import type {
  AircraftProfile,
  AirportNavData,
  FlightLookupResult,
  FlightPlan,
  HistoricalSourceAttempt,
  HistoricalSourceId,
  MsfsExportResult,
  RouteFix,
  SimBriefOfpSummary,
  TrackKind,
  TrackPoint,
} from "@flightdeck/shared-models";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((body.error as string) ?? `Request failed (${res.status}).`);
  return body as T;
}

export interface PlanResponse {
  lookup: FlightLookupResult;
  plan: FlightPlan;
}

export const api = {
  health: () => req<{ ok: boolean; navdataCycle: string; packaged?: boolean }>("/api/health"),
  settings: () => req<Record<string, string | null>>("/api/settings"),
  saveSettings: (s: Record<string, string | boolean>) => req<Record<string, string | null>>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  updateStatus: () =>
    req<{
      currentVersion: string; feedUrl: string | null; autoCheck: boolean; lastCheck: string | null;
      lastError: string | null; updateAvailable: boolean; latestVersion: string | null;
      notes: string | null; downloadedOk: boolean;
    }>("/api/update/status"),
  updateCheck: () => req<Record<string, unknown>>("/api/update/check", { method: "POST", body: "{}" }),
  updateDownload: () => req<Record<string, unknown>>("/api/update/download", { method: "POST", body: "{}" }),
  updateApply: () => req<Record<string, unknown>>("/api/update/apply", { method: "POST", body: "{}" }),
  lookup: (flightNumber: string, date: string, provider?: string) =>
    req<FlightLookupResult>("/api/lookup", { method: "POST", body: JSON.stringify({ flightNumber, date, provider }) }),
  plan: (args: {
    flightNumber?: string;
    date?: string;
    mode: "historical" | "current";
    provider?: string;
    aircraftProfileId?: string;
    windOrigin?: { directionDeg: number; speedKt: number; source?: string } | null;
    windDestination?: { directionDeg: number; speedKt: number; source?: string } | null;
    /** Historical Replay: a validated lookup from /api/history (OpenSky/import/reconstruction). */
    lookup?: FlightLookupResult;
    /** Fixes to plan from when the source has no filed route (track-derived or reconstructed). */
    planFixes?: RouteFix[];
    planWarnings?: string[];
    /** Manual cruise altitude in feet (recorded as user input; used for export). */
    cruiseAltitudeFt?: number;
  }) => req<PlanResponse>("/api/plan", { method: "POST", body: JSON.stringify(args) }),
  override: (args: { plan: FlightPlan; slot: string; airportIcao: string; procedureId?: string | null; runwayId?: string | null }) =>
    req<{ plan: FlightPlan }>("/api/plan/override", { method: "POST", body: JSON.stringify(args) }),
  aircraft: () => req<{ profiles: AircraftProfile[] }>("/api/aircraft"),
  navdata: (icao: string) => req<AirportNavData>(`/api/navdata/${icao}`),
  /** Teach-once: real procedure names read off the sim's EFB lists. */
  userProcedures: {
    save: (args: { icao: string; runway: string; kind: "SID" | "STAR" | "APPROACH"; name: string; transition?: string | null; approachKind?: string | null }) =>
      req<{ ok: boolean }>("/api/user-procedures", { method: "POST", body: JSON.stringify(args) }),
  },
  simbrief: (user?: string) =>
    req<{ found: boolean; ofp?: SimBriefOfpSummary; message?: string; error?: string }>("/api/simbrief", {
      method: "POST",
      body: JSON.stringify({ user }),
    }),
  exportPln: (plan: FlightPlan, title?: string) =>
    req<MsfsExportResult>("/api/export", { method: "POST", body: JSON.stringify({ plan, title }) }),
  importPln: (xml: string) => req<ParsedPlnLike>("/api/import-pln", { method: "POST", body: JSON.stringify({ xml }) }),
  history: (args: {
    flightNumber: string;
    date: string;
    origin?: string;
    destination?: string;
    allowReconstruction?: boolean;
  }) => req<HistoryResponse>("/api/history", { method: "POST", body: JSON.stringify(args) }),
  /** Build a navigable IFR reference route from a lookup's recorded track. */
  flyable: (lookup: FlightLookupResult) =>
    req<{
      fixes: RouteFix[];
      warnings: string[];
      gaps: { fromTime: string; toTime: string; durationSec: number }[];
      stats: { inputPoints: number; segments: number; trackFixes: number; generatedFixes: number };
    }>("/api/flyable", { method: "POST", body: JSON.stringify({ lookup }) }),
  imports: {
    list: () => req<{ imports: StoredImport[] }>("/api/imports").then((r) => r.imports),
    upload: (args: { flightNumber: string; date: string; filename: string; content: string }) =>
      req<{ import: StoredImport; warnings: string[] }>("/api/imports", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    remove: (id: string) => req<{ ok: boolean }>(`/api/imports/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
};

export interface HistoryOption {
  source: HistoricalSourceId;
  label: string;
  trackKind: TrackKind;
  detail: string;
  lookup: FlightLookupResult;
  track: TrackPoint[];
  planFixes: RouteFix[];
  planWarnings: string[];
}

export interface HistoryResponse {
  attempts: HistoricalSourceAttempt[];
  options: HistoryOption[];
}

export interface StoredImport {
  id: string;
  flightNumber: string;
  date: string;
  filename: string;
  createdAt: string;
  pointCount?: number;
}

export interface ParsedPlnLike {
  title: string | null;
  fpType: string | null;
  cruisingAltFt: number | null;
  departureId: string | null;
  destinationId: string | null;
  departureRunway: string | null;
  departureSid: string | null;
  arrivalRunway: string | null;
  arrivalStar: string | null;
  approachType: string | null;
  approachRunway: string | null;
  fixes: { name: string; lat: number | null; lon: number | null }[];
  warnings: string[];
}

export function download(filename: string, content: string, mime = "application/xml"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
