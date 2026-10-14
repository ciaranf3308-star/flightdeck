/**
 * Packaged-runtime integration test.
 *
 * Starts the REAL staged bundle layout (compiled API + built SPA) from a
 * DIFFERENT working directory — proving static paths resolve from the
 * installed location, not the dev cwd — and checks:
 *   GET /            -> 200, the frontend HTML
 *   GET /assets/*.js -> 200, javascript
 *   GET /history     -> 200, index.html (SPA fallback for client routes)
 *   GET /api/health  -> 200, JSON API response (not intercepted by fallback)
 *   GET /api/aircraft-> 200, JSON
 *   GET /../package.json -> never leaks files outside public/
 *
 * Requires the built outputs: run `npm run build` first (or installer/stage.sh).
 * This is an automated Linux check of the packaged layout; it is NOT a
 * substitute for running the installer on Windows.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const API_DIST = join(ROOT, "services/planning-api/dist");
const SPA_DIST = join(ROOT, "apps/desktop/dist");
const PKG = join(ROOT, "services/planning-api/package.json");

let port = 0;
let proc: ChildProcess | null = null;
const stage = join(tmpdir(), `fd-pkgtest-${process.pid}`);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitForHealth(tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("packaged API did not become healthy");
}

beforeAll(async () => {
  for (const [p, what] of [
    [API_DIST, "services/planning-api/dist (run npm run build)"],
    [SPA_DIST, "apps/desktop/dist (run npm run build)"],
  ] as const) {
    if (!existsSync(p)) throw new Error(`Missing ${what}`);
  }
  // Assemble a packaged layout: <stage>/api/{dist,public,package.json,node_modules}
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "api"), { recursive: true });
  cpSync(API_DIST, join(stage, "api", "dist"), { recursive: true });
  cpSync(SPA_DIST, join(stage, "api", "public"), { recursive: true });
  cpSync(PKG, join(stage, "api", "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(stage, "api", "node_modules"));

  port = await freePort();
  proc = spawn(process.execPath, [join(stage, "api", "dist", "index.js")], {
    cwd: tmpdir(), // <-- different working directory than the install
    env: { ...process.env, FLIGHTDECK_PACKAGED: "1", FLIGHTDECK_PORT: String(port) },
    stdio: "ignore",
  });
  await waitForHealth();
}, 90000);

afterAll(async () => {
  if (proc) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" });
    } catch {
      /* may already be down */
    }
    proc.kill("SIGKILL");
    proc = null;
  }
  rmSync(stage, { recursive: true, force: true });
});

const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);

describe("packaged runtime", () => {
  it("serves the frontend at GET /", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain('<div id="root"');
  });

  it("serves hashed assets with the right content type", async () => {
    const html = await (await get("/")).text();
    const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(m).toBeTruthy();
    const r = await get(m![1]);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("javascript");
    expect((await r.text()).length).toBeGreaterThan(1000);
  });

  it("falls back to index.html for client-side routes", async () => {
    for (const p of ["/history", "/plan", "/settings"]) {
      const r = await get(p);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('<div id="root"');
    }
  });

  it("keeps /api/* on the API (not intercepted by the SPA fallback)", async () => {
    const health = await get("/api/health");
    expect(health.status).toBe(200);
    const h = (await health.json()) as { packaged?: boolean; version?: string };
    expect(h.packaged).toBe(true);

    const ac = await get("/api/aircraft");
    expect(ac.status).toBe(200);
    expect(ac.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(await ac.json())).toContain("A330");
  });

  it("never serves files outside public/", async () => {
    const r = await get("/../package.json");
    const body = await r.text();
    // Either 404 or the SPA fallback — never the raw package.json.
    expect(body).not.toContain('"@flightdeck');
  });
});
