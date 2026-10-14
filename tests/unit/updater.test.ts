import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  readDefaultFeedUrl,
  type UpdateFeed,
} from "../../services/planning-api/src/update.js";

describe("compareVersions", () => {
  it("orders versions numerically", () => {
    expect(compareVersions("0.1.1", "0.1.2")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
  });
});

describe("readDefaultFeedUrl", () => {
  it("returns null for a missing file", () => {
    expect(readDefaultFeedUrl("/nonexistent/update-feed.json")).toBeNull();
  });

  it("returns null for an empty url (dormant updater)", () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-feed-"));
    try {
      const f = join(dir, "update-feed.json");
      writeFileSync(f, JSON.stringify({ url: "" }));
      expect(readDefaultFeedUrl(f)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the baked-in url when set", () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-feed-"));
    try {
      const f = join(dir, "update-feed.json");
      const url = "https://github.com/o/r/releases/latest/download/latest.json";
      writeFileSync(f, JSON.stringify({ url }));
      expect(readDefaultFeedUrl(f)).toBe(url);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for malformed json", () => {
    const dir = mkdtempSync(join(tmpdir(), "fd-feed-"));
    try {
      const f = join(dir, "update-feed.json");
      writeFileSync(f, "not json{");
      expect(readDefaultFeedUrl(f)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("update feed", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  function feedServer(feed: unknown, status = 200): Promise<string> {
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(typeof feed === "string" ? feed : JSON.stringify(feed));
      });
      server.listen(0, "127.0.0.1", () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${(a as { port: number }).port}/latest.json`);
      });
    });
  }

  const goodFeed = (version: string, url = "https://example.com/fd.exe") => ({
    version,
    url,
    sha256: "a".repeat(64),
    notes: "test",
  });

  it("returns the feed when a newer version exists", async () => {
    const url = await feedServer(goodFeed("0.2.0"));
    const feed = await checkForUpdate(url, "0.1.1");
    expect(feed?.version).toBe("0.2.0");
  });

  it("returns null when up to date", async () => {
    const url = await feedServer(goodFeed("0.1.1"));
    expect(await checkForUpdate(url, "0.1.1")).toBeNull();
  });

  it("returns null when the feed is older", async () => {
    const url = await feedServer(goodFeed("0.1.0"));
    expect(await checkForUpdate(url, "0.1.1")).toBeNull();
  });

  it("rejects a malformed feed", async () => {
    const url = await feedServer({ version: "0.2.0" });
    await expect(checkForUpdate(url, "0.1.1")).rejects.toThrow(/valid latest\.json/);
  });

  it("rejects a non-https feed URL", async () => {
    await expect(checkForUpdate("http://example.com/latest.json", "0.1.1")).rejects.toThrow(/https/);
  });

  it("rejects a non-https download URL in the feed", async () => {
    const url = await feedServer(goodFeed("0.2.0", "http://example.com/fd.exe"));
    await expect(checkForUpdate(url, "0.1.1")).rejects.toThrow(/https/);
  });

  it("rejects a malformed sha256", async () => {
    const url = await feedServer({ ...goodFeed("0.2.0"), sha256: "zzz" });
    await expect(checkForUpdate(url, "0.1.1")).rejects.toThrow(/sha256/);
  });

  it("verifies the download hash and rejects tampered files", async () => {
    const payload = Buffer.from("fake-installer-bytes");
    const digest = createHash("sha256").update(payload).digest("hex");
    const dlUrl = await new Promise<string>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(payload);
      });
      s.listen(0, "127.0.0.1", () => {
        const a = s.address() as { port: number };
        // keep the download server alive for this test; close via server var
        server = s;
        resolve(`http://127.0.0.1:${a.port}/fd.exe`);
      });
    });
    const feed: UpdateFeed = { version: "9.9.9-test", url: dlUrl, sha256: digest };
    const path = await downloadUpdate(feed);
    expect(path).toMatch(/FlightDeck-Setup-9\.9\.9-test\.exe$/);

    const bad: UpdateFeed = { ...feed, sha256: "b".repeat(64) };
    await expect(downloadUpdate(bad)).rejects.toThrow(/SHA-256/);
  });
});
