import path from "node:path";
import { describe, expect, it } from "vitest";
import { isInsideDir } from "../../services/planning-api/src/server.js";

const win32 = path.win32;

describe("isInsideDir", () => {
  it("accepts files inside the dir (posix)", () => {
    expect(isInsideDir("/a/public", "/a/public/index.html")).toBe(true);
    expect(isInsideDir("/a/public", "/a/public/assets/app.js")).toBe(true);
  });

  it("rejects traversal outside the dir (posix)", () => {
    expect(isInsideDir("/a/public", "/a/secret.txt")).toBe(false);
    expect(isInsideDir("/a/public", "/etc/passwd")).toBe(false);
  });

  it("accepts files inside the dir under Windows semantics", () => {
    // Regression: the 0.2.0 installer 404'd every static file on Windows
    // because the check was `file.startsWith(dir + "/")`, which never matches
    // backslash paths from resolve().
    const dir = win32.resolve("C:\\Program Files\\FlightDeck\\resources\\api\\public");
    const file = win32.resolve(dir, "index.html");
    expect(isInsideDir(dir, file, win32)).toBe(true);
    expect(isInsideDir(dir, win32.resolve(dir, "assets", "app.js"), win32)).toBe(true);
  });

  it("documents why the old check failed on Windows", () => {
    const dir = win32.resolve("C:\\Program Files\\FlightDeck\\resources\\api\\public");
    const file = win32.resolve(dir, "index.html");
    // The old expression — kept here as a regression anchor, not used in prod.
    expect(file.startsWith(dir + "/")).toBe(false);
    expect(isInsideDir(dir, file, win32)).toBe(true);
  });

  it("rejects traversal under Windows semantics", () => {
    const dir = win32.resolve("C:\\Program Files\\FlightDeck\\resources\\api\\public");
    expect(isInsideDir(dir, win32.resolve(dir, "..", "dist", "index.js"), win32)).toBe(false);
    expect(isInsideDir(dir, "C:\\Windows\\secret.txt", win32)).toBe(false);
  });
});
