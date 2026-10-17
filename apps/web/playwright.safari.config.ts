// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig } from "@playwright/test";

/**
 * Safari acceptance lane — opt-in, never in `pnpm qa` and never in CI.
 *
 * Playwright is only the test RUNNER here: it loads the TypeScript, keeps the
 * timeouts and records a walk that dies. The browser is real Safari, driven
 * over WebDriver by `e2e-acceptance/safari/` — no Playwright browser starts.
 *
 * There is no `webServer`: the walk takes the origin it opens from
 * `ECO_SAFARI_BASE_URL`, and the operator starts that server with the harness
 * build and `API_URL` pointing at the lane's stub (README, "The Safari run").
 *
 * Run:
 *   ECO_SAFARI_TARGET=mac ECO_SAFARI_BASE_URL=http://127.0.0.1:3132 \
 *     pnpm --filter @eco/web test:acceptance:safari
 *
 * Output: `test-results/acceptance-report-safari-<target>.json` and `.md`.
 */

export default defineConfig({
  testDir: "./e2e-acceptance/safari",
  // `.safari.ts`, not `.spec.ts`, so neither the Chrome lane nor vitest picks it up.
  testMatch: "*.safari.ts",
  globalSetup: "./e2e-acceptance/safari/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  // A walk that retries is a walk that hides a wedge.
  retries: 0,
  reporter: "list",
  timeout: 5_400_000,
});
