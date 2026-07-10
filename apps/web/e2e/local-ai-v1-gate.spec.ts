// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * v1.0 local-AI gate E2E verification.
 *
 * Confirms the LocalAiSetupGate mount, legacy OnboardingWizard suppression,
 * and below-floor surface behaviour with seeded localStorage state — no real
 * model backend or /api/local-models proxy required.
 */

import { test, expect, type Page } from "@playwright/test";

// ─── Auth + API route stubs (reused from bundle-4-predicted-fit.spec.ts) ────

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
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  await page.route("**/v1/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
  // Block model downloads so bootstrap's self-heal + reconciliation can't
  // produce unintended side-effects from real network responses.
  await page.route("**/api/local-models/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "{}",
    }),
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Seeds localStorage so the v1.0 eco-fast slot is marked 'ready' with a real
 * catalog model, and onboarding is complete. Also opts into the v1 feature
 * flag via localStorage so sessionStorage stickiness is guaranteed even
 * after navigations within the same test.
 *
 * Must be called BEFORE page.goto().
 */
async function seedReadySlot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // v1 feature flag (persistent opt-in).
    window.localStorage.setItem("eco-local-ai-v1", "on");

    // eco-fast slot: Phi-3 Mini is in the v1.0 catalog (catalog-data.json).
    window.localStorage.setItem(
      "eco-local-ai-slot-eco-fast",
      "local/phi3-mini-4k-q4f16",
    );
    window.localStorage.setItem("eco-local-ai-slot-status-eco-fast", "ready");

    // Mark legacy onboarding as complete so ChatPageInner renders
    // ChatWorkspace (where the actual chat surface lives) rather than
    // FirstRunChatBackdrop.
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

    // Skip service-worker registration noise.
    window.sessionStorage.setItem("eco-skip-sw-registration-once", "true");
  });
}

/**
 * Seeds localStorage for the legacy (v1 off) path: onboarding NOT complete,
 * no v1 flag. Clears sessionStorage so no sticky session opt-in persists.
 *
 * Must be called BEFORE page.goto().
 */
async function seedLegacyPath(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // Storage unavailable in restricted contexts.
    }
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("v1.0 local-AI gate", () => {
  test("ready-slot passthrough renders chat surface", async ({ page }) => {
    await seedReadySlot(page);

    // Slot is primed 'ready' with no cache bytes — mark the cache verified so
    // boot reconcile leaves it 'ready' and the gate passes through to chat.
    await page.goto("/chat?local-ai-v1=1&eco-force-cache-verified=1", { waitUntil: "networkidle" });

    // The chat surface's empty state heading should be visible.
    await expect(
      page.getByRole("heading", { name: /Good (morning|afternoon|evening)/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The WelcomeSetup heading ("Eco" with subtitle "Your private AI")
    // should NOT be present — the gate passed through to children.
    await expect(
      page.getByText(/Your private AI, on your device/i),
    ).toHaveCount(0);
  });

  test("legacy OnboardingWizard suppressed when v1 on", async ({ page }) => {
    await seedReadySlot(page);

    // Slot is primed 'ready' with no cache bytes — mark the cache verified so
    // boot reconcile leaves it 'ready' and the gate passes through to chat.
    await page.goto("/chat?local-ai-v1=1&eco-force-cache-verified=1", { waitUntil: "networkidle" });

    // Chat surface present.
    await expect(
      page.getByRole("heading", { name: /Good (morning|afternoon|evening)/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The legacy OnboardingWizard renders a dialog with
    // data-testid="onboarding-wizard". It must NOT be in the DOM.
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  });

  test("legacy path intact with ?local-ai-v1=0", async ({ page }) => {
    await seedLegacyPath(page);

    await page.goto("/chat?local-ai-v1=0", { waitUntil: "networkidle" });

    // The v1 gate's WelcomeSetup subtitle must NOT be present — v1 is off.
    await expect(
      page.getByText(/Your private AI, on your device/i),
    ).toHaveCount(0);

    // The legacy OnboardingWizard SHOULD be present — it renders as a
    // dialog with data-testid="onboarding-wizard" in the first-run
    // backdrop or the embedded overlay.
    await expect(
      page.getByTestId("onboarding-wizard"),
    ).toBeVisible({ timeout: 15_000 });

    // The activation card inside the wizard should be there too.
    await expect(page.getByTestId("activation-card")).toBeVisible();
  });

  test("below-floor surface renders when v1 on and device unsupported", async ({
    page,
  }) => {
    // Seed v1 ON but do NOT seed a ready slot. The gate's useLocalAiSetup
    // will run isBelowFloor() against the forced device profile.
    await page.addInitScript(() => {
      window.localStorage.setItem("eco-local-ai-v1", "on");
      // Mark legacy onboarding complete so we reach GatedChatPage's
      // LocalAiSetupGate rather than FirstRunChatBackdrop.
      window.localStorage.setItem(
        "eco-onboarding",
        JSON.stringify({
          state: {
            hasCompletedOnboarding: true,
            step: "complete",
            hardwareCapability: "unsupported",
            deviceMemoryGB: 2,
            recommendedModelId: null,
          },
          version: 1,
        }),
      );
      window.localStorage.setItem("eco-home-entry-dismissed", "true");
      window.localStorage.setItem("eco-tour-completed", "true");
      window.sessionStorage.setItem("eco-skip-sw-registration-once", "true");
    });

    // Force device profile to below-floor: capability=unsupported (webgpuSupport='none')
    // + device-memory=2 (≤ 4 GB threshold in below-floor.ts).
    await page.goto(
      "/chat?local-ai-v1=1&eco-force-capability=unsupported&eco-force-device-memory=2",
      { waitUntil: "networkidle" },
    );

    // BelowFloorScreen renders a heading "Eco" and body text containing
    // "doesn't fully support that yet". Use the unique body copy as the
    // stable selector — the heading "Eco" is too generic.
    await expect(
      page.getByText(/doesn.t fully support that yet/i),
    ).toBeVisible({ timeout: 15_000 });

    // The signup prompt should also be present.
    await expect(
      page.getByText(/We.ll email you when Eco arrives/i),
    ).toBeVisible();

    // Chat surface must NOT be rendered behind the gate.
    await expect(
      page.getByRole("heading", { name: /Good (morning|afternoon|evening)/i }),
    ).toHaveCount(0);
  });
});
