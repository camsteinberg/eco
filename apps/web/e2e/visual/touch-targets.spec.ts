// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Page } from "@playwright/test";
import { authenticatedTest, test, expect } from "./fixtures";

const MOBILE_VIEWPORT = { width: 375, height: 667 };
const MIN_TARGET_SIZE = 44;

// Launch pages to audit for touch target compliance. Inline prose/footer links
// remain exempt below under the WCAG 2.5.8 text-link exception; primary CTAs,
// icon buttons, form controls, cards, nav, and app-shell actions must be 44px+.
const PUBLIC_PAGES_TO_CHECK = [
  "/",
  "/sign-up",
  "/privacy",
  "/terms",
  "/transparency",
  "/impact",
];
const APP_PAGES_TO_CHECK = ["/chat", "/settings"];

async function collectTouchTargetViolations(page: Page) {
  return page.evaluate((minSize) => {
    const interactive = document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"]'
    );
    const results: Array<{
      selector: string;
      width: number;
      height: number;
    }> = [];

    interactive.forEach((el) => {
      const rect = el.getBoundingClientRect();
      // Skip hidden/zero-size elements
      if (rect.width === 0 || rect.height === 0) return;
      // Skip elements outside viewport
      if (rect.top > window.innerHeight || rect.bottom < 0) return;
      // Exempt inline text links within paragraphs/lists/tables (WCAG 2.5.8 exception)
      if (el.tagName === "A" && el.closest("p, li, span, td")) return;
      // Exempt hidden file inputs
      if (
        el.tagName === "INPUT" &&
        (el as HTMLInputElement).type === "file" &&
        el.getAttribute("aria-hidden") === "true"
      )
        return;

      if (rect.width < minSize || rect.height < minSize) {
        const label =
          el.getAttribute("aria-label") ??
          el.textContent?.trim().slice(0, 30) ??
          "";
        results.push({
          selector: `${el.tagName.toLowerCase()}${label ? `[${label}]` : ""}`,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    });
    return results;
  }, MIN_TARGET_SIZE);
}

for (const pagePath of PUBLIC_PAGES_TO_CHECK) {
  test(`all public interactive elements meet ${MIN_TARGET_SIZE}px touch target on ${pagePath}`, async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const violations = await collectTouchTargetViolations(page);

    expect(violations, `Touch target violations on ${pagePath}`).toEqual([]);
  });
}

for (const pagePath of APP_PAGES_TO_CHECK) {
  authenticatedTest(`all app interactive elements meet ${MIN_TARGET_SIZE}px touch target on ${pagePath}`, async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const violations = await collectTouchTargetViolations(page);

    expect(violations, `Touch target violations on ${pagePath}`).toEqual([]);
  });
}
