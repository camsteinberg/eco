// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * First-run journey tripwire.
 *
 * The one spec that would have caught the whole class of drift the K10 repair
 * cleaned up: the functional E2E suite rotted precisely where nothing exercised
 * the shipped first-touch journey end to end. This walks it — gate → Stage A
 * wait surface → ready → greeting → generation — against the real
 * `LocalAiSetupGate` state machine.
 *
 * Honesty note: `runSmoke` (the real cold-load quality gate) has NO harness
 * seam, and WebGPU/WASM inference is unavailable in headless CI Chromium. Test
 * 2 therefore proves the gate→ready→greeting→generation WIRING via the local
 * generation fixture — not a literal download + smoke. The literal path is
 * covered by the manual Playwright MCP merge gate.
 *
 * Doctrine: any test priming a ready slot without real cache bytes MUST set
 * `eco-force-cache-verified=1`, or boot reconcile flips the slot to 'preparing'.
 */

import { test, expect, type Page } from "@playwright/test";

// Forced WebGPU desktop profile so setup never routes below-floor and the
// download/ready path is deterministic. `eco-force-opfs=true` keeps storage
// probing off the real OPFS backend.
const FORCED_DESKTOP_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16"
  + "&eco-force-opfs=true";

// ─── Auth + API stubs (session only; NOT the model proxy) ───────────────────

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

// ─── Tests ───────────────────────────────────────────────────────────────────

test.describe("first-run journey", () => {
  test("fresh profile lands on the Stage A wait surface", async ({ page }) => {
    await clearStorage(page);
    // Stall the model proxy (manifest + weights): never fulfill so the setup
    // pipeline holds at the download boundary showing the wait surface.
    // Aborting instead would race the fallback cascade into SetupErrorState.
    await page.route("**/api/local-models/**", () => {
      /* intentionally never settle */
    });

    // networkidle can never fire while the proxy hangs — wait on the DOM.
    await page.goto(`/chat?${FORCED_DESKTOP_PROFILE}`, {
      waitUntil: "domcontentloaded",
    });

    const surface = page.locator("[data-eco-setup-surface]");
    await expect(surface).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText("Your private AI, on your device."),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", { name: "Setup progress" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Getting your private AI ready|Finding the best fit|Finishing your model download/,
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "What makes Eco different" }),
    ).toBeVisible();

    // The user is still in setup — no chat greeting yet.
    await expect(greetingHeading(page)).toHaveCount(0);
  });

  test("gate → ready → greeting → local generation, seeded entirely via URL", async ({ page }) => {
    await clearStorage(page);

    // Every piece of state rides on the URL through the validation harness —
    // no localStorage seeding. A ready eco-fast slot (cache-verified so boot
    // reconcile leaves it 'ready'), an explicit eco-fast selection, and the
    // local generation fixture bound to the same slot + model.
    const search =
      "eco-validation-slot-eco-fast=local/qwen3-0.6b"
      + "&eco-validation-slot-status-eco-fast=ready"
      + "&eco-force-cache-verified=1"
      + "&eco-validation-selected-model=eco-fast"
      + "&eco-local-generation-fixture=smoke-ready"
      + "&eco-local-generation-model=local/qwen3-0.6b"
      + "&eco-local-generation-slot=eco-fast"
      + `&${FORCED_DESKTOP_PROFILE}`;

    await page.goto(`/chat?${search}`, { waitUntil: "networkidle" });

    // Slot is already ready → gate passes straight through to the greeting.
    await expect(greetingHeading(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("[data-eco-setup-surface]")).toHaveCount(0);

    // Drive a real turn through the browser-local fixture path.
    await page.getByLabel("Message input").fill("Hello Eco, first-run journey.");
    await page.getByRole("button", { name: "Send message" }).click();

    // Assert the fixture output — scoped to the message log, never a broad
    // body-text regex. Fixture strings verified in lib/validation-harness.ts
    // (getValidationLocalGenerationFixture chunks).
    const log = page.getByRole("log", { name: /chat messages/i });
    await expect(log.getByText(/local\/fixture response/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(log.getByText(/Fixture complete/i)).toBeVisible();
  });

  test("below-floor device sees the honest not-yet-supported screen", async ({ page }) => {
    await clearStorage(page);

    await page.goto(
      "/chat?eco-force-capability=unsupported&eco-force-device-memory=2",
      { waitUntil: "networkidle" },
    );

    // BelowFloorScreen copy (src/components/local-ai/BelowFloorScreen.tsx).
    await expect(
      page.getByText(/can.t do that yet/i),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/We.ll email you when Eco arrives/i),
    ).toBeVisible();

    // Never a chat surface the device can't use.
    await expect(greetingHeading(page)).toHaveCount(0);
  });
});
