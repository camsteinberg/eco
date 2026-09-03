// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig } from "@playwright/test";

/**
 * Acceptance lane — opt-in, never in `pnpm qa` and never in CI.
 *
 * Why its own config, matching the perf lane's reasoning:
 *
 *  - PRODUCTION BUILD. The walk judges what a person would experience, and the
 *    dev server is not that: unminified, HMR-instrumented, compiled per
 *    request. This lane builds and serves a production bundle.
 *  - DOWNLOAD ISOLATION. It keeps a real, disk-backed browser profile with
 *    real cached models, and its first run downloads gigabytes. A real
 *    download inside the default suite starves every `networkidle` wait in it,
 *    so this lane must never share a runner with `e2e/`.
 *  - WEBGPU. Real token generation needs a real GPU: headed real Chrome via
 *    `chromium.launchPersistentContext` in the spec, not headless Chromium.
 *
 * Dedicated port 3120 on purpose. A dev server on 3000, or the perf lane's
 * server on 3100, would otherwise be reused silently and the walk would be
 * describing a different build than the one under test.
 *
 * Run:
 *   pnpm --filter @eco/web test:acceptance
 *
 * Output: `test-results/acceptance-report.json` and `.md`, one table per
 * shipping model, one row per turn.
 */

const WEB_BASE_URL = "http://localhost:3120";

const PROD_ENV = [
  "NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true",
  "NEXT_PUBLIC_API_URL=http://127.0.0.1:3001",
  // Model bytes CDN-first, matching production transport.
  "NEXT_PUBLIC_ECO_MODEL_CDN_BASE=https://models.econetwork.ai",
].join(" ");

export default defineConfig({
  testDir: "./e2e-acceptance",
  // Clears the previous run's report fragments — see e2e-acceptance/lib/report.
  globalSetup: "./e2e-acceptance/global-setup.ts",
  // Only the Playwright spec; `lib/**` are plain modules, not tests.
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  // A walk that retries is a walk that hides a wedge.
  retries: 0,
  reporter: "list",
  // Provisioning plus two full walks of real generation.
  timeout: 5_400_000,

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? WEB_BASE_URL,
  },

  // No API server: the spec stubs `**/api/auth/**` at the context level, and
  // chat never touches the gateway.
  webServer: [
    {
      command: `${PROD_ENV} pnpm --filter @eco/web build && ${PROD_ENV} PORT=3120 pnpm --filter @eco/web start`,
      url: WEB_BASE_URL,
      // Safe to reuse: 3120 is this lane's dedicated production port, so an
      // existing server there is a warm `next start` from a previous run.
      reuseExistingServer: true,
      timeout: 900_000,
    },
  ],
});
