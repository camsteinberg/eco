// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../../playwright.smoke.config";

/**
 * The bundle smoke lane is the gate's only browser check. These assertions pin
 * the properties that make it worth having — if any of them drifts, the lane
 * still passes but stops proving anything.
 */
describe("bundle smoke config", () => {
  const webServer = Array.isArray(config.webServer)
    ? config.webServer[0]
    : config.webServer;

  it("serves the real production build, not a dev server", () => {
    expect(webServer?.command).toContain("next start");
    expect(webServer?.command).not.toContain("dev");
  });

  it("never reuses an already-running server, which could serve a stale build", () => {
    expect(webServer?.reuseExistingServer).toBe(false);
  });

  it("probes a static asset for readiness so a broken page fails as a test, not a timeout", () => {
    // `/` redirects into `/chat`; when the bundle is broken `/chat` 500s and
    // Playwright would abandon the run on a webServer timeout instead of
    // reporting the console error the lane exists to surface.
    expect(webServer?.url).toContain("/manifest.webmanifest");
  });

  it("does not retry — an intermittent console error is still a console error", () => {
    expect(config.retries).toBe(0);
  });
});

describe("bundle smoke wiring", () => {
  const rootPackageJson = JSON.parse(
    // vitest runs with cwd = apps/web. `import.meta.url` is not a file: URL
    // under the jsdom environment, so resolve from cwd instead.
    readFileSync(resolve(process.cwd(), "../../package.json"), "utf8"),
  ) as { scripts: Record<string, string | undefined> };
  const qa = rootPackageJson.scripts.qa ?? "";

  it("runs inside pnpm qa", () => {
    expect(qa).toContain("pnpm smoke");
  });

  it("runs after the build it inspects", () => {
    expect(qa.indexOf("pnpm build")).toBeGreaterThan(-1);
    expect(qa.indexOf("pnpm smoke")).toBeGreaterThan(qa.indexOf("pnpm build"));
  });

  it("runs before the unit suite, whose deliberate coverage-floor red would abort the chain first", () => {
    expect(qa.indexOf("pnpm smoke")).toBeLessThan(qa.indexOf("pnpm test"));
  });
});
