// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig } from "@playwright/test";

/**
 * Performance-gate lane — separate runner, NOT part of the default `test:e2e`
 * suite, and not (yet) wired into CI.
 *
 * Why its own config:
 *
 *  - MEASUREMENT VALIDITY. Perf numbers taken against the Turbopack dev server
 *    are meaningless (unminified, HMR-instrumented, per-request compilation).
 *    This lane builds and serves a PRODUCTION bundle via `next start`.
 *  - DOWNLOAD ISOLATION. The gate keeps a real, disk-backed browser profile
 *    with a real cached model. A real download inside the default suite starves
 *    every `networkidle` wait in it (a documented repo failure mode), so this
 *    lane must never share a runner with `e2e/`.
 *  - WEBGPU. Real token generation needs a real GPU: headed real Chrome via
 *    `chromium.launchPersistentContext` in the spec, not headless Chromium.
 *
 * Dedicated port 3100 (not 3000) on purpose: a dev server left running on 3000
 * would otherwise be silently reused and every number in the run would be
 * invalid. Nothing but this lane serves 3100.
 *
 * Run:
 *   pnpm --filter @eco/web perf-gate                    # compare vs baseline
 *   ECO_PERF_UPDATE_BASELINE=1 pnpm --filter @eco/web perf-gate   # re-record
 *
 * See `e2e-perf/README.md` for the workflow and the tolerance-tightening path.
 */

const WEB_BASE_URL = "http://localhost:3100";

const PROD_ENV = [
  "NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true",
  "NEXT_PUBLIC_API_URL=http://127.0.0.1:3001",
  // Model bytes CDN-first, matching production transport (the same-origin
  // proxy stays as the in-app fallback). Only the one-time prefetch run
  // downloads anything; measured runs read the browser cache.
  "NEXT_PUBLIC_ECO_MODEL_CDN_BASE=https://models.econetwork.ai",
].join(" ");

export default defineConfig({
  testDir: "./e2e-perf",
  // Only the Playwright spec — `lib/**/*.test.ts` are vitest unit tests for the
  // comparison helpers and would otherwise be collected here.
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  // A perf gate that retries is a perf gate that hides variance.
  retries: 0,
  reporter: "list",
  // One test walks the whole session: an optional first-run model download,
  // then N sampled page-load + two-turn journeys on a real GPU.
  timeout: 2_400_000,

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? WEB_BASE_URL,
  },

  // No API server: the spec stubs `**/api/auth/**` at the context level, and
  // chat never touches the gateway.
  webServer: [
    {
      command: `${PROD_ENV} pnpm --filter @eco/web build && ${PROD_ENV} PORT=3100 pnpm --filter @eco/web start`,
      url: WEB_BASE_URL,
      // Safe to reuse: 3100 is this lane's dedicated production port, so an
      // existing server there is a warm `next start` from a previous run.
      reuseExistingServer: true,
      timeout: 900_000,
    },
  ],
});
