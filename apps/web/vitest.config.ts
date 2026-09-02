// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    // Playwright lanes are excluded; `e2e-perf/lib/**` is deliberately NOT —
    // the perf gate's comparison and baseline helpers are plain modules with
    // vitest coverage, so only the Playwright spec itself is filtered out.
    exclude: [
      "e2e/**",
      "e2e-smoke/**",
      "e2e-webllm/**",
      // The capture lane's specs end in `.capture.spec.ts`, which vitest would
      // otherwise pick up; its manifest IS unit-tested, from src/__tests__.
      "e2e-capture/**",
      "e2e-perf/*.spec.ts",
      "e2e-acceptance/**",
      "node_modules/**",
    ],
  },
});
