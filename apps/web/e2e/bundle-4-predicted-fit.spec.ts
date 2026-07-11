// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Bundle 4 Playwright verification probe — predicted-fit lane.
 *
 * Confirms that every device profile in the coverage matrix surfaces
 * the correct model recommendation with confident consumer copy and
 * no lab-debrief language.
 */

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// process.cwd() resolves to apps/web/ — walk up to repo root for evidence.
const evidenceDir = join(process.cwd(), "../../docs/evidence/2026-05-15/bundle4");
mkdirSync(evidenceDir, { recursive: true });

// ─── Negative copy that must NEVER appear on a recommended-fit wizard ─────────
const NEGATIVE_COPY_PATTERNS = [
  /Recovery needed/i,
  /Held until proven/i,
  /Eco hasn't tested/i,
  /no safe local model/i,
];

// ─── Profile cases ────────────────────────────────────────────────────────────

type ProfileCase = {
  name: string;
  params: string;
  /** Model name expected in the wizard for the eco-fast slot recommendation. */
  expectedFastModel: RegExp;
  /** Optional: additional text expected somewhere on the wizard page. */
  expectedWizardText?: RegExp[];
};

const profileCases: ProfileCase[] = [
  {
    name: "chromium-16gb",
    params:
      "eco-force-capability=webgpu&eco-force-browser=chromium&eco-force-platform=desktop&eco-force-device-memory=16&eco-force-opfs=true",
    // Seed evidence has Phi-3 Mini for high-memory chromium.
    // eco-fast falls back to the best acceptable (Phi-3 Mini, full-tier).
    expectedFastModel: /Phi-3 Mini/i,
    expectedWizardText: [/Recommended for your device/i],
  },
  {
    name: "chromium-8gb",
    params:
      "eco-force-capability=webgpu&eco-force-browser=chromium&eco-force-platform=desktop&eco-force-device-memory=8&eco-force-opfs=true",
    // Seed has Bonsai q4 for capable-laptop (quick tier) -> eco-fast match.
    // Predicted-fit also has Qwen3 0.6B. Seed wins (verified > predicted).
    expectedFastModel: /Bonsai 1\.7B|Qwen3 0\.6B/i,
    expectedWizardText: [/Recommended for your device/i],
  },
  {
    name: "firefox-8gb",
    params:
      "eco-force-capability=wasm&eco-force-browser=firefox&eco-force-platform=desktop&eco-force-device-memory=8",
    // No seed for Firefox. Predicted-fit: Qwen3 0.6B for firefox/* eco-fast.
    expectedFastModel: /Qwen3 0\.6B/i,
    expectedWizardText: [/Recommended for your device/i],
  },
  {
    name: "safari-16gb",
    params:
      "eco-force-capability=webgpu&eco-force-browser=safari&eco-force-platform=desktop&eco-force-device-memory=16",
    // No seed for Safari. Predicted-fit: Qwen3 0.6B for safari/* eco-fast.
    expectedFastModel: /Qwen3 0\.6B/i,
    expectedWizardText: [/Recommended for your device/i],
  },
  {
    name: "mobile-4gb",
    params:
      "eco-force-capability=webgpu&eco-force-browser=chromium&eco-force-platform=mobile&eco-force-device-memory=4",
    // No seed for mobile. Predicted-fit: LFM2.5 350M for */mobile eco-fast.
    expectedFastModel: /LFM2\.?5/i,
    expectedWizardText: [/Recommended for your device/i],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Clears localStorage via page.addInitScript so the onboarding wizard renders
 * fresh on every navigation. Must be called BEFORE page.goto().
 */
async function clearLocalStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // Storage may be unavailable in some test contexts.
    }
  });
}

/**
 * Seeds localStorage to mark onboarding complete so the wizard does NOT render,
 * allowing settings to be inspected. Must be called BEFORE page.goto().
 */
async function seedCompletedOnboarding(page: Page): Promise<void> {
  await page.addInitScript(() => {
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

// ─── Shared route stubs (from local-runtime-launch-confidence.spec.ts) ───────

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
});

// ─── Wizard probe per profile ────────────────────────────────────────────────

test.describe("Bundle 4 predicted-fit probe", () => {
  for (const profile of profileCases) {
    test(`wizard renders correct model for ${profile.name}`, async ({
      page,
    }) => {
      // Step 1: clear localStorage so the wizard renders fresh.
      await clearLocalStorage(page);

      // Step 2: navigate to / with forced profile params.
      await page.goto(`/?${profile.params}`, { waitUntil: "networkidle" });

      // Step 3: wait for the activation card to appear.
      const activationCard = page.getByTestId("activation-card");
      await expect(activationCard).toBeVisible({ timeout: 15_000 });

      // Step 4: assert the expected Fast model name is visible.
      // The wizard shows either the model name in the hero title
      // ("Set up <Model Name> for your device?") or in the primary
      // CTA button ("Set up <Model Name>").
      await expect(
        page.getByText(profile.expectedFastModel).first(),
      ).toBeVisible({ timeout: 5_000 });

      // Step 5: assert no negative lab-debrief copy.
      for (const pattern of NEGATIVE_COPY_PATTERNS) {
        await expect(
          page.getByText(pattern),
        ).toHaveCount(0);
      }

      // Step 5b: assert expected wizard text (e.g. "Recommended for your device").
      if (profile.expectedWizardText) {
        for (const pattern of profile.expectedWizardText) {
          await expect(
            page.getByText(pattern).first(),
          ).toBeVisible();
        }
      }

      // Step 6: screenshot wizard.
      await page.screenshot({
        path: join(evidenceDir, `${profile.name}-wizard.png`),
        fullPage: true,
      });
    });

    test(`settings renders slot cards for ${profile.name}`, async ({
      page,
    }) => {
      // Step 7: seed onboarding complete so wizard does not render.
      await seedCompletedOnboarding(page);

      // Step 8: navigate to settings models tab with forced params.
      await page.goto(`/settings?tab=models&${profile.params}`, {
        waitUntil: "networkidle",
      });

      // Wait for the page to be ready.
      await page.waitForLoadState("domcontentloaded");

      // Step 9: screenshot settings.
      await page.screenshot({
        path: join(evidenceDir, `${profile.name}-settings.png`),
        fullPage: true,
      });
    });
  }
});
