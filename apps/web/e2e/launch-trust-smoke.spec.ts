// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Page } from "@playwright/test";
import { authenticatedTest, expect, test } from "./visual/fixtures";

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(
    overflow.scrollWidth,
    `${label} should not create horizontal overflow`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function forceDarkMode(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.classList.add("dark");
  });
  await page.waitForTimeout(250);
}

const PUBLIC_TRUST_PAGES = [
  { path: "/privacy", text: /Privacy Policy/i },
  { path: "/terms", text: /Terms of Service/i },
  { path: "/transparency", text: /Transparency/i },
] as const;

for (const item of PUBLIC_TRUST_PAGES) {
  test(`dark trust page renders without overflow: ${item.path}`, async ({ page }) => {
    await page.goto(item.path, { waitUntil: "networkidle" });
    await forceDarkMode(page);

    await expect(page.getByText(item.text).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, item.path);
  });
}

const MOBILE_APP_SURFACES = [
  { path: "/settings?tab=models", text: /Local AI/i },
  { path: "/settings?tab=support&eco-runtime-diagnostics=true", text: /Local runtime report/i },
  { path: "/chat", text: /Eco chat|Message Eco/i },
] as const;

for (const item of MOBILE_APP_SURFACES) {
  authenticatedTest(`mobile app trust surface stays usable: ${item.path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(item.path, { waitUntil: "networkidle" });

    await expect(page.getByText(item.text).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, item.path);
  });
}
