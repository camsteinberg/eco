// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig } from "@playwright/test";

/**
 * UI capture lane — screenshots every state in `e2e-capture/manifest` across a
 * grid of viewport / theme / motion / font-size projects.
 *
 * This is NOT the visual regression lane (`playwright.visual.config.ts`). That
 * one compares a handful of pages against committed baselines inside CI; this
 * one produces a browsable, dated inventory of the whole UI for human review,
 * written outside the repo. It runs on demand, never in the gate.
 *
 * Run:
 *   pnpm --filter @eco/web capture
 *   pnpm --filter @eco/web capture -- -g pilot.chat-empty-ready   (re-shoot one)
 *
 * Environment:
 *   ECO_CAPTURE_OUT      artifact base dir (default ~/eco-artifacts/ui-baseline)
 *   ECO_CAPTURE_PORT     dev/prod server port (default 3300 — never 3000)
 *   ECO_CAPTURE_SERVER   'prod' to shoot the production build instead of dev
 *   ECO_CAPTURE_WORKERS  parallel workers (default 4)
 *   ECO_CAPTURE_TIER     comma-separated tier filter, e.g. 'page,component'
 *   ECO_CAPTURE_MODE     'baseline' to assert against committed snapshots
 */
const PORT = Number(process.env.ECO_CAPTURE_PORT ?? 3300);
const BASE_URL = `http://localhost:${String(PORT)}`;

/**
 * @eco/ui is consumed from its build output, so a fresh worktree has no dist/
 * and every app route fails to resolve it. Building it first costs a couple of
 * seconds and removes an entire class of "the whole run is blank" confusion.
 */
const UI_BUILD = "pnpm --filter @eco/ui build";

const DEV_SERVER = `${UI_BUILD} && pnpm dev:validation`;
const PROD_SERVER =
  `${UI_BUILD} && NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true pnpm build`
  + ` && pnpm exec next start --port ${String(PORT)}`;

const MOBILE = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const TABLET = { viewport: { width: 768, height: 1024 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: "./e2e-capture/specs",
  testMatch: "*.capture.spec.ts",
  globalSetup: "./e2e-capture/global-setup.ts",
  globalTeardown: "./e2e-capture/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry: a capture is worthless if it is flaky, but a single dev-server
  // hiccup should not cost a 20-minute run. A state that needs the retry every
  // time shows up as "flaky" in the report and gets fixed, not tolerated.
  retries: 1,
  workers: Number(process.env.ECO_CAPTURE_WORKERS ?? 4),
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 90_000,

  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },

  use: {
    baseURL: BASE_URL,
    // Deterministic pixels need a deterministic locale and clock zone: dates,
    // number formatting and the fixed clock all read from these.
    locale: "en-US",
    timezoneId: "America/New_York",
    trace: "off",
    video: "off",
  },

  // A project is exactly one point on the axis grid; `parseProjectName` in
  // e2e-capture/fixtures.ts is the grammar. The reduce / font / system
  // projects only ever run entries that opt into those axes.
  projects: [
    { name: "desktop-light", use: DESKTOP },
    { name: "desktop-dark", use: DESKTOP },
    { name: "tablet-light", use: TABLET },
    { name: "tablet-dark", use: TABLET },
    { name: "mobile-light", use: MOBILE },
    { name: "mobile-dark", use: MOBILE },
    { name: "desktop-light-reduce", use: DESKTOP },
    { name: "desktop-dark-reduce", use: DESKTOP },
    { name: "desktop-light-font-compact", use: DESKTOP },
    { name: "desktop-light-font-comfortable", use: DESKTOP },
    { name: "desktop-system-light", use: DESKTOP },
    { name: "desktop-system-dark", use: DESKTOP },
  ],

  webServer: {
    command: process.env.ECO_CAPTURE_SERVER === "prod" ? PROD_SERVER : DEV_SERVER,
    // Probe a static asset, not `/`: `/` redirects into `/chat`, and a broken
    // build would hang the readiness probe instead of failing a test.
    url: `${BASE_URL}/manifest.webmanifest`,
    // Never reuse: a stray server may be a stale build, a different branch, or
    // the demo server on 3000 — any of which would silently mislabel a run.
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      // The site gate would 307 every capture to /gate.
      SITE_PASSWORD: "",
    },
  },
});
