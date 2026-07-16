// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebKit-mobile designed tier (D1) — gate-before-load proof.
 *
 * The load-bearing guarantee: on iOS WebKit (Safari + mobile) Eco must decline
 * to the designed handoff surface WITHOUT ever attempting a model download or
 * load — because the load itself crash-loops the tab on real iPhones. This spec
 * forces an iOS-WebKit profile and asserts (a) the mobile surface renders and
 * (b) ZERO `/api/local-models/**` requests fire (nothing was load-attempted).
 *
 * Runs in CI only (like the rest of e2e/). iOS WebKit has WebGPU, so the forced
 * profile keeps capability=webgpu — the gate must decline despite that.
 */

import { test, expect, type Page } from "@playwright/test";

const FORCED_IOS_WEBKIT_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=safari"
  + "&eco-force-platform=mobile"
  + "&eco-force-device-memory=4"
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

test.describe("WebKit-mobile designed tier", () => {
  test("iOS WebKit gets the handoff surface and NO model load is attempted", async ({ page }) => {
    await clearStorage(page);

    // Track any hit to the model proxy. The guarantee is that this stays empty —
    // the gate declines before download/load. If the gate regressed to serving,
    // the setup cascade would hit this route and the assertion below would fail.
    const modelRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/local-models/")) modelRequests.push(req.url());
    });
    // Also fail loudly at the network layer if anything tries: abort so a
    // regression can't silently succeed against a live proxy.
    await page.route("**/api/local-models/**", (route) => route.abort());

    await page.goto(`/chat?${FORCED_IOS_WEBKIT_PROFILE}`, {
      waitUntil: "domcontentloaded",
    });

    // The designed mobile surface: heading + phone→computer story + handoff.
    await expect(page.getByRole("heading", { name: "Eco" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByText(/Phones don't have the memory for that yet/i),
    ).toBeVisible();
    await expect(
      page.getByText(/We'll email you when Eco comes to phones\./i),
    ).toBeVisible();
    // Handoff control: native share when available, else the copy-link fallback.
    await expect(
      page.getByRole("button", { name: /send eco to your computer|copy link/i }),
    ).toBeVisible();

    // The chat greeting must NOT appear — the user never reaches a chat surface.
    await expect(
      page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }),
    ).toHaveCount(0);

    // The proof: nothing was ever load-attempted.
    expect(modelRequests).toEqual([]);
  });
});
