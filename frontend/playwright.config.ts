import { defineConfig, devices } from "@playwright/test";

/** Needs freshly seeded synthetic data, because the journeys use up demo assessments. See README.
 *  Set E2E_BASE_URL to test a server you started yourself; otherwise this starts `npm run dev`. */
const external = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: external ?? "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL ?? "chrome" } }],
  webServer: external ? undefined : { command: "npm run dev", url: "http://localhost:3000/login", reuseExistingServer: true, timeout: 180_000 },
});
