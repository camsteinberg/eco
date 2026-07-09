// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig, devices } from "@playwright/test";

// The web origin is `localhost`, not `127.0.0.1`, on purpose: under the Next 16
// Turbopack dev server the HMR WebSocket and the local-AI bootstrap pipeline only
// settle on `localhost` here — on `127.0.0.1` the HMR handshake fails and the
// setup gate never releases the chat composer, so composer-based specs (the
// no-egress local-fixture tests, "offline after ready") can't find their inputs.
// Both hosts are loopback-gated identically for the validation harness, so this
// only affects the dev server, never production. Keep it `localhost`.
const WEB_BASE_URL = "http://localhost:3000";
const API_BASE_URL = "http://127.0.0.1:3001";

/**
 * Playwright configuration for Eco web app E2E tests.
 *
 * Prerequisites:
 *   - API server running at http://127.0.0.1:3001
 *   - Web app running at http://localhost:3000
 *
 * Run:
 *   pnpm --filter @eco/web test:e2e
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 30_000,

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? WEB_BASE_URL,
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: [
    {
      command: [
        "PORT=3001",
        `BETTER_AUTH_BASE_URL=${API_BASE_URL}`,
        `WEB_URL=${WEB_BASE_URL}`,
        "pnpm --filter @eco/api dev",
      ].join(" "),
      url: `${API_BASE_URL}/health/ready`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: [
        "PORT=3000",
        `NEXT_PUBLIC_API_URL=${API_BASE_URL}`,
        "NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true",
        "pnpm --filter @eco/web dev",
      ].join(" "),
      url: WEB_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
