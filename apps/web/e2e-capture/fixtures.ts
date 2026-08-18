// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { homedir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { captureState } from "./capture";
import type { CaptureContext, FontSizeName, StateEntry, ThemeName, ViewportName } from "./types";

/**
 * The capture lane's Playwright fixtures.
 *
 * Two jobs: keep the network out of the picture (deterministic pixels need
 * deterministic responses), and turn the Playwright project name into the
 * rendering context `captureState` needs.
 *
 * The API-mocking logic is ported from `e2e/visual/fixtures.ts` rather than
 * imported: the visual lane owns its own baselines and must stay free to change
 * without silently re-shooting every capture in this lane.
 */

const SIGNED_IN_SESSION = {
  session: {
    id: "test-session",
    userId: "test-user-id",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
  user: {
    id: "test-user-id",
    email: "test@eco.network",
    name: "Test User",
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

export const DEFAULT_CAPTURE_OUT = join(homedir(), "eco-artifacts", "ui-baseline");

/** Base directory holding every capture run. */
export function captureOutputBase(): string {
  return process.env.ECO_CAPTURE_OUT ?? DEFAULT_CAPTURE_OUT;
}

/**
 * This run's directory. `globalSetup` mints the run id and exports it; if the
 * lane is somehow started without it, fall back to a timestamp so a stray run
 * still writes somewhere sane instead of overwriting the last real one.
 */
export function captureRunId(): string {
  return process.env.ECO_CAPTURE_RUN_ID ?? `adhoc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export function captureRunDir(): string {
  return process.env.ECO_CAPTURE_RUN_DIR ?? join(captureOutputBase(), captureRunId());
}

const VIEWPORTS: readonly ViewportName[] = ["mobile", "tablet", "desktop"];
const FONT_SIZES: readonly FontSizeName[] = ["default", "compact", "comfortable"];

/**
 * Parse a project name into a point on the axis grid.
 *
 * Grammar: `<viewport>-<theme>[-reduce][-font-<size>]`, where `<theme>` is
 * `light`, `dark`, or `system-light` / `system-dark` (app preference unset, OS
 * preference emulated). Unknown names throw — a typo in the config would
 * otherwise quietly produce a whole project of mislabeled screenshots.
 */
export function parseProjectName(project: string): Omit<CaptureContext, "outputRoot" | "runId"> {
  const tokens = project.split("-");
  const viewport = tokens.shift();
  if (!viewport || !VIEWPORTS.includes(viewport as ViewportName)) {
    throw new Error(`Capture project "${project}": unknown viewport segment "${String(viewport)}"`);
  }

  const themeToken = tokens.shift();
  let theme: ThemeName;
  let colorScheme: "light" | "dark";

  if (themeToken === "system") {
    const osToken = tokens.shift();
    if (osToken !== "light" && osToken !== "dark") {
      throw new Error(`Capture project "${project}": system theme needs a -light or -dark suffix`);
    }
    theme = "system";
    colorScheme = osToken;
  } else if (themeToken === "light" || themeToken === "dark") {
    theme = themeToken;
    colorScheme = themeToken;
  } else {
    throw new Error(`Capture project "${project}": unknown theme segment "${String(themeToken)}"`);
  }

  let motion: CaptureContext["motion"] = "no-preference";
  let fontSize: FontSizeName = "default";

  while (tokens.length > 0) {
    const token = tokens.shift();
    if (token === "reduce") {
      motion = "reduce";
      continue;
    }
    if (token === "font") {
      const size = tokens.shift();
      if (!size || !FONT_SIZES.includes(size as FontSizeName)) {
        throw new Error(`Capture project "${project}": unknown font size "${String(size)}"`);
      }
      fontSize = size as FontSizeName;
      continue;
    }
    throw new Error(`Capture project "${project}": unexpected segment "${String(token)}"`);
  }

  return { viewport: viewport as ViewportName, theme, colorScheme, motion, fontSize, project };
}

async function installRouteMocks(page: Page, signedIn: boolean): Promise<void> {
  await page.route("**/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  await page.route("**/api/auth/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (!pathname.endsWith("/api/auth/get-session")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: signedIn ? JSON.stringify(SIGNED_IN_SESSION) : "null",
    });
  });

  await page.route("**/internal/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );

  // The service worker would serve cached HTML on later navigations, so one
  // run's captures could show another run's build. `eco-skip-sw-registration-once`
  // already asks the app not to register it; aborting the script is the belt to
  // that suspenders.
  await page.route("**/sw.js", (route) => route.abort());
}

type CaptureFixtures = {
  captureContext: CaptureContext;
  /**
   * Capture one manifest entry. Owns the `auth` axis so a wave's spec file
   * stays a plain loop and cannot forget to sign in.
   */
  capture: (entry: StateEntry) => Promise<void>;
};

export const captureTest = base.extend<CaptureFixtures>({
  // The empty pattern is Playwright's own convention: it parses the first
  // parameter's destructured names to work out fixture dependencies, and this
  // fixture depends on none — only on testInfo.
  // eslint-disable-next-line no-empty-pattern
  captureContext: async ({}, use, testInfo) => {
    const axes = parseProjectName(testInfo.project.name);
    await use({ ...axes, outputRoot: captureRunDir(), runId: captureRunId() });
  },

  page: async ({ page }, use) => {
    await installRouteMocks(page, false);
    await use(page);
  },

  capture: async ({ page, captureContext }, use, testInfo) => {
    await use(async (entry: StateEntry) => {
      if (entry.auth === "signed-in") {
        // Registered second, so it wins: Playwright matches routes in reverse
        // registration order.
        await installRouteMocks(page, true);
      }
      await captureState(page, entry, captureContext, testInfo);
    });
  },
});

export { expect };
