// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test as base, expect, type Page } from "@playwright/test";
import { getModel } from "../../src/local-ai/catalog/catalog";

/**
 * Pre-seeded slot model for visual fixtures.
 *
 * Both fixtures below seed `eco-local-ai-slot-eco-fast` with this ID and
 * `eco-local-ai-slot-status-eco-fast` = "ready" via `page.addInitScript()`
 * BEFORE navigation. That makes `useLocalAiSetup` (apps/web/src/hooks/
 * local-ai/useLocalAiSetup.ts:66-70) short-circuit at the pass-through
 * branch — slot is already ready, so `setReady` is called and the
 * bootstrap pipeline (recommendation → download → smoke) never runs.
 * `LocalAiSetupGate` then renders its children deterministically.
 *
 * Without this, the visual tests that land on routes mounting
 * `LocalAiSetupGate` (everything under (app)/, including the `/` chat
 * workspace) capture a transient bootstrap-progress UI ("Setting up —
 * about 83 seconds") whose contents vary between runs — a ~97% pixel
 * diff between baseline and validation.
 *
 * IMPORTANT: this slot-bypass is VISUAL-fixture-only. The real bootstrap
 * pipeline is still exercised by unit tests under
 * `apps/web/src/local-ai/__tests__/` and e2e tests at
 * `apps/web/e2e/local-ai-v1-gate.spec.ts` and friends.
 */
const SEEDED_SLOT_MODEL_ID = "local/smollm2-1.7b-webllm-q4f16";

// Module-load guard: if the catalog ID is ever renamed/removed, fail
// LOUDLY here rather than silently dropping back into the slow bootstrap
// path (which would re-introduce the visual non-determinism).
if (getModel(SEEDED_SLOT_MODEL_ID) === null) {
  throw new Error(
    `Visual fixture SEEDED_SLOT_MODEL_ID "${SEEDED_SLOT_MODEL_ID}" is not in the v1 catalog. ` +
      `Update fixtures.ts to a real catalog ID before continuing — otherwise the dark-mode visual ` +
      `tests will re-enter the non-deterministic bootstrap pipeline.`,
  );
}

async function seedReadySlot(page: Page): Promise<void> {
  await page.addInitScript((modelId) => {
    try {
      window.localStorage.setItem("eco-local-ai-slot-eco-fast", modelId);
      window.localStorage.setItem(
        "eco-local-ai-slot-status-eco-fast",
        "ready",
      );
    } catch {
      // localStorage may be unavailable in some embedded contexts; the
      // fixture remains a best-effort seed.
    }
  }, SEEDED_SLOT_MODEL_ID);
}

/**
 * Custom Playwright test fixture that mocks all API calls for deterministic
 * visual regression screenshots. No live API server is needed.
 */
const test = base.extend({
  page: async ({ page }, use) => {
    // Mock all v1 API routes
    await page.route("**/v1/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    // Mock auth routes — default session is logged out.
    await page.route("**/api/auth/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: pathname.endsWith("/api/auth/get-session") ? "null" : "{}",
      });
    });

    // Mock internal routes
    await page.route("**/internal/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    // Seed slot state so LocalAiSetupGate skips the non-deterministic
    // bootstrap pipeline (see SEEDED_SLOT_MODEL_ID block above).
    await seedReadySlot(page);

    await use(page);
  },
});

/**
 * Authenticated test fixture — mocks session to return a valid user so that
 * auth-protected pages render their authenticated view.
 */
const authenticatedTest = base.extend({
  page: async ({ page }, use) => {
    // Mock all v1 API routes
    await page.route("**/v1/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    // Mock auth routes — authenticated user session.
    await page.route("**/api/auth/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: pathname.endsWith("/api/auth/get-session")
          ? JSON.stringify({
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
            })
          : "{}",
      });
    });

    // Mock internal routes
    await page.route("**/internal/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    );

    // Seed slot state so LocalAiSetupGate skips the non-deterministic
    // bootstrap pipeline (see SEEDED_SLOT_MODEL_ID block above).
    await seedReadySlot(page);

    await use(page);
  },
});

export { test, authenticatedTest, expect };
