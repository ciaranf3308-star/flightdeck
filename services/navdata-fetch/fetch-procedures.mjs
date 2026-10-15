#!/usr/bin/env node
/**
 * FlightDeck navdata fetch — reads the simulator's OWN SID/STAR/approach data
 * over SimConnect facility data and POSTs it to the planning API.
 *
 * No SDK, no compilation, no .NET: pure SimConnect protocol via the
 * node-simconnect package (bundled in the installer). Run while MSFS is open:
 *
 *   node fetch-procedures.mjs KJFK,EIDW --api-url http://localhost:8124/api/navdata/procedures
 *
 * FlightDeck's API also spawns this automatically when you plan with the sim
 * connected and no cached procedures exist for the airport.
 *
 * What it fetches per airport: runways (+ILS idents), departures (SIDs) with
 * runway/enroute transitions, arrivals (STARs) ditto, approaches (type,
 * runway, transitions). Names are the sim's own data — never invented here.
 * The API caches them (SIM-YYYYMMDD tag) and the route engine auto-selects
 * from them on the next plan.
 *
 * Exit codes: 0 all airports ok, 1 usage/connection error, 2 one or more
 * airports failed (details on stderr, JSON summary on stdout).
 */
import { open, Protocol } from "node-simconnect";
import { parseAirportFacility, toSimProcedureInputs, FacilityParseError } from "./parse-facility.mjs";

const DEF_ID = 100;

// Field order MUST match parse-facility.mjs.
const FACILITY_FIELDS = [
  "OPEN AIRPORT",
  "N_RUNWAYS",
  "N_DEPARTURES",
  "N_ARRIVALS",
  "N_APPROACHES",
  "OPEN RUNWAY",
  "PRIMARY_NUMBER",
  "PRIMARY_DESIGNATOR",
  "SECONDARY_NUMBER",
  "SECONDARY_DESIGNATOR",
  "PRIMARY_ILS_ICAO",
  "SECONDARY_ILS_ICAO",
  "CLOSE RUNWAY",
  "OPEN DEPARTURE",
  "NAME",
  "N_RUNWAY_TRANSITIONS",
  "N_ENROUTE_TRANSITIONS",
  "OPEN RUNWAY_TRANSITION",
  "RUNWAY_NUMBER",
  "RUNWAY_DESIGNATOR",
  "CLOSE RUNWAY_TRANSITION",
  "OPEN ENROUTE_TRANSITION",
  "NAME",
  "CLOSE ENROUTE_TRANSITION",
  "CLOSE DEPARTURE",
  "OPEN ARRIVAL",
  "NAME",
  "N_RUNWAY_TRANSITIONS",
  "N_ENROUTE_TRANSITIONS",
  "OPEN RUNWAY_TRANSITION",
  "RUNWAY_NUMBER",
  "RUNWAY_DESIGNATOR",
  "CLOSE RUNWAY_TRANSITION",
  "OPEN ENROUTE_TRANSITION",
  "NAME",
  "CLOSE ENROUTE_TRANSITION",
  "CLOSE ARRIVAL",
  "OPEN APPROACH",
  "TYPE",
  "SUFFIX",
  "RUNWAY_NUMBER",
  "RUNWAY_DESIGNATOR",
  "N_TRANSITIONS",
  "OPEN APPROACH_TRANSITION",
  "NAME",
  "CLOSE APPROACH_TRANSITION",
  "CLOSE APPROACH",
  "CLOSE AIRPORT",
];

function usage() {
  console.error("Usage: node fetch-procedures.mjs KJFK,EIDW --api-url http://localhost:8124/api/navdata/procedures [--timeout-ms 30000]");
  process.exit(1);
}

function parseArgs(argv) {
  const out = { icaos: [], apiUrl: "", timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-url") out.apiUrl = argv[++i] ?? "";
    else if (a === "--timeout-ms") out.timeoutMs = Number(argv[++i]) || 30000;
    else if (!a.startsWith("--")) out.icaos.push(...a.split(","));
    else usage();
  }
  out.icaos = [...new Set(out.icaos.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{3,4}$/.test(s)))];
  if (out.icaos.length === 0 || !out.apiUrl) usage();
  return out;
}

/** Fetch one airport's facility payload; resolves with the raw concatenated buffer. */
function fetchAirport(handle, icao, requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let done = false;
    const finish = (err, buf) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handle.off("facilityData", onData);
      handle.off("facilityDataEnd", onEnd);
      handle.off("exception", onException);
      err ? reject(err) : resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error(`timed out after ${timeoutMs}ms waiting for facility data`)), timeoutMs);
    // Safety: resolve early once the sim says the request is complete.
    const onEnd = (recv) => {
      if (recv.userRequestId === requestId) finish(null);
    };
    const onData = (recv) => {
      if (recv.userRequestId !== requestId) return;
      try {
        const rb = recv.data;
        const full = rb.getBuffer();
        const off = rb.getOffset();
        chunks.push(full.subarray(off, off + rb.remaining()));
      } catch (e) {
        finish(e);
      }
    };
    const onException = (recv) => {
      // RecvException { exception, sendId }: correlate via the send id.
      if (recv.sendId === sendId) {
        finish(new Error(`sim rejected the facility request (${recv.exceptionName ?? `exception ${recv.exception}`})`));
      }
    };
    let sendId = -1;
    handle.on("facilityData", onData);
    handle.on("facilityDataEnd", onEnd);
    handle.on("exception", onException);
    sendId = handle.requestFacilityData(DEF_ID, requestId, icao);
  });
}

async function postProcedures(apiUrl, icao, procedures) {
  const cycle = `SIM-${new Date().toISOString().slice(0, 10)}`;
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ icao, procedures, cycle }),
  });
  if (!res.ok) throw new Error(`API ingest failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}

async function main() {
  const { icaos, apiUrl, timeoutMs } = parseArgs(process.argv.slice(2));

  let conn;
  try {
    conn = await open("FlightDeck navdata fetch", Protocol.KittyHawk);
  } catch (e) {
    console.error(`Could not connect to the simulator: ${e?.message ?? e}`);
    console.error("Is MSFS running on this PC?");
    process.exit(1);
  }
  const { handle, recvOpen } = conn;
  console.log(`Connected to ${recvOpen.applicationName}.`);

  for (const field of FACILITY_FIELDS) handle.addToFacilityDefinition(DEF_ID, field);

  const summary = [];
  let requestId = 1;
  for (const icao of icaos) {
    const started = Date.now();
    try {
      const raw = await fetchAirport(handle, icao, requestId++, timeoutMs);
      const parsed = parseAirportFacility(raw);
      const procedures = toSimProcedureInputs(parsed);
      const n = { SID: 0, STAR: 0, APPROACH: 0 };
      for (const p of procedures) n[p.kind]++;
      await postProcedures(apiUrl, icao, procedures);
      const line = `${icao}: ${n.SID} SIDs, ${n.STAR} STARs, ${n.APPROACH} approaches (${((Date.now() - started) / 1000).toFixed(1)}s)`;
      console.log(line);
      summary.push({ icao, ok: true, ...n });
    } catch (e) {
      const msg = `${icao}: FAILED — ${e instanceof FacilityParseError ? "parse error: " : ""}${e?.message ?? e}`;
      console.error(msg);
      summary.push({ icao, ok: false, error: String(e?.message ?? e) });
    }
  }

  try {
    await handle.close();
  } catch { /* already gone */ }
  console.log(JSON.stringify({ summary }));
  process.exit(summary.some((s) => !s.ok) ? 2 : 0);
}

main().catch((e) => {
  console.error(`Fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
