// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Locator, Page } from "@playwright/test";
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

// Each surface names a landmark locator instead of a bare text regex: the
// /chat composer is reachable only by its accessible name ("Message input"),
// not a text node — the old /Eco chat|Message Eco/ regex was matching the
// textarea's placeholder attribute, which getByText does not see.
const MOBILE_APP_SURFACES: ReadonlyArray<{
  path: string;
  locator: (page: Page) => Locator;
}> = [
  {
    path: "/settings?tab=models",
    locator: (page) => page.getByText(/Switch your AI/i).first(),
  },
  {
    path: "/diagnostics/local-ai?eco-diagnostics=1",
    locator: (page) => page.getByText(/Local AI Diagnostics/i).first(),
  },
  {
    path: "/chat",
    locator: (page) => page.getByLabel("Message input"),
  },
] as const;

for (const item of MOBILE_APP_SURFACES) {
  authenticatedTest(`mobile app trust surface stays usable: ${item.path}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(item.path, { waitUntil: "networkidle" });

    await expect(item.locator(page)).toBeVisible();
    await expectNoHorizontalOverflow(page, item.path);
  });
}
