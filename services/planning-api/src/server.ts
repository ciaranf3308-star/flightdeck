/**
 * FlightDeck planning API — local-first Node service.
 *
 * Serves the desktop UI and exposes the planning pipeline over HTTP.
 * All responses validate against @flightdeck/shared-models.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AIRCRAFT_PROFILES,
  getProfile,
  matchProfile,
} from "@flightdeck/aircraft-adapters";
import {
  FixturesProvider,
  FlightAwareProvider,
  SimBriefClient,
  normalizeFlightNumber,
} from "@flightdeck/flight-providers";
import type { FlightProvider } from "@flightdeck/flight-providers";
import { FixtureNavDatabase } from "@flightdeck/navigation";
import { applyOverride, buildFlyableReference, planFlight, type WindSample } from "@flightdeck/route-engine";
import { exportMsfs2024Pln, parseMsfs2024Pln } from "@flightdeck/msfs-export";
import {
  FlightLookupResult,
  RouteFix,
  type FlightPlan,
  type PlanMode,
} from "@flightdeck/shared-models";
import type { FlightLookupResult as FlightLookupResultType } from "@flightdeck/shared-models";
import { cacheGet, cacheSet, cacheInvalidatePrefix, db, getSetting, publicSettings, setSetting } from "./db.js";
import {
  SimNavDataOverlay,
  getSimNavdataStatus,
  storeSimNavdata,
  type SimProcedureInput,
} from "./simnavdata.js";
import {
  UserProcedureOverlay,
  applyUserProcedures,
  deleteUserProcedure,
  getUserProcedure,
  listUserProcedures,
  saveUserProcedure,
} from "./userprocedures.js";
import {
  deleteImport,
  findHistorical,
  initImportsTable,
  listImports,
  storeImport,
} from "./history.js";
import {
  checkForUpdate,
  downloadUpdate,
  getAppVersion,
  getUpdateState,
  recordCheck,
  recordDownload,
} from "./update.js";
import {
  createCategory,
  deleteCategory,
  deleteFlight,
  listCategories,
  listFlights,
  saveFlight,
  updateCategory,
  updateFlight,
} from "./library.js";

const PORT = Number(process.env.FLIGHTDECK_PORT ?? 8124);
// Fixture snapshots: dev layout keeps them at tests/fixtures; the packaged
// installer bundles them at resources/api/fixtures. Resolved from the module
// location, never the working directory.
const DEV_FIXTURES = new URL("../../../tests/fixtures", import.meta.url).pathname;
const PKG_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const FIXTURES_ROOT =
  process.env.FLIGHTDECK_FIXTURES ?? (existsSync(DEV_FIXTURES) ? DEV_FIXTURES : PKG_FIXTURES);

const navdb = new UserProcedureOverlay(new SimNavDataOverlay(new FixtureNavDatabase()), db);

// --- live telemetry ingest (SimConnect bridge posts here) -----------------
interface TelemetryState {
  sample: Record<string, unknown> | null;
  receivedAt: number;
}
const telemetry: TelemetryState = { sample: null, receivedAt: 0 };
const TELEMETRY_STALE_MS = 5000;

// --- Live simulator navdata fetch orchestration ---------------------------
// When the sim is connected (fresh telemetry) and the user-built bridge is
// present, a planning request for an airport with no cached procedures kicks
// off a one-shot `--fetch-procedures` bridge run. Fire-and-forget: the
// Live simulator navdata fetch orchestration ---------------------------
// When the sim is connected (fresh telemetry) and an airport has no cached
// procedures, a planning request kicks off a one-shot navdata fetch. The
// fetcher is a plain Node script (services/navdata-fetch/fetch-procedures.mjs)
// speaking the SimConnect protocol via node-simconnect — no SDK, no .NET, no
// compilation; it runs on the same Node runtime as this API (the installer
// ships portable Node). Fire-and-forget: the current plan keeps fixture
// behavior, and the fetch warning tells the user to replan once the sim's
// real SID/STAR/approach data lands.
function simNavdataConnected(): boolean {
  return Date.now() - telemetry.receivedAt <= TELEMETRY_STALE_MS;
}
/** Resolve the navdata fetch script (dev tree or packaged resources). */
function navdataFetchScript(): string | null {
  const env = process.env.FLIGHTDECK_NAVDATA_FETCH;
  if (env && existsSync(env)) return env;
  // server dist is at services/planning-api/dist (dev) or
  // resources/api/dist (packaged) — the script sits two levels up in both.
  const candidate = resolve(here, "..", "..", "navdata-fetch", "fetch-procedures.mjs");
  return existsSync(candidate) ? candidate : null;
}
const simFetchInFlight = new Map<string, number>();
function kickSimNavdataFetch(icaos: string[]): { ok: true } | { ok: false; reason: string } {
  if (!simNavdataConnected()) return { ok: false, reason: "simulator not connected" };
  const script = navdataFetchScript();
  if (!script) return { ok: false, reason: "navdata fetch script not installed" };
  const fresh = icaos.filter((icao) => {
    const last = simFetchInFlight.get(icao) ?? 0;
    return Date.now() - last > 120_000;
  });
  if (fresh.length === 0) return { ok: false, reason: "fetch already in flight" };
  try {
    const child = spawn(
      process.execPath,
      [script, fresh.join(","), "--api-url", `http://localhost:${PORT}/api/navdata/procedures`],
      { windowsHide: true, stdio: "ignore", detached: true },
    );
    child.unref();
    for (const icao of fresh) simFetchInFlight.set(icao, Date.now());
    // A failed fetch must not block retries forever.
    child.on("error", () => {
      for (const icao of fresh) simFetchInFlight.delete(icao);
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: "could not start navdata fetch" };
  }
}

function providerFor(override?: string): FlightProvider {
  const setting = override ?? getSetting("provider") ?? "auto";
  if (setting === "flightaware" || (setting === "auto" && getSetting("flightAwareApiKey"))) {
    const key = getSetting("flightAwareApiKey");
    if (!key) throw httpError(400, "FlightAware provider selected but no API key is configured (see Settings).");
    return new FlightAwareProvider({ apiKey: key });
  }
  return new FixturesProvider({ fixturesRoot: FIXTURES_ROOT });
}

function httpError(status: number, message: string): Error & { status?: number } {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, "Request body is not valid JSON.");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

/** Enrich a lookup: resolve airport coordinates from navdata, never guessed. */
async function enrichLookup(lookup: FlightLookupResultType): Promise<FlightLookupResultType> {
  for (const slot of ["origin", "destination"] as const) {
    const ref = lookup[slot].value;
    if (ref && (ref.position.lat === 0 && ref.position.lon === 0)) {
      const pos = await navdb.resolvePosition(ref.icao);
      if (pos) {
        ref.position = pos;
        lookup[slot].note = `${lookup[slot].note ?? ""} Coordinates from FlightDeck reference navdata.`.trim();
      } else {
        lookup[slot].provenance = "unavailable";
        lookup[slot].value = null;
        lookup.unavailableFields.push(slot);
        lookup.warnings.push(`${slot} ${ref.icao}: no reference coordinates available.`);
      }
    }
  }
  return lookup;
}

async function handleLookup(body: Record<string, unknown>): Promise<FlightLookupResultType> {
  const flightNumber = String(body.flightNumber ?? "").trim();
  const date = String(body.date ?? "").trim();
  if (!flightNumber) throw httpError(400, "flightNumber is required (e.g. EI106).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError(400, "date is required as YYYY-MM-DD.");
  try {
    normalizeFlightNumber(flightNumber);
  } catch (e) {
    throw httpError(400, (e as Error).message);
  }
  const provider = providerFor(body.provider as string | undefined);
  const cacheKey = `${provider.name}:${flightNumber.toUpperCase()}:${date}`;
  const cached = cacheGet(cacheKey);
  if (cached) return JSON.parse(cached) as FlightLookupResultType;
  const lookup = await enrichLookup(await provider.lookupFlight(flightNumber, date));
  if (lookup.state === "ok") cacheSet(cacheKey, JSON.stringify(lookup));
  return lookup;
}

async function handlePlan(body: Record<string, unknown>): Promise<{ lookup: FlightLookupResultType; plan: FlightPlan }> {
  // Historical Replay may supply a validated lookup from /api/history
  // (OpenSky / import / reconstruction) instead of a provider lookup.
  let lookup: FlightLookupResultType;
  if (body.lookup !== undefined) {
    const parsed = FlightLookupResult.safeParse(body.lookup);
    if (!parsed.success) throw httpError(400, "Supplied lookup failed validation.");
    lookup = parsed.data;
  } else {
    lookup = await handleLookup(body);
  }
  if (lookup.state !== "ok" || !lookup.origin.value || !lookup.destination.value) {
    const detail = lookup.warnings?.[0] ? ` ${lookup.warnings[0]}` : "";
    throw httpError(422, `Cannot plan: flight lookup state is "${lookup.state}".${detail}`);
  }
  const origin = await navdb.getAirport(lookup.origin.value.icao);
  const destination = await navdb.getAirport(lookup.destination.value.icao);
  if (!origin || !destination) {
    throw httpError(
      422,
      `No navigation data for ${!origin ? lookup.origin.value.icao : ""} ${!destination ? lookup.destination.value.icao : ""} — planning unavailable for this airport pair.`,
    );
  }
  const mode = (body.mode as PlanMode) ?? "historical";
  if (mode !== "historical" && mode !== "current") throw httpError(400, 'mode must be "historical" or "current".');
  // Optional validated overrides from /api/history (track-derived or reconstructed fixes).
  let overrideFixes: RouteFix[] | undefined;
  if (body.planFixes !== undefined) {
    const parsed = z.array(RouteFix).safeParse(body.planFixes);
    if (!parsed.success) throw httpError(400, "planFixes failed validation.");
    // An empty array means "no override" — it must not wipe a filed route
    // (reconstruction carries its fixes in lookup.filedRoute).
    overrideFixes = parsed.data.length > 0 ? parsed.data : undefined;
  }
  const extraWarnings: string[] = Array.isArray(body.planWarnings)
    ? (body.planWarnings as unknown[]).filter((w): w is string => typeof w === "string").slice(0, 20)
    : [];
  // Optional explicit cruise altitude (e.g. for reconstructions, which have no
  // track to derive one from). The value is the user's own input — recorded as such.
  let cruiseAltitudeFt = lookup.filedCruiseAltitudeFt.value;
  if (body.cruiseAltitudeFt !== undefined && body.cruiseAltitudeFt !== null && body.cruiseAltitudeFt !== "") {
    const n = Number(body.cruiseAltitudeFt);
    if (!Number.isFinite(n) || n <= 0 || n > 60000) throw httpError(400, "cruiseAltitudeFt must be feet, 1–60000.");
    cruiseAltitudeFt = Math.round(n);
    extraWarnings.push(`Cruise altitude ${cruiseAltitudeFt.toLocaleString("en-US")} ft entered manually for this plan.`);
  }
  const profileId = body.aircraftProfileId as string | undefined;
  const aircraft = profileId ? getProfile(profileId) : matchProfile(lookup.aircraftType.value);
  // Live procedure fetch: no cached sim procedures + sim connected => kick a
  // one-shot bridge fetch. This plan keeps fixture behavior; the warning
  // invites a replan once the sim's real SID/STAR/ILS data lands.
  for (const ap of [lookup.origin.value.icao, lookup.destination.value.icao]) {
    if (!getSimNavdataStatus(db, ap).cached && kickSimNavdataFetch([ap]).ok) {
      extraWarnings.push(
        `Live SID/STAR/approach data for ${ap} is being fetched from the simulator — plan again shortly to auto-select procedures.`,
      );
    }
  }
  const wind = (v: unknown): WindSample | null => {
    if (!v || typeof v !== "object") return null;
    const w = v as Record<string, unknown>;
    if (typeof w.directionDeg !== "number" || typeof w.speedKt !== "number") return null;
    return { directionDeg: w.directionDeg, speedKt: w.speedKt, source: String(w.source ?? "manual entry") };
  };
  const { plan } = planFlight({
    origin,
    destination,
    aircraft,
    filedFixes: overrideFixes ?? lookup.filedRoute.value ?? [],
    mode,
    historicalRunwayDeparture: lookup.actualRunwayDeparture.value,
    historicalRunwayArrival: lookup.actualRunwayArrival.value,
    windOrigin: wind(body.windOrigin),
    windDestination: wind(body.windDestination),
    cruiseAltitudeFt,
    flightNumber: lookup.flightNumber,
    date: lookup.date,
  });
  plan.registration = lookup.registration.value;
  // Teach-once: user-saved procedures (from the sim's EFB lists) beat fixture
  // selection deterministically, unless the plan carries an explicit override.
  applyUserProcedures(db, plan);
  if (extraWarnings.length > 0) plan.warnings.push(...extraWarnings);
  return { lookup, plan };
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/health") {
    return send(res, 200, {
      ok: true,
      service: "flightdeck-planning-api",
      navdataCycle: navdb.cycle,
      packaged: process.env.FLIGHTDECK_PACKAGED === "1",
      version: getAppVersion(),
    });
  }
  if (req.method === "POST" && pathname === "/api/shutdown") {
    // Packaged app only: the desktop Quit button calls this. Localhost-only
    // service; nothing remote can reach it.
    send(res, 200, { ok: true });
    setTimeout(() => shutdown("quit requested"), 150);
    return;
  }
  if (req.method === "GET" && pathname === "/api/settings") {
    return send(res, 200, publicSettings());
  }
  if (req.method === "PUT" && pathname === "/api/settings") {
    const body = (await readJson(req)) as Record<string, unknown>;
    if (body.provider !== undefined) {
      const p = String(body.provider);
      if (!["auto", "flightaware", "fixtures"].includes(p)) throw httpError(400, "provider must be auto, flightaware or fixtures.");
      setSetting("provider", p);
    }
    if (body.flightAwareApiKey !== undefined) {
      const k = String(body.flightAwareApiKey);
      if (k) setSetting("flightAwareApiKey", k); // stored locally; never returned
    }
    if (body.simbriefUser !== undefined) setSetting("simbriefUser", String(body.simbriefUser));
    if (body.openskyClientId !== undefined) setSetting("openskyClientId", String(body.openskyClientId));
    if (body.openskyClientSecret !== undefined) {
      const s = String(body.openskyClientSecret);
      if (s) setSetting("openskyClientSecret", s); // stored locally; never returned
    }
    if (body.updateFeedUrl !== undefined) setSetting("updateFeedUrl", String(body.updateFeedUrl).trim());
    if (body.updateAutoCheck !== undefined) setSetting("updateAutoCheck", body.updateAutoCheck ? "1" : "0");
    return send(res, 200, publicSettings());
  }
  // -- Auto-updater ------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/update/status") {
    return send(res, 200, getUpdateState());
  }
  if (req.method === "POST" && pathname === "/api/update/check") {
    const st = getUpdateState();
    if (!st.feedUrl) throw httpError(400, "No update feed configured. Set it in Settings → Updates.");
    try {
      const feed = await checkForUpdate(st.feedUrl, st.currentVersion);
      return send(res, 200, recordCheck(feed, null));
    } catch (e) {
      return send(res, 200, recordCheck(null, (e as Error).message));
    }
  }
  if (req.method === "POST" && pathname === "/api/update/download") {
    const st = getUpdateState();
    if (!st.updateAvailable || !st.latestVersion || !st.downloadUrl) {
      throw httpError(400, "No update pending. Run Check for updates first.");
    }
    const feed = {
      version: st.latestVersion,
      url: st.downloadUrl,
      sha256: getSetting("updateSha256") ?? "",
    };
    try {
      const path = await downloadUpdate(feed);
      recordDownload(path, feed.version);
    } catch (e) {
      throw httpError(502, `Download failed: ${(e as Error).message}`);
    }
    return send(res, 200, getUpdateState());
  }
  if (req.method === "POST" && pathname === "/api/update/apply") {
    // Windows-only: run the downloaded installer silently, then shut down so
    // files are not locked. The installer stops the backend first anyway.
    if (process.platform !== "win32") throw httpError(501, "Applying updates is only supported on Windows.");
    const st = getUpdateState();
    if (!st.downloadedOk || !st.downloadedPath) {
      throw httpError(400, "No verified download ready. Download the update first.");
    }
    send(res, 200, { ok: true, applying: st.latestVersion });
    setTimeout(() => {
      try {
        spawn(st.downloadedPath as string, ["/S"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      } catch {
        /* the installer launch is best-effort; shutdown still happens */
      }
      setTimeout(() => shutdown("update apply"), 500);
    }, 150);
    return;
  }
  if (req.method === "GET" && pathname === "/api/aircraft") {
    return send(res, 200, { profiles: AIRCRAFT_PROFILES });
  }
  // -- Live simulator navdata (automatic SID/STAR/ILS selection) ---------------
  if (req.method === "GET" && pathname === "/api/navdata/status") {
    const icao = String(url.searchParams.get("icao") ?? "").toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) throw httpError(400, "icao (3-4 chars) is required.");
    return send(res, 200, { ...getSimNavdataStatus(db, icao), simConnected: simNavdataConnected() });
  }
  if (req.method === "POST" && pathname === "/api/navdata/fetch") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const raw = body.icao ?? body.icaos;
    const icaos = (Array.isArray(raw) ? raw : [raw])
      .map((s) => String(s ?? "").toUpperCase())
      .filter((s) => /^[A-Z0-9]{3,4}$/.test(s));
    if (icaos.length === 0) throw httpError(400, "icao is required.");
    const started = kickSimNavdataFetch(icaos);
    if (!started.ok) return send(res, 409, { error: started.reason });
    return send(res, 200, { started: true, icaos });
  }
  if (req.method === "POST" && pathname === "/api/navdata/procedures") {
    // Ingest from the bridge's --fetch-procedures run. Minimal validation:
    // names are the sim's own data, never invented here.
    const body = (await readJson(req)) as Record<string, unknown>;
    const icao = String(body.icao ?? "").toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) throw httpError(400, "icao (3-4 chars) is required.");
    const list = body.procedures;
    if (!Array.isArray(list)) throw httpError(400, "procedures must be an array.");
    const procedures: SimProcedureInput[] = list
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .map((p) => ({
        kind: String(p.kind ?? "").toUpperCase() as "SID" | "STAR" | "APPROACH",
        name: String(p.name ?? ""),
        runways: Array.isArray(p.runways) ? p.runways.map(String) : [],
        transitions: Array.isArray(p.transitions) ? p.transitions.map(String) : [],
        transitionPositions:
          typeof p.transitionPositions === "object" && p.transitionPositions !== null
            ? (p.transitionPositions as Record<string, { lat: number; lon: number }>)
            : {},
        approachType: typeof p.approachType === "string" ? p.approachType : null,
      }));
    const cycle = typeof body.cycle === "string" && body.cycle ? body.cycle : undefined;
    return send(res, 200, storeSimNavdata(db, icao, procedures, cycle));
  }
  // -- User-taught procedures ("teach once") --------------------------------
  // Real procedure names read off the sim's EFB lists, saved per
  // airport+runway+kind and reused automatically by future plans.
  if (req.method === "GET" && pathname === "/api/user-procedures") {
    const icao = url.searchParams.get("icao") ?? undefined;
    return send(res, 200, { procedures: listUserProcedures(db, icao) });
  }
  if (req.method === "POST" && pathname === "/api/user-procedures") {
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const saved = saveUserProcedure(db, {
        icao: body.icao as string,
        runway: body.runway as string,
        kind: body.kind as "SID" | "STAR" | "APPROACH",
        name: body.name as string,
        transition: (body.transition as string | null) ?? null,
        approachKind: (body.approachKind as string | null) ?? null,
      });
      return send(res, 200, { ok: true, procedure: saved });
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
  }
  if (req.method === "DELETE" && pathname === "/api/user-procedures") {
    const icao = url.searchParams.get("icao") ?? "";
    const runway = url.searchParams.get("runway") ?? "";
    const kind = url.searchParams.get("kind") ?? "";
    if (!icao || !runway || !kind) throw httpError(400, "icao, runway and kind are required.");
    const deleted = deleteUserProcedure(db, icao, runway, kind);
    return send(res, 200, { ok: deleted });
  }
  if (req.method === "GET" && pathname.startsWith("/api/navdata/")) {
    const icao = pathname.split("/").pop()?.toUpperCase() ?? "";
    const data = await navdb.getAirport(icao);
    if (!data) return send(res, 404, { error: `No navigation data for ${icao}.` });
    return send(res, 200, data);
  }
  if (req.method === "POST" && pathname === "/api/lookup") {
    return send(res, 200, await handleLookup((await readJson(req)) as Record<string, unknown>));
  }
  if (req.method === "POST" && pathname === "/api/plan") {
    return send(res, 200, await handlePlan((await readJson(req)) as Record<string, unknown>));
  }
  // -- Historical Replay: provider-independent historical lookup -------------
  if (req.method === "POST" && pathname === "/api/history") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const flightNumber = String(body.flightNumber ?? "").trim();
    const date = String(body.date ?? "");
    if (!flightNumber || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw httpError(400, "flightNumber and date (YYYY-MM-DD) are required.");
    }
    const cacheKey = `history:${flightNumber.toUpperCase()}:${date}:${String(body.origin ?? "").toUpperCase()}:${body.allowReconstruction ? "recon" : "norecon"}`;
    const cached = cacheGet(cacheKey);
    if (cached) return send(res, 200, JSON.parse(cached));
    try {
      const result = await findHistorical(db, navdb, {
        flightNumber,
        date,
        origin: typeof body.origin === "string" ? body.origin : undefined,
        destination: typeof body.destination === "string" ? body.destination : undefined,
        allowReconstruction: body.allowReconstruction === true,
      });
      cacheSet(cacheKey, JSON.stringify(result));
      return send(res, 200, result);
    } catch (e) {
      // Invalid input is a real error; "not found" is reported via attempts.
      throw httpError(400, (e as Error).message);
    }
  }
  if (req.method === "POST" && pathname === "/api/imports") {
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const { stored, warnings } = storeImport(
        db,
        String(body.flightNumber ?? ""),
        String(body.date ?? ""),
        String(body.filename ?? "track"),
        String(body.content ?? ""),
      );
      cacheInvalidatePrefix("history:"); // new data may change historical results
      return send(res, 201, { import: { ...stored, points: undefined, pointCount: stored.points.length }, warnings });
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
  }
  if (req.method === "GET" && pathname === "/api/imports") {
    return send(res, 200, { imports: listImports(db) });
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/imports/")) {
    const id = decodeURIComponent(pathname.slice("/api/imports/".length));
    if (!deleteImport(db, id)) return send(res, 404, { error: "Import not found." });
    cacheInvalidatePrefix("history:");
    return send(res, 200, { ok: true });
  }
  if (req.method === "POST" && pathname === "/api/plan/override") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const plan = body.plan as FlightPlan;
    const slot = body.slot as "sid" | "star" | "approach" | "departureRunway" | "arrivalRunway";
    const airportIcao = String(body.airportIcao ?? "");
    if (!plan || !slot || !airportIcao) throw httpError(400, "plan, slot and airportIcao are required.");
    const airport = await navdb.getAirport(airportIcao);
    if (!airport) throw httpError(422, `No navigation data for ${airportIcao}.`);
    const next = applyOverride(
      plan,
      airport,
      slot,
      (body.procedureId as string | null) ?? null,
      (body.runwayId as string | null) ?? null,
    );
    return send(res, 200, { plan: next });
  }
  if (req.method === "POST" && pathname === "/api/simbrief") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const user = String(body.user ?? getSetting("simbriefUser") ?? "").trim();
    if (!user) throw httpError(400, "SimBrief username or Pilot ID is required.");
    const client = new SimBriefClient({ user });
    try {
      const ofp = await client.fetchLatestOfp();
      if (!ofp) return send(res, 200, { found: false, message: "No SimBrief OFP on file for this user." });
      return send(res, 200, { found: true, ofp });
    } catch (e) {
      const code = (e as { code?: string }).code ?? "network_error";
      const status = code === "unauthorized" ? 401 : 502;
      return send(res, status, { found: false, error: code });
    }
  }
  if (req.method === "POST" && pathname === "/api/export") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const plan = body.plan as FlightPlan;
    if (!plan) throw httpError(400, "plan is required.");
    const origin = await navdb.getAirport(plan.origin.icao);
    const destination = await navdb.getAirport(plan.destination.icao);
    const procedures = [...(origin?.procedures ?? []), ...(destination?.procedures ?? [])];
    const result = exportMsfs2024Pln(
      plan,
      { findProcedure: (id) => procedures.find((p) => p.id === id) ?? null },
      { title: body.title as string | undefined, description: body.description as string | undefined },
    );
    return send(res, 200, result);
  }
  if (req.method === "POST" && pathname === "/api/flyable") {
    // Build a navigable IFR reference route from a recorded track. The track
    // itself stays a historical reference — this returns separate plan fixes.
    const body = (await readJson(req)) as Record<string, unknown>;
    const parsed = FlightLookupResult.safeParse(body.lookup);
    if (!parsed.success) throw httpError(400, "lookup failed validation.");
    const lookup = parsed.data;
    const track = lookup.recordedTrack.value;
    if (!track || track.length < 2) {
      throw httpError(422, "No recorded track on this lookup — nothing to build a flyable reference from.");
    }
    const oPos = lookup.origin.value?.position;
    const dPos = lookup.destination.value?.position;
    const oIcao = lookup.origin.value?.icao;
    const dIcao = lookup.destination.value?.icao;
    if (!oPos || !dPos || !oIcao || !dIcao) {
      throw httpError(422, "Lookup origin/destination lack coordinates — cannot build a flyable reference.");
    }
    const ref = buildFlyableReference(track, { icao: oIcao, lat: oPos.lat, lon: oPos.lon }, { icao: dIcao, lat: dPos.lat, lon: dPos.lon });
    return send(res, 200, { fixes: ref.fixes, warnings: ref.warnings, gaps: ref.gaps, stats: ref.stats });
  }
  if (req.method === "POST" && pathname === "/api/import-pln") {
    const body = (await readJson(req)) as Record<string, unknown>;
    const xml = String(body.xml ?? "");
    if (!xml) throw httpError(400, "xml is required.");
    return send(res, 200, parseMsfs2024Pln(xml));
  }
  if (req.method === "POST" && pathname === "/api/telemetry") {
    // Ingest from the SimConnect bridge. Partial samples accepted; the bridge
    // sends what the sim provides, never synthesized values.
    const body = (await readJson(req)) as Record<string, unknown>;
    if (typeof body !== "object" || body === null) throw httpError(400, "telemetry sample must be an object.");
    telemetry.sample = { ...body, timestamp: new Date().toISOString(), connected: true };
    telemetry.receivedAt = Date.now();
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && pathname === "/api/telemetry/latest") {
    const stale = Date.now() - telemetry.receivedAt > TELEMETRY_STALE_MS;
    if (!telemetry.sample || stale) return send(res, 200, { connected: false, sample: null });
    return send(res, 200, { connected: true, sample: telemetry.sample });
  }
  // -- Flight library -------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/library") {
    return send(res, 200, { flights: listFlights(db) });
  }
  if (req.method === "POST" && pathname === "/api/library") {
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const flight = saveFlight(db, {
        flightNumber: String(body.flightNumber ?? ""),
        date: String(body.date ?? ""),
        origin: (body.origin as string | null) ?? null,
        destination: (body.destination as string | null) ?? null,
        aircraftType: (body.aircraftType as string | null) ?? null,
        registration: (body.registration as string | null) ?? null,
        depRunway: (body.depRunway as string | null) ?? null,
        arrRunway: (body.arrRunway as string | null) ?? null,
        cruiseAltitude: typeof body.cruiseAltitude === "number" ? body.cruiseAltitude : null,
        routeNames: Array.isArray(body.routeNames) ? (body.routeNames as string[]) : [],
        categoryIds: Array.isArray(body.categoryIds) ? (body.categoryIds as string[]) : [],
        note: typeof body.note === "string" ? body.note : "",
      });
      return send(res, 201, { flight });
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
  }
  if (pathname.startsWith("/api/library/") && !pathname.startsWith("/api/library/categories")) {
    const id = decodeURIComponent(pathname.slice("/api/library/".length));
    if (req.method === "PATCH") {
      const body = (await readJson(req)) as Record<string, unknown>;
      const flight = updateFlight(db, id, {
        note: typeof body.note === "string" ? body.note : undefined,
        categoryIds: Array.isArray(body.categoryIds) ? (body.categoryIds as string[]) : undefined,
      });
      if (!flight) return send(res, 404, { error: "Saved flight not found." });
      return send(res, 200, { flight });
    }
    if (req.method === "DELETE") {
      if (!deleteFlight(db, id)) return send(res, 404, { error: "Saved flight not found." });
      return send(res, 200, { ok: true });
    }
  }
  if (req.method === "GET" && pathname === "/api/library/categories") {
    return send(res, 200, { categories: listCategories(db) });
  }
  if (req.method === "POST" && pathname === "/api/library/categories") {
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const category = createCategory(db, String(body.name ?? ""), String(body.color ?? "#38bdf8"));
      return send(res, 201, { category });
    } catch (e) {
      throw httpError(400, (e as Error).message);
    }
  }
  if (req.method === "PATCH" && pathname.startsWith("/api/library/categories/")) {
    const id = decodeURIComponent(pathname.slice("/api/library/categories/".length));
    const body = (await readJson(req)) as Record<string, unknown>;
    const category = updateCategory(db, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      color: typeof body.color === "string" ? body.color : undefined,
    });
    if (!category) return send(res, 404, { error: "Category not found." });
    return send(res, 200, { category });
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/library/categories/")) {
    const id = decodeURIComponent(pathname.slice("/api/library/categories/".length));
    if (!deleteCategory(db, id)) return send(res, 404, { error: "Category not found." });
    return send(res, 200, { ok: true });
  }
  // -- Packaged app: serve the bundled desktop UI --------------------------------
  // In the installer layout, the built SPA lives at <api>/public next to dist/.
  // In dev this directory does not exist and the vite dev server handles the UI.
  if (req.method === "GET" && !pathname.startsWith("/api")) {
    const served = servePublic(pathname, res);
    if (served) return;
  }
  return send(res, 404, { error: "Not found." });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const here = dirname(fileURLToPath(import.meta.url));
// Resolved from the module's own location, never the working directory — the
// installed app and a dev checkout both work regardless of cwd.
const publicDir = resolve(here, "..", "public");

/**
 * Separator-aware "is file inside dir" check. The naive
 * `file.startsWith(dir + "/")` breaks on Windows where resolve() returns
 * backslash paths (every static request 404'd in the 0.2.0 installer).
 * The path module is injectable so tests can exercise win32 semantics.
 */
export function isInsideDir(
  dir: string,
  file: string,
  p: Pick<typeof import("node:path"), "relative" | "isAbsolute"> = { relative, isAbsolute },
): boolean {
  const outside = p.relative(dir, file);
  return outside !== "" && !outside.startsWith("..") && !p.isAbsolute(outside);
}

/** Serve the bundled SPA. Returns true when the request was handled. */
function servePublic(pathname: string, res: ServerResponse): boolean {
  if (!existsSync(publicDir)) return false;
  let rel = pathname.replace(/^[/\\]+/, "");
  if (rel === "" || rel.endsWith("/")) rel = `${rel}index.html`;
  const file = resolve(publicDir, rel);
  if (!isInsideDir(publicDir, file)) return false; // never escape the public dir
  let target = file;
  if (!existsSync(target) || statSync(target).isDirectory()) {
    // SPA fallback: unknown paths serve index.html (client-side routing).
    target = join(publicDir, "index.html");
    if (!existsSync(target)) return false;
  }
  res.writeHead(200, { "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
  return true;
}

// -- SimConnect bridge lifecycle ------------------------------------------------
// The packaged installer may ship the user-built bridge at
// <install>/resources/bridge/FlightDeck.SimConnectBridge.exe (built on Windows
// with `dotnet publish`). The API starts it hidden and stops it on shutdown.
// Without it, telemetry simply reports disconnected — the app works fine.
let bridgeProc: ChildProcess | null = null;

function bridgePath(): string | null {
  const env = process.env.FLIGHTDECK_BRIDGE;
  if (env && existsSync(env)) return env;
  const candidate = resolve(here, "..", "..", "bridge", "FlightDeck.SimConnectBridge.exe");
  return existsSync(candidate) ? candidate : null;
}

function startBridge(): void {
  const exe = bridgePath();
  if (!exe) return;
  try {
    bridgeProc = spawn(exe, ["--api-url", `http://localhost:${PORT}/api/telemetry`], {
      windowsHide: true,
      stdio: "ignore",
      detached: false,
    });
    bridgeProc.on("error", () => {
      bridgeProc = null;
    });
    console.log(`SimConnect bridge started: ${exe}`);
  } catch {
    bridgeProc = null;
  }
}

function shutdown(reason: string): void {
  console.log(`Shutting down (${reason}).`);
  try {
    bridgeProc?.kill();
  } catch {
    /* already gone */
  }
  process.exit(0);
}

export function start(): void {
  const server = createServer((req, res) => {
    route(req, res).catch((e: Error & { status?: number }) => {
      const status = e.status ?? 500;
      send(res, status, { error: e.message ?? "Internal error." });
    });
  });
  server.listen(PORT, () => {
    console.log(`FlightDeck planning API listening on http://localhost:${PORT}`);
    startBridge();
    scheduleUpdateChecks();
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Background update checks: once shortly after start, then every 24h. */
function scheduleUpdateChecks(): void {
  const run = async () => {
    try {
      const st = getUpdateState();
      if (!st.feedUrl || !st.autoCheck) return;
      const feed = await checkForUpdate(st.feedUrl, st.currentVersion);
      recordCheck(feed, null);
      if (feed) console.log(`Update available: ${feed.version}`);
    } catch (e) {
      try {
        recordCheck(null, (e as Error).message);
      } catch {
        /* db may not be ready in some test contexts */
      }
    }
  };
  setTimeout(run, 30_000);
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
