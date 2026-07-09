// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { authenticatedTest as test, expect } from "./fixtures";

const AUTH_PAGES = [
  { path: "/chat", name: "chat" },
  { path: "/settings", name: "settings" },
] as const;

for (const { path, name } of AUTH_PAGES) {
  test(`${name} page visual (authenticated)`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });

    // Wait for layout to settle
    await page.waitForTimeout(500);

    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}
