// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import config from "../../playwright.perf.config";

function getWebServers() {
  return Array.isArray(config.webServer)
    ? config.webServer
    : config.webServer
      ? [config.webServer]
      : [];
}

describe("playwright perf config", () => {
  it("measures a production build, never the dev server", () => {
    const [webServer] = getWebServers();

    expect(webServer?.command).toContain("pnpm --filter @eco/web build");
    expect(webServer?.command).toContain("pnpm --filter @eco/web start");
    // Turbopack dev-server timings are meaningless as a perf baseline; this is
    // the assertion that keeps a convenience edit from invalidating every number.
    expect(webServer?.command).not.toContain("pnpm --filter @eco/web dev");
  });

  it("serves the perf lane on its own port so a dev server is never reused", () => {
    const [webServer] = getWebServers();

    expect(config.use?.baseURL).toBe("http://localhost:3100");
    expect(webServer?.url).toBe("http://localhost:3100");
    expect(webServer?.command).toContain("PORT=3100");
  });

  it("enables the validation harness so the measurement bridge exists", () => {
    const [webServer] = getWebServers();

    expect(webServer?.command).toContain("NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true");
  });

  it("collects only the Playwright spec, not the vitest helper tests", () => {
    expect(config.testDir).toBe("./e2e-perf");
    expect(config.testMatch).toBe("*.spec.ts");
  });

  it("never retries — a retried perf run hides variance", () => {
    expect(config.retries).toBe(0);
  });
});
