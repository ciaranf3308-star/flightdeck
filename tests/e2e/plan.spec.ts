/**
 * End-to-end: the primary FlightDeck workflow against the real fixture.
 *
 * ENVIRONMENT NOTE: these tests need a real browser with loopback access to
 * http://127.0.0.1:5173 and :8124. They cannot run in sandboxes where the
 * browser is network-isolated from localhost (verified: both the managed
 * browser VM and local Chromium 152 block loopback navigation there).
 * Run them on a normal dev machine or CI: `npx playwright test`.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  (page as unknown as { __jsErrors: string[] }).__jsErrors = errors;
});

async function planHistorical(page: Page) {
  await page.goto("/");
  await expect(page.locator('input[placeholder="EI106"]')).toHaveValue("EI106");
  await page.getByRole("button", { name: "Look up & plan" }).click();
  // flight card appears
  await expect(page.locator(".card h2", { hasText: "EI106" }).first()).toBeVisible({ timeout: 20000 });
}

test("historical replay: EI106 plans with real data and honest provenance", async ({ page }) => {
  await planHistorical(page);

  // flight facts from the real snapshot
  await expect(page.locator("dd", { hasText: "EI-EAV" }).first()).toBeVisible();
  await expect(page.locator("dd", { hasText: "31L" }).first()).toBeVisible();

  // map renders with the filed route polyline
  await expect(page.locator(".leaflet-container")).toBeVisible();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible({ timeout: 15000 });

  // procedure recommendations
  await expect(page.getByText("Departure runway", { exact: true })).toBeVisible();
  const depCard = page.locator(".proc", { hasText: "Departure runway" });
  await expect(depCard.getByText("31L", { exact: true })).toBeVisible();
  const apprCard = page.locator(".proc", { hasText: "Approach" });
  await expect(apprCard.getByText("SYN-APPR-ILS28L")).toBeVisible();

  // provenance badges are shown, not hidden
  await expect(page.locator(".prov.verified").first()).toBeVisible();
  await expect(page.locator(".prov.unavailable").first()).toBeVisible();

  // route string marks coordinate-less fixes
  await expect(page.locator(".route-string .fix-nocoords").first()).toBeVisible();

  const errors: string[] = (page as unknown as { __jsErrors: string[] }).__jsErrors;
  expect(errors).toEqual([]);
});

test("current conditions mode re-plans with wind", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Current Conditions/ }).click();
  await page.locator('input[placeholder="270"]').first().fill("280");
  await page.locator('input[placeholder="10"]').first().fill("15");
  await page.getByRole("button", { name: "Look up & plan" }).click();
  await expect(page.locator(".card h2", { hasText: "EI106" }).first()).toBeVisible({ timeout: 20000 });
  // a runway is still recommended (deterministic), with wind evidence listed
  const depCard = page.locator(".proc", { hasText: "Departure runway" });
  await expect(depCard.locator(".val")).not.toBeEmpty();
  await depCard.locator("summary").click();
  await expect(depCard.getByText(/headwind/i).first()).toBeVisible();
});

test("export downloads a valid EFB PLN and import reads it back", async ({ page }) => {
  await planHistorical(page);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .pln", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pln$/);
  const path = await download.path();
  const xml = await readFile(path!, "utf8");
  expect(xml).toContain("<SimBase.Document>");
  expect(xml).toContain("<AppVersionMajor>12</AppVersionMajor>");
  expect(xml).toContain("<DepartureID>KJFK</DepartureID>");
  // coordinate-less oceanic fixes are excluded, never guessed
  expect(xml).not.toContain("N503B");
  // export manifest lists the exclusion
  await expect(page.getByText("N503B", { exact: false }).first()).toBeVisible();

  // import the same file back
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(path!);
  await expect(page.getByText("Imported plan")).toBeVisible({ timeout: 10000 });
  await expect(page.locator("dd", { hasText: "KJFK → EIDW" }).first()).toBeVisible();
});

test("unknown flight shows an explicit empty state", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[placeholder="EI106"]').fill("EI999");
  await page.getByRole("button", { name: "Look up & plan" }).click();
  await expect(page.locator(".errbox")).toContainText(/empty|no fixture/i, { timeout: 20000 });
});
