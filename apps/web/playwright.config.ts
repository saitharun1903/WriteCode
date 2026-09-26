import { defineConfig } from "@playwright/test";

/**
 * E2E tests run against the real dev servers. `ide.spec.ts` needs only the
 * web app; `execution.spec.ts` also needs the API, worker and Docker.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // Uses an installed browser; set PW_CHANNEL=chromium after `playwright install chromium` if preferred.
    channel: process.env.PW_CHANNEL ?? "msedge",
    viewport: { width: 1440, height: 900 },
    // Local staging uses Caddy's internal certificate authority for https://localhost.
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "1",
    trace: "retain-on-failure",
  },
  // Against a deployed site (E2E_BASE_URL) nothing is started locally.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
