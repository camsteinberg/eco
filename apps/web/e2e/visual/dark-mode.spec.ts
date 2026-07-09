// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test, authenticatedTest, expect } from "./fixtures";

/**
 * Dark mode visual regression tests.
 *
 * Desktop-only — dark mode is about color tokens, not responsive layout
 * (Phase 17 already covers responsive). Each test injects the `.dark` class
 * on <html> before taking a screenshot.
 */

const PUBLIC_PAGES = [
  { path: "/", name: "landing" },
  { path: "/sign-in", name: "sign-in" },
  { path: "/impact", name: "impact" },
] as const;

const AUTHENTICATED_PAGES = [
  { path: "/chat", name: "chat" },
  { path: "/settings", name: "settings" },
] as const;

for (const { path, name } of PUBLIC_PAGES) {
  test(`dark ${name} page visual`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });

    // Inject dark mode
    await page.evaluate(() =>
      document.documentElement.classList.add("dark")
    );

    // Wait for CSS transitions to settle
    await page.waitForTimeout(500);

    // Disable remaining CSS animations on landing page
    if (name === "landing") {
      await page.evaluate(() => {
        document
          .querySelectorAll(
            '[data-parallax], .animate-pulse, [class*="animate"]'
          )
          .forEach((el) => {
            (el as HTMLElement).style.animation = "none";
            (el as HTMLElement).style.transition = "none";
          });
      });
    }

    await expect(page).toHaveScreenshot(`dark-${name}.png`, {
      fullPage: true,
    });
  });
}

for (const { path, name } of AUTHENTICATED_PAGES) {
  authenticatedTest(
    `dark ${name} page visual`,
    async ({ page }) => {
      await page.goto(path, { waitUntil: "networkidle" });

      // Inject dark mode
      await page.evaluate(() =>
        document.documentElement.classList.add("dark")
      );

      // Wait for CSS transitions to settle
      await page.waitForTimeout(500);

      await expect(page).toHaveScreenshot(`dark-${name}.png`, {
        fullPage: true,
      });
    }
  );
}
