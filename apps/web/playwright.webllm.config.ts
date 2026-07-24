// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig } from "@playwright/test";

// Origin notes mirror playwright.config.ts: web must be `localhost` (Turbopack
// HMR + local-AI bootstrap only settle there), API on 127.0.0.1.
const WEB_BASE_URL = "http://localhost:3000";
const API_BASE_URL = "http://127.0.0.1:3001";

/**
 * WebLLM-lane E2E — separate runner, NOT part of the default `test:e2e` suite.
 *
 * This journey is real end-to-end: a fresh disk-backed browser profile, a real
 * ~270MB model download, a real WebGPU engine load, real token generation. It
 * therefore cannot live under the default config: the 30s test timeout can't
 * hold a model download, headless CI Chromium has no WebGPU, and ephemeral
 * Playwright contexts reject large Cache.put calls. The spec launches its own
 * headed persistent context (real Chrome) and needs a machine with WebGPU.
 *
 * Run:
 *   pnpm --filter @eco/web test:e2e:webllm
 *
 * This is the standing pre-merge gate for any change touching the local-AI
 * download/runtime/chat pipeline.
 */
export default defineConfig({
  testDir: "./e2e-webllm",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  // Budget: model download over residential bandwidth + cold engine load
  // (smoke load budget alone is up to 240s on the forced-mobile profile) +
  // two generation turns.
  timeout: 1_200_000,

  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? WEB_BASE_URL,
  },

  webServer: [
    {
      command: [
        "PORT=3001",
        `BETTER_AUTH_BASE_URL=${API_BASE_URL}`,
        `WEB_URL=${WEB_BASE_URL}`,
        "pnpm --filter @eco/api dev",
      ].join(" "),
      url: `${API_BASE_URL}/health/ready`,
      reuseExistingServer: true,
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
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
