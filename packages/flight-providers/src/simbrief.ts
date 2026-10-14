/**
 * SimBrief integration — Feature B.
 *
 * STAGE 1 (implemented): read-only import of the user's latest OFP via the
 * DOCUMENTED Pilot ID / username fetch mechanism:
 *   GET https://www.simbrief.com/api/xml.fetcher.php?username=<name>&json=1
 *   (or ?pilotid=<id>&json=1)
 * See research/api-research.md for documentation references.
 *
 * STAGE 2 (NOT implemented): server-side dispatch generation. SimBrief's
 * public OFP fetch does NOT authorize arbitrary plan generation; that needs
 * the official SimBrief dispatch/developer integration with its own
 * credentials. Without those credentials the app offers Stage 1 import plus
 * local file export only — and says so in the UI.
 */
import type { SimBriefOfpSummary } from "@flightdeck/shared-models";

const FETCHER = "https://www.simbrief.com/api/xml.fetcher.php";

export class SimBriefError extends Error {
  constructor(public readonly code: "not_configured" | "empty" | "network_error" | "unauthorized") {
    super(code);
    this.name = "SimBriefError";
  }
}

export interface SimBriefClientConfig {
  /** SimBrief username or numeric Pilot ID */
  user: string;
  timeoutMs?: number;
}

export class SimBriefClient {
  constructor(private config: SimBriefClientConfig) {
    if (!config.user?.trim()) throw new SimBriefError("not_configured");
  }

  /** Fetch the user's latest OFP summary. Returns null when none exists. */
  async fetchLatestOfp(): Promise<SimBriefOfpSummary | null> {
    const url = new URL(FETCHER);
    const user = this.config.user.trim();
    if (/^\d+$/.test(user)) url.searchParams.set("pilotid", user);
    else url.searchParams.set("username", user);
    url.searchParams.set("json", "v2"); // recommended by SimBrief for new implementations

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.config.timeoutMs ?? 30000);
    let res: Response;
    try {
      res = await fetch(url.toString(), { signal: ctrl.signal });
    } catch {
      clearTimeout(t);
      throw new SimBriefError("network_error");
    }
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) throw new SimBriefError("unauthorized");
    if (!res.ok) throw new SimBriefError("network_error");
    const data = (await res.json()) as SimBriefJson;
    const fetchStatus = data?.fetch?.status ?? "";
    if (!/success/i.test(fetchStatus)) return null; // no OFP on file
    return parseOfp(data);
  }
}

// --- defensive parsing: every field optional, missing => null ---------------
interface SimBriefJson {
  fetch?: { status?: string };
  general?: {
    flight_number?: string;
    callsign?: string;
    icao_airline?: string;
  };
  origin?: { icao_code?: string };
  destination?: { icao_code?: string };
  aircraft?: { icaocode?: string; icao_code?: string };
  fuel?: { plan_ramp?: string | number };
  times?: { sched_out?: string | number; sched_in?: string | number };
  navlog?: { fix?: SimBriefFix[] | SimBriefFix };
  atc?: { flightplan?: string };
  general2?: never;
  [k: string]: unknown;
}
interface SimBriefFix {
  ident?: string;
  name?: string;
  airway?: string;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseOfp(d: SimBriefJson): SimBriefOfpSummary {
  const general = d.general ?? {};
  const fixesRaw = d.navlog?.fix;
  const fixes = (Array.isArray(fixesRaw) ? fixesRaw : fixesRaw ? [fixesRaw] : [])
    .map((f) => f.ident ?? f.name ?? "")
    .filter(Boolean);

  // SID/STAR: SimBrief embeds them in the route string; the JSON navlog fixes
  // include them as first/last fixes only when published. We report them only
  // when explicitly present — never guessed.
  const routeText = typeof d.atc?.flightplan === "string" ? d.atc.flightplan : "";
  const sid = /SID[:\s]+([A-Z0-9]+)/i.exec(routeText)?.[1] ?? null;
  const star = /STAR[:\s]+([A-Z0-9]+)/i.exec(routeText)?.[1] ?? null;

  const airac =
    (d as Record<string, unknown>).airac_cycle ??
    (d.params as Record<string, unknown> | undefined)?.airac ??
    null;

  return {
    flightNumber: general.flight_number ?? null,
    callsign: general.callsign ?? null,
    origin: d.origin?.icao_code ?? null,
    destination: d.destination?.icao_code ?? null,
    aircraftType: d.aircraft?.icaocode ?? d.aircraft?.icao_code ?? null,
    routeFixes: fixes,
    sid,
    star,
    cruiseAltitudeFt: null, // parsed from navlog when present; left null here rather than guessed
    fuelKg: num(d.fuel?.plan_ramp),
    alternate: (d.destination as Record<string, unknown> | undefined)?.["altn_icao"] as string ?? null,
    airacCycle: typeof airac === "string" || typeof airac === "number" ? String(airac) : null,
    raw: d,
  };
}
