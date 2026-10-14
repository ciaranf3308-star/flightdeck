/**
 * FlightDeck auto-updater (server side).
 *
 * The installed Windows app checks a small JSON feed over HTTPS:
 *   { "version": "0.2.0", "url": "https://…/FlightDeck-Setup-0.2.0.exe",
 *     "sha256": "…", "notes": "…" }
 * When the feed version is newer, the app can download the installer, verify
 * its SHA-256, and run it silently (`/S`). The NSIS installer stops the
 * running backend, replaces files, and reopens the app. The local SQLite DB
 * (saved flights, settings) is never touched by the installer.
 *
 * Security: feed URLs must be https:// (http://localhost allowed for tests);
 * the installer hash is verified before anything executes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSetting, setSetting } from "./db.js";

const here = dirname(fileURLToPath(import.meta.url));

/** App version from the bundled package.json (stage.sh copies it into the bundle). */
export function getAppVersion(): string {
  for (const candidate of [
    resolve(here, "..", "package.json"), // packaged: resources/api/package.json
    resolve(here, "..", "..", "package.json"), // dev: services/planning-api/package.json
  ]) {
    try {
      if (!existsSync(candidate)) continue;
      const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      /* keep looking */
    }
  }
  return "0.0.0-dev";
}

/**
 * Baked-in feed URL shipped with the installer (installer/update-feed.json ->
 * resources/api/update-feed.json). Lets future installers phone home without
 * any manual configuration. Empty/missing = updater stays dormant.
 * The path is injectable for tests.
 */
export function readDefaultFeedUrl(file = resolve(here, "..", "update-feed.json")): string | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, "utf-8")) as { url?: unknown };
    return typeof j.url === "string" && j.url.trim() ? j.url.trim() : null;
  } catch {
    return null;
  }
}

/** Numeric semver compare: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export interface UpdateFeed {
  version: string;
  url: string;
  sha256: string;
  notes?: string;
}

export interface UpdateState {
  currentVersion: string;
  feedUrl: string | null;
  autoCheck: boolean;
  lastCheck: string | null;
  lastError: string | null;
  updateAvailable: boolean;
  latestVersion: string | null;
  notes: string | null;
  downloadUrl: string | null;
  downloadedPath: string | null;
  downloadedOk: boolean;
}

function updatesDir(): string {
  // Packaged layout: <install>/resources/api/updates. Dev: OS tmp.
  const packaged = existsSync(resolve(here, "..", "..", "node"));
  const dir = packaged ? resolve(here, "..", "updates") : join(tmpdir(), "flightdeck-updates");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function assertFeedUrl(feedUrl: string): void {
  const u = new URL(feedUrl);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) {
    throw new Error("Update feed must be https:// (http://localhost allowed for testing).");
  }
}

function parseFeed(json: unknown): UpdateFeed {
  const f = json as Record<string, unknown>;
  if (typeof f?.version !== "string" || typeof f?.url !== "string" || typeof f?.sha256 !== "string") {
    throw new Error("Update feed is not a valid latest.json (need version, url, sha256).");
  }
  const u = new URL(f.url);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    throw new Error("Update download URL must be https://.");
  }
  if (!/^[0-9a-f]{64}$/i.test(f.sha256)) throw new Error("Update feed sha256 is malformed.");
  return {
    version: f.version,
    url: f.url,
    sha256: f.sha256.toLowerCase(),
    notes: typeof f.notes === "string" ? f.notes : undefined,
  };
}

/** Returns the feed when a newer version exists, null when up to date. */
export async function checkForUpdate(feedUrl: string, currentVersion: string): Promise<UpdateFeed | null> {
  assertFeedUrl(feedUrl);
  const res = await fetch(feedUrl, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`Update feed returned HTTP ${res.status}.`);
  const feed = parseFeed(await res.json());
  return compareVersions(feed.version, currentVersion) > 0 ? feed : null;
}

/** Download the installer and verify its SHA-256 before keeping it. */
export async function downloadUpdate(feed: UpdateFeed): Promise<string> {
  const dir = updatesDir();
  const dest = join(dir, `FlightDeck-Setup-${feed.version}.exe`);
  const tmp = `${dest}.part`;
  const res = await fetch(feed.url);
  if (!res.ok) throw new Error(`Update download returned HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== feed.sha256) {
    throw new Error("Downloaded installer failed SHA-256 verification — not kept.");
  }
  writeFileSync(tmp, buf);
  try {
    if (existsSync(dest)) unlinkSync(dest);
  } catch {
    /* ignore */
  }
  renameSync(tmp, dest);
  return dest;
}

export function getUpdateState(): UpdateState {
  const downloadedPath = getSetting("updateDownloadedPath");
  const downloadedOk =
    !!downloadedPath &&
    getSetting("updateDownloadedVersion") === getSetting("updateLatestVersion") &&
    existsSync(downloadedPath);
  // Explicit setting wins; otherwise the baked-in installer default.
  const feedUrl = getSetting("updateFeedUrl") || readDefaultFeedUrl();
  return {
    currentVersion: getAppVersion(),
    feedUrl,
    autoCheck: getSetting("updateAutoCheck") !== "0",
    lastCheck: getSetting("updateLastCheck"),
    lastError: getSetting("updateLastError"),
    updateAvailable: getSetting("updateAvailable") === "1",
    latestVersion: getSetting("updateLatestVersion"),
    notes: getSetting("updateNotes"),
    downloadUrl: getSetting("updateDownloadUrl"),
    downloadedPath: downloadedOk ? downloadedPath : null,
    downloadedOk,
  };
}

export function recordCheck(feed: UpdateFeed | null, error: string | null): UpdateState {
  setSetting("updateLastCheck", new Date().toISOString());
  setSetting("updateLastError", error ?? "");
  if (error) {
    setSetting("updateAvailable", "0");
  } else if (feed) {
    setSetting("updateAvailable", "1");
    setSetting("updateLatestVersion", feed.version);
    setSetting("updateNotes", feed.notes ?? "");
    setSetting("updateDownloadUrl", feed.url);
    setSetting("updateSha256", feed.sha256);
    // A new version invalidates any previously downloaded file.
    if (getSetting("updateDownloadedVersion") !== feed.version) {
      setSetting("updateDownloadedPath", "");
      setSetting("updateDownloadedVersion", "");
    }
  } else {
    setSetting("updateAvailable", "0");
    setSetting("updateLatestVersion", "");
    setSetting("updateNotes", "");
  }
  return getUpdateState();
}

export function recordDownload(path: string, version: string): void {
  try {
    statSync(path);
  } catch {
    throw new Error("Downloaded file is missing.");
  }
  setSetting("updateDownloadedPath", path);
  setSetting("updateDownloadedVersion", version);
}
