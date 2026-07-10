// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Crash-resilience E2E — proves Eco's error boundaries degrade honestly and
 * recover (no white screen) when on-device AI or the model download fails.
 *
 * Two failure surfaces are exercised:
 *
 *   1. On-device inference crash — the validation harness forces a runtime
 *      crash (`?eco-force-local-runtime=crash`, wired through
 *      `shouldForceValidationRuntimeCrash()` in `ValidationHarnessCrashSentinel`
 *      / `LocalInferenceErrorBoundary`). The boundary must show an honest,
 *      non-alarming message with a working retry, and the app must stay framed.
 *
 *   2. First-run model-setup failure — the setup pipeline runs to an honest
 *      error surface (`SetupErrorState`). Two meaningfully-different variants:
 *        a. storage shortage — a distinct "needs more free space" copy, forced
 *           deterministically (and network-free) by shrinking the storage
 *           headroom estimate below the model size so the download preflight
 *           declines up-front.
 *        b. ladder exhausted — the generic "we tried a few options" copy,
 *           forced by making every model download fail (proxy aborted) so the
 *           fallback cascade runs to exhaustion.
 *
 * Both setup-failure variants are driven deterministically — the storage-estimate
 * override (2a) and the aborted model proxy (2b) — with no reliance on a URL
 * harness seam, so the failures are real render-path failures, not injected state.
 */

import { test, expect, type Page } from "@playwright/test";

// ─── Auth + API route stubs (mirrors local-ai-v1-gate.spec.ts) ──────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Forced device profile (WebGPU desktop) so setup never routes below-floor. */
const FORCED_DEVICE_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16";

/**
 * Seeds a ready eco-fast slot + completed onboarding so `LocalAiSetupGate`
 * passes straight through to `ChatWorkspace` — the tree where
 * `LocalInferenceErrorBoundary` (and its crash sentinel) is mounted.
 * Must be called BEFORE page.goto().
 */
async function seedReadySlot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("eco-local-ai-v1", "on");
    // Phi-3 Mini is in the v1.0 catalog (catalog-data.json).
    window.localStorage.setItem(
      "eco-local-ai-slot-eco-fast",
      "local/phi3-mini-4k-q4f16",
    );
    window.localStorage.setItem("eco-local-ai-slot-status-eco-fast", "ready");
    window.localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          step: "complete",
          hardwareCapability: "webgpu",
          deviceMemoryGB: 16,
          recommendedModelId: null,
        },
        version: 1,
      }),
    );
    window.localStorage.setItem("eco-home-entry-dismissed", "true");
    window.localStorage.setItem("eco-tour-completed", "true");
    window.localStorage.setItem("eco-discovery-model-selector", "true");
    window.localStorage.setItem("eco-discovery-keyboard-shortcuts", "true");
    window.localStorage.setItem("eco-selected-model", "eco-fast");
    window.localStorage.setItem("eco-selected-model-explicit", "false");
    window.localStorage.setItem("eco-privacy-tier", "device");
    window.localStorage.setItem("eco-privacy-tier-explicit", "false");
    window.sessionStorage.setItem("eco-skip-sw-registration-once", "true");
  });
}

/**
 * Seeds completed onboarding but NO ready slot, so `LocalAiSetupGate` runs the
 * first-run setup pipeline (which fails into `SetupErrorState` here). Must be
 * called BEFORE page.goto().
 */
async function seedFreshNoSlot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("eco-local-ai-v1", "on");
    window.localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          step: "complete",
          hardwareCapability: "webgpu",
          deviceMemoryGB: 16,
          recommendedModelId: null,
        },
        version: 1,
      }),
    );
    window.localStorage.setItem("eco-home-entry-dismissed", "true");
    window.localStorage.setItem("eco-tour-completed", "true");
    window.sessionStorage.setItem("eco-skip-sw-registration-once", "true");
  });
}

/**
 * Shrinks the storage-headroom estimate below any model size so the download
 * preflight (`assertStorageHeadroom`) declines up-front with
 * `InsufficientStorageError` — no network fetch, fully deterministic.
 * Must be called BEFORE page.goto().
 */
async function forceTinyStorageQuota(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nav = navigator as unknown as {
      storage?: { estimate?: () => Promise<{ usage: number; quota: number }> };
    };
    if (nav.storage) {
      nav.storage.estimate = () => Promise.resolve({ usage: 0, quota: 1000 });
    }
  });
}

/** The sidebar "New chat" control — proof the app shell is still framed. */
function appShell(page: Page) {
  return page.getByRole("button", { name: "New chat" }).first();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("crash resilience", () => {
  test("on-device inference crash shows an honest boundary and recovers", async ({
    page,
  }) => {
    await seedReadySlot(page);

    await page.goto(
      // Slot is primed 'ready' with no cache bytes — mark the cache verified so
      // boot reconcile leaves it 'ready' and the gate passes through to the
      // ChatWorkspace tree where the crash boundary is mounted.
      `/chat?local-ai-v1=1&eco-force-local-runtime=crash&eco-force-cache-verified=1&${FORCED_DEVICE_PROFILE}`,
      { waitUntil: "networkidle" },
    );

    // Honest, non-alarming boundary copy (LocalInferenceErrorBoundary).
    await expect(
      page.getByText(/On-device AI ran into a problem/i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/Your conversation is safe/i),
    ).toBeVisible();

    // Still framed — the app shell rendered around the boundary (no white screen).
    await expect(appShell(page)).toBeVisible();

    // The retry affordance exists.
    const retry = page.getByRole("button", { name: /Try on-device again/i });
    await expect(retry).toBeVisible();

    // Recovery: once the forced-crash seam is cleared, retry dismisses the
    // boundary and the chat surface returns (the sentinel no longer re-crashes).
    await page.evaluate(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("eco-force-local-runtime");
      window.history.replaceState({}, "", url.toString());
    });
    await retry.click();

    await expect(
      page.getByRole("heading", { name: /How can I help today/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/On-device AI ran into a problem/i),
    ).toHaveCount(0);
  });

  test("setup storage shortage shows an honest 'needs more space' error", async ({
    page,
  }) => {
    await seedFreshNoSlot(page);
    await forceTinyStorageQuota(page);
    // Belt-and-suspenders: even if the preflight is bypassed, the download
    // cannot succeed. (The preflight declines before this is ever hit.)
    await page.route("**/api/local-models/**", (route) => route.abort());

    await page.goto(
      `/chat?local-ai-v1=1&${FORCED_DEVICE_PROFILE}`,
      { waitUntil: "domcontentloaded" },
    );

    // SetupErrorState — storage-shortage variant. Distinct, actionable copy:
    // the fix is freeing space, not "try again later".
    await expect(
      page.getByText(/needs a little more free space/i),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Free up some space and try again/i)).toBeVisible();

    // Still framed (no white screen).
    await expect(appShell(page)).toBeVisible();

    // Recovery affordances are present and actionable.
    await expect(
      page.getByRole("button", { name: /Try setting up Eco again/i }),
    ).toBeVisible();
    await expect(page.getByText(/Copy what happened/i)).toBeVisible();
  });

  test("setup ladder exhaustion shows an honest 'tried a few options' error", async ({
    page,
  }) => {
    await seedFreshNoSlot(page);
    // Every model download fails, so the fallback cascade runs to exhaustion.
    await page.route("**/api/local-models/**", (route) => route.abort());

    await page.goto(
      `/chat?local-ai-v1=1&${FORCED_DEVICE_PROFILE}`,
      { waitUntil: "domcontentloaded" },
    );

    // SetupErrorState — exhausted variant. Honest: it does NOT over-promise a
    // quick retry will fix it, and points at the copy-and-send path.
    await expect(
      page.getByText(/couldn.t get one running on this device just yet/i),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/copy what happened and send it to us/i),
    ).toBeVisible();

    // Still framed (no white screen).
    await expect(appShell(page)).toBeVisible();

    // A recovery affordance is still offered.
    await expect(
      page.getByRole("button", { name: /Try setting up Eco again/i }),
    ).toBeVisible();
  });
});
