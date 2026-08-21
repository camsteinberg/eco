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
    .toBe(2);
}

/**
 * One-time setup walk on a fresh profile: real first-run setup downloads and
 * proves the starter model; on a warm profile it lands straight on a ready
 * chat. Either way it leaves `MODEL_ID` resident.
 *
 * Nothing needs suppressing beyond that any more: a second model only ever
 * downloads when someone taps its tile and confirms, so this lane cannot have a
 * background transfer competing for bandwidth mid-measurement.
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

    console.log(`  prefetch: ${MODEL_ID} resident`);
  } finally {
    await prefetch.close();
  }
}

/**
 * Run one turn and return EVERY receipt it produced, in execution order.
 *
 * A turn is not always one inference run. When the reply violates a hard
 * constraint the user stated ("in one sentence", "exactly three lines"), the
 * product runs a SECOND generation — the hard-constraint repair
 * (`lib/local-generation-constraints`) — with the repair instruction prepended
 * to the system prompt and the last user turn rewritten. Both generations
 * record a receipt under the same `generationId`, roled `primary` then
 * `repair`.
 *
 * That distinction is load-bearing for any measurement: a repair rewrites the
 * FRONT of the prompt, so its KV decision is a structural miss that says
 * nothing about how the conversation itself reuses cache. Measure the primary;
 * read the last row for what the user actually saw.
 *
 * Waiting: the composer re-enabling means the turn (including any repair) is
 * over, and `pendingReceipts() === 0` means every receipt has cleared its
 * async hash and landed. Counting receipts per turn is NOT a valid wait — a
 * repair turn records two, so a count-based predicate returns early and reads
 * the previous turn's row.
 */
export async function runTurn(
  page: Page,
  prompt: string,
  turnNumber: number,
): Promise<GenerationReceipt[]> {
  await expect(composer(page), {
    message: "composer never re-enabled — the previous generation never finalized",
  }).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  await composer(page).fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  // The assistant bubble appears on dispatch, so this also clears the window
  // between click and the composer disabling.
  await expect(assistantMessages(page)).toHaveCount(turnNumber, {
    timeout: TURN_TIMEOUT_MS,
  });
  await expect(composer(page), {
    message: `turn ${turnNumber} never finalized — composer stayed disabled`,
  }).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  await page.waitForFunction(
    () => (window.__ecoPerf?.pendingReceipts() ?? 1) === 0,
    undefined,
    { timeout: TURN_TIMEOUT_MS, polling: 50 },
  );

  // Receipts come back newest-first; one turn's rows share a generationId.
  const turnReceipts = await page.evaluate(() => {
    const all = window.__ecoPerf?.receipts() ?? [];
    const newestId = all[0]?.generationId;
    if (newestId === undefined) return [];
    return all.filter((r) => r.generationId === newestId).reverse();
  });

  expect(
    turnReceipts.length,
    `turn ${turnNumber} produced no generation receipt`,
  ).toBeGreaterThan(0);

  const outcome = turnReceipts[turnReceipts.length - 1]!;
  expect(outcome.status, `turn ${turnNumber} did not complete cleanly`).toBe("complete");
  expect(outcome.modelId, "the lane measured a different model than it targets").toBe(
    MODEL_ID,
  );
  expect(
    outcome.completionTokens,
    `turn ${turnNumber} reported no completion tokens`,
  ).toBeGreaterThan(1);
  for (const receipt of turnReceipts) {
    expect(
      receipt.firstTokenMs,
      `turn ${turnNumber} ${receipt.generationRole} generation recorded no first-token time`,
    ).not.toBeNull();
  }

  return turnReceipts;
}

/**
 * Assert a turn ran exactly one generation and return its receipt.
 *
 * The regression gate's baselines assume one inference run per turn. A
 * hard-constraint repair adds a second with different sampling and a rewritten
 * prompt, which would silently change what the committed numbers mean — so a
 * prompt (or a model) that starts tripping the repair must fail loudly here
 * rather than quietly re-baseline the lane.
 */
export function soleGeneration(
  receipts: GenerationReceipt[],
  turnNumber: number,
): GenerationReceipt {
  expect(
    receipts.map((r) => r.generationRole),
    `turn ${turnNumber} ran more than one generation — this lane's baselines assume one`,
  ).toEqual(["primary"]);
  return receipts[0]!;
}

/** Tokens per second AFTER the first token — prefill is measured by TTFT. */
export function decodeRate(receipt: GenerationReceipt): number {
  const firstTokenMs = receipt.firstTokenMs ?? 0;
  const decodeMs = receipt.durationMs - firstTokenMs;
  expect(decodeMs, "decode window was not positive — timings are unusable").toBeGreaterThan(0);
  return ((receipt.completionTokens - 1) / decodeMs) * 1_000;
}
