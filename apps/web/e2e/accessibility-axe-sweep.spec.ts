// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Automated accessibility sweep.
 *
 * Runs axe-core (WCAG 2.0/2.1 level A + AA) over the four screens a first-time
 * visitor actually meets and fails on any `serious` or `critical` violation:
 *
 *   1. /chat on a fresh profile — the setup gate's wait surface;
 *   2. /settings — the models tab and the default tab;
 *   3. /sign-in — the credential form;
 *   4. the below-floor screen, reached through the validation-harness device
 *      override (`?eco-force-capability=unsupported`).
 *
 * `moderate` and `minor` findings are reported in the failure text when a run
 * fails but do not gate on their own: the bar here is "nothing that blocks a
 * screen reader or keyboard user", not a clean-sheet score.
 *
 * Requires the validation harness build flag — the device-override query
 * params are read only when `NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true`, which
 * the playwright.config.ts web server sets.
 */

import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import type { Result as AxeResult } from "axe-core";

/** WCAG 2.1 A + AA, the conformance target for the launch surfaces. */
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

/** Only these impacts gate. See the file header for why. */
const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

// Forced desktop/WebGPU profile so setup never routes below-floor and the
// /chat sweep always lands on the same screen. Mirrors first-run-journey.spec.
const FORCED_DESKTOP_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16"
  + "&eco-force-opfs=true";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
      }),
    }),
  );

  await page.route("**/api/auth/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.route("**/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
});

async function clearStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // storage may be unavailable in some embedded contexts — best effort.
    }
  });
}

/** One violation rendered for a human reading a CI log. */
function describeViolation(violation: AxeResult): string {
  const firstTarget = violation.nodes[0]?.target?.join(" ") ?? "(no target)";
  return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n`
    + `      first target: ${firstTarget}\n`
    + `      docs: ${violation.helpUrl}`;
}

/**
 * Scan the current page and assert no blocking violation. The non-blocking
 * findings ride along in the failure message so one run tells the whole story.
 */
async function expectNoBlockingViolations(page: Page, screen: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags([...WCAG_TAGS])
    .analyze();

  // Non-vacuity: a scan of a blank or unmounted screen also reports zero
  // violations. Every real screen here clears dozens of checks, so a low pass
  // count means the scan looked at nothing and the green is meaningless.
  expect(
    results.passes.length,
    `axe ran no checks on ${screen} — the screen was probably empty`,
  ).toBeGreaterThan(10);

  const blocking = results.violations.filter((v) =>
    BLOCKING_IMPACTS.has(v.impact ?? ""),
  );
  const advisory = results.violations.filter(
    (v) => !BLOCKING_IMPACTS.has(v.impact ?? ""),
  );

  const message = [
    `axe found ${blocking.length} serious/critical violation(s) on ${screen}:`,
    ...blocking.map(describeViolation),
    ...(advisory.length > 0
      ? [
          `\n  also ${advisory.length} non-blocking finding(s):`,
          ...advisory.map(describeViolation),
        ]
      : []),
  ].join("\n");

  expect(blocking, message).toEqual([]);
}

test.describe("axe sweep — WCAG 2.1 A + AA, no serious or critical violations", () => {
  test("/chat on a fresh profile (setup gate)", async ({ page }) => {
    await clearStorage(page);

    // Stall the model proxy so the pipeline holds at the download boundary and
    // the wait surface stays on screen for the scan. Aborting instead would
    // race the fallback cascade into SetupErrorState.
    await page.route("**/api/local-models/**", () => {
      /* intentionally never settle */
    });

    // networkidle can never fire while the proxy hangs — wait on the DOM.
    await page.goto(`/chat?${FORCED_DESKTOP_PROFILE}`, {
      waitUntil: "domcontentloaded",
    });

    await expect(page.locator("[data-eco-setup-surface]")).toBeVisible({
      timeout: 20_000,
    });

    await expectNoBlockingViolations(page, "/chat (setup gate)");
  });

  test("/settings?tab=models", async ({ page }) => {
    await page.goto("/settings?tab=models", { waitUntil: "networkidle" });

    await expect(
      page.getByRole("tablist", { name: "Settings sections" }),
    ).toBeVisible();

    await expectNoBlockingViolations(page, "/settings?tab=models");
  });

  test("/settings default tab", async ({ page }) => {
    await page.goto("/settings", { waitUntil: "networkidle" });

    await expect(
      page.getByRole("tablist", { name: "Settings sections" }),
    ).toBeVisible();

    await expectNoBlockingViolations(page, "/settings (default tab)");
  });

  test("/sign-in", async ({ page }) => {
    // The shared beforeEach mocks a signed-IN session, which sends /sign-in
    // straight to the chat shell. Override it for this test only so the
    // credential form is what gets scanned.
    await page.route("**/api/auth/get-session", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "null" }),
    );

    await page.goto("/sign-in", { waitUntil: "networkidle" });

    await expect(page.getByLabel(/email/i)).toBeVisible();

    await expectNoBlockingViolations(page, "/sign-in");
  });

  test("below-floor screen", async ({ page }) => {
    await clearStorage(page);

    await page.goto("/chat?eco-force-capability=unsupported&eco-force-device-memory=2", {
      waitUntil: "networkidle",
    });

    // BelowFloorScreen copy (src/components/local-ai/BelowFloorScreen.tsx).
    await expect(page.getByText(/can.t do that yet/i)).toBeVisible({
      timeout: 20_000,
    });

    await expectNoBlockingViolations(page, "below-floor screen");

    // The "What works today" disclosure is collapsed by default, so its panel
    // never reaches the scan above. Open it and scan the expanded state too.
    await page.getByRole("button", { name: /What works today/i }).click();
    await expect(page.getByText(/Eco runs today on:/i)).toBeVisible();

    await expectNoBlockingViolations(page, "below-floor screen (disclosure open)");
  });
});
