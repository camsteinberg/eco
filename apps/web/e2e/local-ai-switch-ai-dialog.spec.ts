// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Switch your AI dialog — structural E2E (shipped flat-list dialog).
 *
 * The redesigned dialog (SwitchAIDialog.tsx) is one calm "Available AIs"
 * radiogroup ranked by fit — no two-mode "Eco picks / Choose your own"
 * picker, no tier headings, no "Untested — may not work" warning gate.
 * This spec locks that surface:
 *
 *   - The dialog renders a single `radiogroup` named "Available AIs" with
 *     at least one radio row and exactly one "Recommended for your device".
 *   - The now-removed two-mode picker copy is absent everywhere.
 *   - The currently-bound model row is honest ("Currently running").
 *   - Picking another radio enables Save with no confirmation gate.
 *   - Cancel closes without rebinding.
 *
 * Real model smoke success/failure requires WebGPU/WASM which is not
 * available in headless CI Chromium — that integration is verified via the
 * manual Playwright MCP merge gate. Here the eco-fast slot is primed 'ready'
 * with no cache bytes; `eco-force-cache-verified=1` stops boot reconcile from
 * flipping it back to 'preparing' so the current row reads "Currently
 * running" rather than "Setting up…".
 *
 * Note on model naming: the seeded slot model `local/qwen3-0.6b`
 * surfaces through the display layer (src/local-ai/display.ts) as its branded
 * friendly name "Eco Compact (Qwen)", NOT the raw "Qwen3" — the
 * primary UI never shows raw model names. Assertions use the shipped branded
 * name.
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

/** Forced WebGPU desktop profile so the runnable list is deterministic. */
const FORCED_DESKTOP_PROFILE =
  'eco-force-capability=webgpu'
  + '&eco-force-browser=chromium'
  + '&eco-force-platform=desktop'
  + '&eco-force-device-memory=16';

/** The branded friendly name the seeded slot model displays as. */
const CURRENT_MODEL_NAME = /Eco Compact/i;

async function seedReadySlot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('eco-local-ai-slot-eco-fast', 'local/qwen3-0.6b');
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
  await page.goto(
    `/settings?tab=models&eco-force-cache-verified=1&${FORCED_DESKTOP_PROFILE}`,
    { waitUntil: 'networkidle' },
  );
  await page.getByRole('button', { name: 'Open Switch your AI dialog' }).click();
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe('Switch your AI dialog structure', () => {
  test('renders one flat confident list with a single Recommended tag', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);

    const dialog = page.getByRole('dialog');
    const list = dialog.getByRole('radiogroup', { name: 'Available AIs' });
    await expect(list).toBeVisible();
    await expect(dialog.getByRole('radio').first()).toBeVisible();

    // Exactly one entry carries the "Recommended for your device" sublabel.
    await expect(dialog.getByText(/Recommended for your device/i)).toHaveCount(1);

    // The removed two-mode picker + untested-warning copy is gone everywhere.
    await expect(page.getByText(/eco picks \(recommended\)/i)).toHaveCount(0);
    await expect(page.getByText(/choose your own/i)).toHaveCount(0);
    await expect(page.getByText(/untested for your device/i)).toHaveCount(0);
    await expect(page.getByText(/may not work/i)).toHaveCount(0);
  });

  test('the current model row is honest about what is running', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(CURRENT_MODEL_NAME).first()).toBeVisible();
    await expect(dialog.getByText(/Currently running/i)).toBeVisible();
  });

  test('picking another AI enables Save with no confirmation gate', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);

    const dialog = page.getByRole('dialog');
    // The current model row is pre-selected; pick a different, unchecked row.
    // Resolve to a positional index first — a `{ checked: false }` locator would
    // re-point at the next unchecked row the moment this one becomes checked.
    const radios = dialog.getByRole('radio');
    const count = await radios.count();
    let targetIndex = -1;
    for (let i = 0; i < count; i += 1) {
      if (!(await radios.nth(i).isChecked())) {
        targetIndex = i;
        break;
      }
    }
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    const otherRow = radios.nth(targetIndex);
    await otherRow.click();
    await expect(otherRow).toBeChecked();

    await expect(dialog.getByRole('button', { name: /^save$/i })).toBeEnabled();
    // No "Yes, switch" confirmation step exists in the redesigned flow.
    await expect(page.getByRole('button', { name: /yes, switch/i })).toHaveCount(0);
  });

  test('Cancel closes the dialog without rebinding', async ({ page }) => {
    await seedReadySlot(page);
    await openSwitchAIDialog(page);

    await page.getByRole('dialog').getByRole('button', { name: /^cancel$/i }).click();
    await expect(page.getByRole('dialog')).toBeHidden();

    // Re-open to confirm the current model is unchanged.
    await page.getByRole('button', { name: 'Open Switch your AI dialog' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(CURRENT_MODEL_NAME).first()).toBeVisible();
    await expect(dialog.getByText(/Currently running/i)).toBeVisible();
  });
});
