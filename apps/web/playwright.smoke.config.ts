// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig, devices } from "@playwright/test";

/**
 * Bundle smoke lane — the browser half of `pnpm qa`.
 *
 * `pnpm qa` (type-check, lint, circular-deps, unit tests, build) never
 * evaluates the emitted bundle in a browser. On 2026-08-08 that let a build
 * miscompilation ship a chunk that threw at module evaluation — every page
 * importing it was dead — while all 5415 unit tests and a forced `pnpm qa`
 * passed green. This lane closes that hole: it serves the REAL production
 * build with `next start` and fails on any console error or uncaught page
 * error on the app's two load-bearing surfaces.
 *
 * It is deliberately tiny (two page loads, ~20s including server boot) so it
 * can live inside the gate. It is not a functional E2E lane — the full `e2e/`
 * suite still runs separately.
 *
 * Requires a build to already exist (`pnpm build`); `pnpm qa` runs it first.
 *
 * Run:
 *   pnpm --filter @eco/web test:smoke
 */
const SMOKE_PORT = Number(process.env.ECO_SMOKE_PORT ?? 3210);
const SMOKE_BASE_URL = `http://localhost:${SMOKE_PORT}`;

export default defineConfig({
  testDir: "./e2e-smoke",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries, ever: a console error that only appears sometimes is still a
  // console error, and a retry would hide it.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "list" : [["list"]],
  timeout: 60_000,

  use: {
    baseURL: SMOKE_BASE_URL,
    trace: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // `next start` serves .next/ exactly as production does — no dev server,
    // no Turbopack, no HMR. That is the whole point: the bug class this lane
    // exists for only appears in the production compilation.
    command: `pnpm exec next start --port ${SMOKE_PORT}`,
    // Probe a static asset, NOT `/`. `/` redirects into `/chat`, and when the
    // bundle is broken `/chat` 500s — Playwright then never sees the server as
    // ready and the lane dies on a 60s webServer timeout instead of reporting
    // the actual error. The manifest bypasses middleware and cannot break, so
    // readiness means "server up" and the assertion below reports the defect.
    url: `${SMOKE_BASE_URL}/manifest.webmanifest`,
    // Never reuse: an already-running server may be serving a stale build.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // The site-gate would 307 every surface to /gate and the smoke would
      // pass against a page that proves nothing.
      SITE_PASSWORD: "",
    },
  },
});
