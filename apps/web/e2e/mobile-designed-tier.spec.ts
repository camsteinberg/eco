// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebKit-mobile designed tier — post-#56 truth.
 *
 * PR #28 shipped mobile as a designed tier: iOS WebKit declined before ever
 * attempting a model load, because the load itself crash-loops the tab on real
 * iPhones. PR #56 narrowed that guarantee: iOS WebKit **with WebGPU** now
 * enters the WebLLM lane (`candidate/qwen2.5-0.5b-mlc` is whitelisted in
 * `WEBKIT_MOBILE_VALIDATED_MODEL_IDS`, device/compatibility.ts), while every
 * other iOS profile still gets the designed handoff surface with ZERO load
 * attempts.
 *
 * Two guarantees, one spec:
 *  1. iOS WebKit + WebGPU engages the setup lane (model acquisition begins);
 *  2. iOS WebKit without WebGPU declines gate-before-load — no model traffic.
 *
 * The real WebLLM download/generation journey is NOT tested here (no WebGPU in
 * headless CI Chromium) — that lives in e2e-webllm/webllm-lane.spec.ts.
 */

import { test, expect, type Page } from "@playwright/test";

const IOS_WEBGPU_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=safari"
  + "&eco-force-platform=mobile"
  + "&eco-force-device-memory=4"
  + "&eco-force-opfs=true";

// Same device, no WebGPU: the MLC model's requireWebgpu gate fails and the
// blanket iOS pre-load decline covers everything else.
const IOS_NO_WEBGPU_PROFILE =
  "eco-force-capability=wasm"
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

const greetingHeading = (page: Page) =>
  page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ });

test.describe("WebKit-mobile designed tier", () => {
  test("iOS WebKit with WebGPU enters the WebLLM setup lane", async ({ page }) => {
    await clearStorage(page);

    // Track model-proxy traffic — the new guarantee is that it DOES begin.
    const modelRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/local-models/")) modelRequests.push(req.url());
    });
    // Hold (never settle) the proxy so the funnel parks on the wait surface:
    // aborting instead would race the fallback cascade into SetupErrorState.
    await page.route("**/api/local-models/**", () => {
      /* intentionally never settle */
    });

    await page.goto(`/chat?${IOS_WEBGPU_PROFILE}`, {
      waitUntil: "domcontentloaded",
    });

    // The setup wait surface — not the decline handoff.
    await expect(page.locator("[data-eco-setup-surface]")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page.getByRole("progressbar", { name: "Setup progress" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Phones don't have the memory for that yet/i),
    ).toHaveCount(0);

    // Model acquisition genuinely started.
    await expect
      .poll(() => modelRequests.length, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Still in setup — no chat surface yet.
    await expect(greetingHeading(page)).toHaveCount(0);
  });

  test("iOS WebKit without WebGPU declines gate-before-load — zero model traffic", async ({ page }) => {
    await clearStorage(page);

    const modelRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/local-models/")) modelRequests.push(req.url());
    });
    // Fail loudly at the network layer if anything tries: abort so a
    // regression can't silently succeed against a live proxy.
    await page.route("**/api/local-models/**", (route) => route.abort());

    await page.goto(`/chat?${IOS_NO_WEBGPU_PROFILE}`, {
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
    await expect(
      page.getByRole("button", { name: /send eco to your computer|copy link/i }),
    ).toBeVisible();

    // The user never reaches a chat surface…
    await expect(greetingHeading(page)).toHaveCount(0);
    // …and nothing was ever load-attempted.
    expect(modelRequests).toEqual([]);
  });
});
