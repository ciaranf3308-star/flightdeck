/**
 * Local SQLite store: settings + cached provider responses.
 *
 * SECURITY NOTE: provider API keys live in this local database file. On the
 * Windows desktop build the key is kept in the OS credential store via the
 * Tauri shell and only a reference is stored here; the Node service path
 * documents that limitation. Never log or return secret values.
 */
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { initLibraryTables } from "./library.js";
import { initImportsTable } from "./history.js";
import { initUserProcedureTables } from "./userprocedures.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/ -> package root -> ../../data
const dataDir = join(here, "..", "..", "data");
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "flightdeck.db"));

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lookup_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
`);

initLibraryTables(db);
initImportsTable(db);
initUserProcedureTables(db);

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  ).run(key, value, new Date().toISOString());
}

/** Public (non-secret) settings view — secrets are never listed. */
export function publicSettings(): Record<string, string | null> {
  const keys = ["provider", "simbriefUser", "navdataCycle", "openskyClientId", "updateFeedUrl", "updateAutoCheck"];
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = getSetting(k);
  out["flightAwareKeyConfigured"] = getSetting("flightAwareApiKey") ? "yes" : null;
  out["openskySecretConfigured"] = getSetting("openskyClientSecret") ? "yes" : null;
  return out;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheGet(cacheKey: string): string | null {
  const row = db
    .prepare("SELECT response_json, cached_at FROM lookup_cache WHERE cache_key = ?")
    .get(cacheKey) as { response_json: string; cached_at: string } | undefined;
  if (!row) return null;
  if (Date.now() - new Date(row.cached_at).getTime() > CACHE_TTL_MS) {
    db.prepare("DELETE FROM lookup_cache WHERE cache_key = ?").run(cacheKey);
    return null;
  }
  return row.response_json;
}

export function cacheSet(cacheKey: string, responseJson: string): void {
  db
    .prepare(
      "INSERT INTO lookup_cache(cache_key, response_json, cached_at) VALUES(?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json, cached_at=excluded.cached_at",
    )
    .run(cacheKey, responseJson, new Date().toISOString());
}

/** Drop cached entries whose key starts with a prefix (e.g. history results after an import changes). */
export function cacheInvalidatePrefix(prefix: string): void {
  db.prepare("DELETE FROM lookup_cache WHERE cache_key LIKE ?").run(`${prefix}%`);
}
