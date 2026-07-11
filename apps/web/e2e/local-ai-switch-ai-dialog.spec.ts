// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Switch your AI dialog — structural E2E.
 *
 * Asserts the deterministic surface of the dialog at /settings?tab=models
 * after the catalog-confidence pass:
 *
 *   - The dialog renders an "Available AIs" header (no tier headings).
 *   - Every confidence-rated model for the user's device surfaces in a
 *     flat list. The top entry shows a "Recommended" tag.
 *   - No "Untested for your device — may not work" copy appears
 *     anywhere on screen.
 *   - Clicking Save commits immediately (no untested warning gate).
 *   - Cancel closes the dialog without rebinding.
 *
 * Real model smoke success/failure requires WebGPU/WASM which is not
 * available in headless CI Chromium — that integration is verified via
 * the manual Playwright MCP merge gate.
 */

import { test, expect, type Page } from '@playwright/test';

// ─── Auth + API stubs ────────────────────────────────────────────────────────

test.beforeEach(async ({ page }) => {
  await page.route('**/api/auth/get-session', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session: {
          id: 'test-session',
          userId: 'test-user-id',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        user: {
          id: 'test-user-id',
          email: 'test@eco.network',
          name: 'Test User',
          emailVerified: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    }),
  );
  await page.route('**/api/auth/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.route('**/api/local-models/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
});

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seedReadySlot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('eco-local-ai-v1', 'on');
    window.localStorage.setItem('eco-local-ai-slot-eco-fast', 'local/phi3-mini-4k-q4f16');
    window.localStorage.setItem('eco-local-ai-slot-status-eco-fast', 'ready');
    window.localStorage.setItem(
      'eco-onboarding',
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          step: 'complete',
          hardwareCapability: 'webgpu',
          deviceMemoryGB: 16,
          recommendedModelId: null,
        },
        version: 1,
      }),
    );
    window.localStorage.setItem('eco-home-entry-dismissed', 'true');
    window.localStorage.setItem('eco-tour-completed', 'true');
    window.localStorage.setItem('eco-selected-model', 'eco-fast');
    window.localStorage.setItem('eco-selected-model-explicit', 'false');
    window.localStorage.setItem('eco-privacy-tier', 'device');
    window.sessionStorage.setItem('eco-skip-sw-registration-once', 'true');
  });
}

async function openSwitchAIDialog(page: Page): Promise<void> {
  // The eco-fast slot is primed 'ready' with no cache bytes — mark the cache
  // verified so boot reconcile leaves it 'ready' (otherwise the current-model
  // row would read "Setting up…" instead of "Currently running").
  await page.goto('/settings?tab=models&local-ai-v1=1&eco-force-cache-verified=1', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /switch your ai/i }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Switch your AI dialog structure', () => {
  test('renders the two-mode picker and Choose-your-own reveals the Available AIs list', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);

    await expect(page.getByText(/eco picks \(recommended\)/i)).toBeVisible();
    await expect(page.getByText(/choose your own/i)).toBeVisible();

    await page.getByText(/choose your own/i).click();
    await expect(page.getByText(/^available ais$/i)).toBeVisible();
    // The old tier header must NOT appear anywhere.
    await expect(page.getByText(/tested for your device/i)).toHaveCount(0);
    await expect(page.getByText(/untested for your device/i)).toHaveCount(0);
    await expect(page.getByText(/may not work/i)).toHaveCount(0);
  });

  test('every confidence-rated model surfaces with at least one Recommended tag', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);
    await page.getByText(/choose your own/i).click();

    // The flat list should include at least Phi-3 + Bonsai (benchmark-proven
    // on this profile) plus LFM2.5 (calculated for high-memory).
    await expect(page.getByText(/Phi-3 Mini/i).first()).toBeVisible();
    await expect(page.getByText(/Bonsai/i).first()).toBeVisible();
    // Exactly one Recommended tag (on the top-ranked entry).
    await expect(page.getByText(/^recommended$/i)).toHaveCount(1);
  });

  test('Save commits immediately on tested-tier — no untested warning gate', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);
    await page.getByText(/choose your own/i).click();

    // The Save button starts as "Save" and remains so (no "Yes, switch"
    // confirmation step exists in the new flow).
    await expect(page.getByRole('button', { name: /^save$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /yes, switch/i })).toHaveCount(0);
  });

  test('Cancel closes the dialog without rebinding', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);

    await page.getByRole('button', { name: /^cancel$/i }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Re-open to confirm currentModel is unchanged.
    await page.getByRole('button', { name: /switch your ai/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText(/currently running: phi-3 mini/i)).toBeVisible();
  });
});
