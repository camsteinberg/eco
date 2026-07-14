// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test, expect } from "@playwright/test";

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

test("settings tabs are keyboard-operable and honor reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.goto("/settings?tab=models", { waitUntil: "networkidle" });

  const tablist = page.getByRole("tablist", { name: "Settings sections" });
  await expect(tablist).toBeVisible();

  const modelsTab = page.getByRole("tab", { name: "Eco" });
  await expect(modelsTab).toHaveAttribute("aria-selected", "true");
  await expect(modelsTab).toHaveAttribute("aria-controls", "settings-panel-models");
  await expect(page.getByRole("tabpanel", { name: "Eco" })).toBeVisible();

  await modelsTab.focus();
  await page.keyboard.press("ArrowRight");

  const appearanceTab = page.getByRole("tab", { name: "Appearance" });
  await expect(appearanceTab).toBeFocused();
  await expect(appearanceTab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/\/settings\?tab=appearance$/);
  await expect(page.getByRole("tabpanel", { name: "Appearance" })).toBeVisible();

  const reducedMotionState = await page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]');
    return {
      matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationName: panel ? getComputedStyle(panel).animationName : "",
    };
  });

  expect(reducedMotionState).toEqual({
    matches: true,
    animationName: "none",
  });
});
