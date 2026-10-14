import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  webServer: [
    {
      command: "npm run dev --workspace=@flightdeck/planning-api",
      url: "http://127.0.0.1:8124/api/health",
      reuseExistingServer: true,
      timeout: 90000,
    },
    {
      command: "npm run dev --workspace=@flightdeck/desktop -- --port 5173 --strictPort",
      url: "http://127.0.0.1:5173/",
      reuseExistingServer: true,
      timeout: 90000,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:5173",
    // Use the preinstalled Chromium: the Playwright CDN is unreachable from here.
    // --no-proxy-server: the sandbox proxy env breaks localhost navigation.
    launchOptions: { executablePath: "/opt/meta-chromium/chrome", args: ["--no-proxy-server", "--no-sandbox"] },
  },
});
