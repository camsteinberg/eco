// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shared session plumbing for the e2e-perf lane.
 *
 * Both perf specs (the regression gate and the KV-reuse measurement) walk the
 * same warm path: a persistent real-Chrome profile, a stubbed auth session, an
 * empty workspace per page, and turns that finish when the app records a
 * generation receipt — never when the DOM stops changing. This module is that
 * shared walk; the specs own only what they measure and assert.
 */

import { expect, type BrowserContext, type Page } from "@playwright/test";
import type { GenerationReceipt } from "../../src/local-ai/lifecycle/generation-receipt";

export const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

/** The lane's model: the smallest shipping desktop model (~0.28GB starter floor). */
export const MODEL_ID = "candidate/lfm2.5-350m-onnx";

/** Forced device profile (WebGPU desktop) so selection is deterministic. */
export const FORCED_DESKTOP_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16";

export const SETUP_TIMEOUT_MS = 900_000;
export const READY_TIMEOUT_MS = 180_000;
export const TURN_TIMEOUT_MS = 180_000;

export const chatLog = (page: Page) => page.getByRole("log", { name: "Chat messages" });
export const assistantMessages = (page: Page) =>
  chatLog(page).locator('[data-message-role="assistant"]');
export const composer = (page: Page) => page.getByLabel("Message input");

export async function stubAuth(context: BrowserContext): Promise<void> {
  await context.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        session: {
          id: "perf-session",
          userId: "perf-user-id",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        user: {
          id: "perf-user-id",
          email: "perf@eco.network",
          name: "Perf User",
          emailVerified: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    }),
  );
  await context.route("**/api/auth/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

/**
 * Open /chat on a page whose workspace starts EMPTY.
 *
 * Conversations persist in IndexedDB across pages in the reused profile. Without
 * this, a later run's "turn 1" would open with an earlier run's history — a grown
 * prefill that would inflate TTFT run over run — and the empty-state surfaces
 * would never render. `eco-skip-conversation-persistence-once` is the app's own
 * one-shot skip-hydration seam (sessionStorage, so it is per-tab); sign-out uses
 * it. The trade-off is that conversation-list hydration is excluded from any
 * page-load timing; it runs in parallel with the model load either way.
 */
export async function openEmptyChat(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.sessionStorage.setItem("eco-skip-conversation-persistence-once", "true");
  });
  await page.goto(`${WEB_BASE_URL}/chat?${FORCED_DESKTOP_PROFILE}`, {
    waitUntil: "commit",
  });
  return page;
}

/** Fail fast and legibly if the harness bridge is missing (wrong build/env). */
export async function requireBridge(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__ecoPerf?.version ?? null), {
      timeout: READY_TIMEOUT_MS,
      message:
        "window.__ecoPerf missing — the server must be a production build started with "
        + "NEXT_PUBLIC_ECO_VALIDATION_HARNESS=true on a loopback host (see playwright.perf.config.ts)",
    })
    .toBe(1);
}

/**
 * One-time setup walk on a fresh profile: real first-run setup downloads and
 * proves the starter model; on a warm profile it lands straight on a ready
 * chat. Either way it leaves `MODEL_ID` resident and a settled 'declined'
 * upgrade phase behind (a background upgrade download would contend for
 * bandwidth mid-measurement, and the popup would sit over the composer —
 * 'declined' is exactly what a user clicking "not now" leaves behind).
 */
export async function ensureModelReady(context: BrowserContext): Promise<void> {
  console.log("  prefetch: opening /chat …");
  const prefetch = await openEmptyChat(context);
  try {
    prefetch.on("console", (msg) => {
      if (msg.text().includes("[eco-setup-failure]")) console.log(`  ${msg.text()}`);
    });
    // Ready = the setup gate released the workspace and the composer accepts
    // input. Deliberately NOT the empty-state greeting: that only renders when
    // no conversation is open, which makes it a readiness signal that silently
    // stops working the moment the profile carries chat history.
    const errorSurface = prefetch.locator("[data-eco-setup-error-surface]");
    await expect(composer(prefetch).or(errorSurface).first()).toBeVisible({
      timeout: SETUP_TIMEOUT_MS,
    });
    await expect(errorSurface, "first-run setup failed — nothing to measure").toHaveCount(0);
    console.log("  prefetch: chat is ready, waiting for the model to load …");
    await requireBridge(prefetch);

    // This lane's numbers are model-specific. If selection ever stops landing
    // on the starter floor here, fail loudly rather than measure a different
    // model than the one named in the report.
    await expect
      .poll(() => prefetch.evaluate(() => window.__ecoPerf?.activeModelId() ?? null), {
        timeout: READY_TIMEOUT_MS,
        message: `setup did not leave ${MODEL_ID} resident in the runtime`,
      })
      .toBe(MODEL_ID);

    await prefetch.evaluate(() => {
      window.localStorage.setItem(
        "eco-local-ai-upgrade-v1",
        JSON.stringify({
          version: 1,
          phase: "declined",
          targetModelId: "candidate/qwen3.5-2b-onnx",
          baseModelId: "candidate/lfm2.5-350m-onnx",
          deferral: null,
          swapAttempts: 0,
          updatedAt: Date.now(),
        }),
      );
    });
    console.log(`  prefetch: ${MODEL_ID} resident`);
  } finally {
    await prefetch.close();
  }
}

/**
 * Run one turn and return its generation receipt.
 *
 * The turn is considered finished when the app records the receipt — the same
 * finalization point the product uses — not when the DOM stops changing.
 */
export async function runTurn(
  page: Page,
  prompt: string,
  turnNumber: number,
): Promise<GenerationReceipt> {
  await expect(composer(page), {
    message: "composer never re-enabled — the previous generation never finalized",
  }).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  await composer(page).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await page.waitForFunction(
    (expected) => (window.__ecoPerf?.receipts() ?? []).length >= expected,
    turnNumber,
    { timeout: TURN_TIMEOUT_MS, polling: 100 },
  );
  await expect(assistantMessages(page)).toHaveCount(turnNumber, {
    timeout: TURN_TIMEOUT_MS,
  });

  const receipt = await page.evaluate(() => window.__ecoPerf?.receipts(1)[0] ?? null);
  expect(receipt, `turn ${turnNumber} produced no generation receipt`).not.toBeNull();
  const turn = receipt!;

  expect(turn.status, `turn ${turnNumber} did not complete cleanly`).toBe("complete");
  expect(turn.modelId, "the lane measured a different model than it targets").toBe(
    MODEL_ID,
  );
  expect(
    turn.firstTokenMs,
    `turn ${turnNumber} recorded no first-token time`,
  ).not.toBeNull();
  expect(
    turn.completionTokens,
    `turn ${turnNumber} reported no completion tokens`,
  ).toBeGreaterThan(1);

  return turn;
}

/** Tokens per second AFTER the first token — prefill is measured by TTFT. */
export function decodeRate(receipt: GenerationReceipt): number {
  const firstTokenMs = receipt.firstTokenMs ?? 0;
  const decodeMs = receipt.durationMs - firstTokenMs;
  expect(decodeMs, "decode window was not positive — timings are unusable").toBeGreaterThan(0);
  return ((receipt.completionTokens - 1) / decodeMs) * 1_000;
}
