// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { parseProjectName } from "../../e2e-capture/fixtures";
import config from "../../playwright.capture.config";

/**
 * The capture lane is run by hand, often against a machine that already has
 * other Eco servers up. These assertions pin the properties that keep a run
 * honest — if any drifts, the lane still produces PNGs but they stop meaning
 * what the run header says they mean.
 */
describe("capture config", () => {
  const webServer = Array.isArray(config.webServer) ? config.webServer[0] : config.webServer;
  const projects = config.projects ?? [];
  // A project name is not optional here: it IS the rendering context the
  // runner parses, so an unnamed project would have no axes at all.
  const projectNames = projects
    .map((project) => project.name)
    .filter((name): name is string => typeof name === "string");

  it("never reuses a running server — a stray one may serve another branch or build", () => {
    expect(webServer?.reuseExistingServer).toBe(false);
  });

  it("stays off port 3000, which is the demo/dev server's port", () => {
    expect(config.use?.baseURL).not.toContain(":3000");
    expect(webServer?.url).not.toContain(":3000");
  });

  it("captures both themes at all three viewports", () => {
    for (const viewport of ["desktop", "tablet", "mobile"]) {
      expect(projectNames, `${viewport} is missing a light project`).toContain(`${viewport}-light`);
      expect(projectNames, `${viewport} is missing a dark project`).toContain(`${viewport}-dark`);
    }
  });

  it("keeps the reduced-motion, font-size and system-theme projects available", () => {
    expect(projectNames).toContain("desktop-dark-reduce");
    expect(projectNames).toContain("desktop-light-font-comfortable");
    expect(projectNames).toContain("desktop-system-dark");
  });

  it("runs only the capture specs, from the capture directory", () => {
    expect(config.testDir).toBe("./e2e-capture/specs");
    expect(config.testMatch).toBe("*.capture.spec.ts");
  });

  it("pins locale and timezone so dates and number formatting cannot drift", () => {
    expect(config.use?.locale).toBe("en-US");
    expect(config.use?.timezoneId).toBe("America/New_York");
  });

  it("names every project in a grammar the runner can parse", () => {
    // A typo would otherwise surface only as a mid-run throw, after the
    // earlier projects had already shot.
    expect(projectNames.length).toBe(projects.length);
    for (const name of projectNames) {
      expect(() => parseProjectName(name), `project "${name}" does not parse`).not.toThrow();
    }
  });

  it("maps the system-theme projects to an unset app preference with an emulated OS one", () => {
    expect(parseProjectName("desktop-system-dark")).toMatchObject({ theme: "system", colorScheme: "dark" });
    expect(parseProjectName("desktop-system-light")).toMatchObject({ theme: "system", colorScheme: "light" });
    expect(parseProjectName("desktop-dark-reduce")).toMatchObject({ theme: "dark", motion: "reduce" });
    expect(parseProjectName("desktop-light-font-comfortable")).toMatchObject({ fontSize: "comfortable" });
  });

  it("builds the run header and index through global setup and teardown", () => {
    expect(config.globalSetup).toContain("global-setup");
    expect(config.globalTeardown).toContain("global-teardown");
  });
});
