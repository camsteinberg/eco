// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test, expect } from "./fixtures";

const PUBLIC_PAGES = [
  { path: "/", name: "landing" },
  { path: "/sign-in", name: "sign-in" },
  { path: "/sign-up", name: "sign-up" },
  { path: "/impact", name: "impact" },
] as const;

for (const { path, name } of PUBLIC_PAGES) {
  test(`${name} page visual`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });

    // Wait for fonts and images to settle
    await page.waitForTimeout(500);

    // For the landing page, disable remaining CSS animations that Playwright's
    // animations: "disabled" might not catch (parallax, pulse, counters)
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

    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}
