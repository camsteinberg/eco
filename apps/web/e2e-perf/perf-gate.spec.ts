// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Performance regression gate — real browser, real GPU, real model.
 *
 * Eco has strong functional E2E coverage and, until this lane, zero performance
 * coverage: time-to-first-token could double and every check would stay green.
 * This gate measures the four numbers a user actually feels on the warm path
 * and compares each against a committed baseline with tolerance bands
 * (`baseline.json`, `lib/compare.ts`):
 *
 *   warmReadinessMs     page load of /chat with a cached, proven model →
 *                       the model is resident in the runtime (chat is usable)
 *   ttftTurn1Ms         send → first token of the first reply
 *   ttftTurn2Ms         same conversation, second turn (KV/prefix reuse)
 *   decodeTokensPerSec  streamed tokens per second after the first token
 *
 * MEASUREMENT SOURCE. Never the DOM. Timings come from the app's own per-turn
 * generation receipts (`local-ai/lifecycle/generation-receipt.ts` — the same
 * records the diagnostics dump carries) and from
 * `runtime/lifecycle.getActiveModel()`, read through the harness-gated
 * `window.__ecoPerf` bridge. DOM waits are used only to drive the UI.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not seed a fake-ready slot: the
 * warm-readiness number is only honest if the slot really is restored, really
 * is reconciled against the real cache, and the mount-time warm really does
 * load the weights. It also does not stub the model — the first run downloads
 * the real starter model into a persistent profile that later runs reuse.
 *
 * Requirements: real Chrome (channel "chrome"), a WebGPU-capable machine,
 * network access on the FIRST run only. Headed on purpose — WebGPU is not
 * available in default headless Chromium. Runs only via
 * playwright.perf.config.ts.
 */

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GenerationReceipt } from "../src/local-ai/lifecycle/generation-receipt";
import {
  METRIC_KEYS,
  getProfileBaseline,
  readBaselineFile,
  updateProfileBaseline,
  writeBaselineFile,
  type MetricKey,
} from "./lib/baseline";
import { evaluateRun, formatReport, median } from "./lib/compare";

const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3100";

/** The gate's model: the smallest shipping desktop model (~0.28GB starter floor). */
const MODEL_ID = "candidate/lfm2.5-350m-onnx";

/** Forced device profile (WebGPU desktop) so selection is deterministic. */
const FORCED_DESKTOP_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16";

const BASELINE_PATH = join(__dirname, "baseline.json");
const PROFILE_KEY = process.env.ECO_PERF_PROFILE ?? "desktop-chromium-webgpu";
const SAMPLES = Number.parseInt(process.env.ECO_PERF_SAMPLES ?? "3", 10);
const UPDATE_BASELINE = process.env.ECO_PERF_UPDATE_BASELINE === "1";
/**
 * Disk-backed profile, reused across runs so only the first run downloads.
 * Ephemeral Playwright contexts back the Cache API in memory and reject large
 * `Cache.put` calls, so a persistent context is mandatory here.
 */
const PROFILE_DIR =
  process.env.ECO_PERF_PROFILE_DIR ?? join(__dirname, ".browser-profile");

const SETUP_TIMEOUT_MS = 900_000;
const READY_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 180_000;

/** Long enough to make the decode rate stable, short enough to keep the gate quick. */
const PROMPT_TURN_1 = "Write a short paragraph, about five sentences, describing a garden in spring.";
const PROMPT_TURN_2 = "Now describe the same garden in autumn, in two sentences.";

type Sample = Record<MetricKey, number>;

const chatLog = (page: Page) => page.getByRole("log", { name: "Chat messages" });
const assistantMessages = (page: Page) =>
  chatLog(page).locator('[data-message-role="assistant"]');
const composer = (page: Page) => page.getByLabel("Message input");

async function stubAuth(context: BrowserContext): Promise<void> {
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
 * this, run 2's "turn 1" would open with run 1's history — a grown prefill that
 * would inflate TTFT sample over sample — and the empty-state surfaces would
 * never render. `eco-skip-conversation-persistence-once` is the app's own
 * one-shot skip-hydration seam (sessionStorage, so it is per-tab); sign-out uses
 * it. The trade-off is that conversation-list hydration is excluded from
 * `warmReadinessMs`; it runs in parallel with the model load either way.
 */
async function openEmptyChat(context: BrowserContext): Promise<Page> {
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
async function requireBridge(page: Page): Promise<void> {
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
 * Run one turn and return its generation receipt.
 *
 * The turn is considered finished when the app records the receipt — the same
 * finalization point the product uses — not when the DOM stops changing.
 */
async function runTurn(
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
  expect(turn.modelId, "the gate measured a different model than it baselined").toBe(
    MODEL_ID,
  );
  expect(
    turn.firstTokenMs,
    `turn ${turnNumber} recorded no first-token time`,
  ).not.toBeNull();
  expect(
    turn.completionTokens,
    `turn ${turnNumber} reported no completion tokens — decode rate is unmeasurable`,
  ).toBeGreaterThan(1);

  return turn;
}

/** Tokens per second AFTER the first token — prefill is measured by TTFT. */
function decodeRate(receipt: GenerationReceipt): number {
  const firstTokenMs = receipt.firstTokenMs ?? 0;
  const decodeMs = receipt.durationMs - firstTokenMs;
  expect(decodeMs, "decode window was not positive — timings are unusable").toBeGreaterThan(0);
  return ((receipt.completionTokens - 1) / decodeMs) * 1_000;
}

/**
 * One full sample: a cold page load against a warm on-disk model cache, then
 * two chat turns in the same conversation.
 */
async function measureSample(context: BrowserContext, index: number): Promise<Sample> {
  const page = await openEmptyChat(context);
  try {
    await requireBridge(page);

    // Warm readiness: navigation start (performance.timeOrigin of THIS document)
    // → the model is resident in the runtime. `getActiveModel()` is set only
    // after the adapter's load resolves, so this is genuinely "chat is usable",
    // not "the shell painted".
    const readyHandle = await page.waitForFunction(
      (modelId) => {
        const bridge = window.__ecoPerf;
        if (!bridge) return null;
        return bridge.activeModelId() === modelId ? performance.now() : null;
      },
      MODEL_ID,
      { timeout: READY_TIMEOUT_MS, polling: 50 },
    );
    // waitForFunction only resolves on a truthy value, so the null branch of
    // the predicate is unreachable here.
    const warmReadinessMs = (await readyHandle.jsonValue()) ?? 0;

    const turn1 = await runTurn(page, PROMPT_TURN_1, 1);
    const turn2 = await runTurn(page, PROMPT_TURN_2, 2);

    const sample: Sample = {
      warmReadinessMs,
      ttftTurn1Ms: turn1.firstTokenMs!,
      ttftTurn2Ms: turn2.firstTokenMs!,
      decodeTokensPerSec: decodeRate(turn1),
    };
    console.log(`  sample ${index + 1}/${SAMPLES}: ${JSON.stringify(sample)}`);
    return sample;
  } finally {
    await page.close();
  }
}

test.describe("local-AI performance gate", () => {
  let context: BrowserContext;

  test.beforeAll(async () => {
    if (process.env.ECO_PERF_FRESH_PROFILE === "1") {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    }
    mkdirSync(PROFILE_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
    });
    await stubAuth(context);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("warm readiness, TTFT and decode rate stay within the committed bands", async () => {
    expect(SAMPLES, "ECO_PERF_SAMPLES must be at least 1").toBeGreaterThan(0);

    // ── Prefetch (not measured) ─────────────────────────────────────────────
    // First run on a fresh profile: real first-run setup downloads the starter
    // model and proves it. Later runs land straight on a ready chat.
    // Phase logging: this gate can legitimately run for many minutes on a fresh
    // profile, so it must say where it is instead of looking hung.
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

      // The gate's numbers are model-specific. If selection ever stops landing
      // on the starter floor here, fail loudly rather than baseline a different
      // model against the committed numbers.
      await expect
        .poll(() => prefetch.evaluate(() => window.__ecoPerf?.activeModelId() ?? null), {
          timeout: READY_TIMEOUT_MS,
          message: `setup did not leave ${MODEL_ID} resident in the runtime`,
        })
        .toBe(MODEL_ID);

      // Keep the consent-driven upgrade offer out of the measured runs: a
      // background upgrade download would contend for bandwidth and the popup
      // would sit over the composer. Recording a settled 'declined' phase is
      // exactly what a user clicking "not now" leaves behind.
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
      console.log(`  prefetch: ${MODEL_ID} resident — starting ${SAMPLES} samples`);
    } finally {
      await prefetch.close();
    }

    // ── Measure ─────────────────────────────────────────────────────────────
    const samples: Sample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      samples.push(await measureSample(context, i));
    }

    const samplesByMetric: Record<string, number[]> = {};
    for (const key of METRIC_KEYS) {
      samplesByMetric[key] = samples.map((sample) => sample[key]);
    }

    // ── Record or compare ───────────────────────────────────────────────────
    // A missing file is only tolerable in update mode (bootstrapping a machine
    // that has never recorded one); comparison mode must never invent a baseline.
    const file =
      existsSync(BASELINE_PATH) || !UPDATE_BASELINE
        ? readBaselineFile(BASELINE_PATH)
        : { schemaVersion: 1 as const, profiles: {} };

    if (UPDATE_BASELINE) {
      const medians: Record<string, number> = {};
      for (const [key, values] of Object.entries(samplesByMetric)) {
        medians[key] = median(values);
      }
      const updated = updateProfileBaseline(file, {
        profileKey: PROFILE_KEY,
        measurements: medians,
        label:
          getProfileBaseline(file, PROFILE_KEY)?.label
          ?? "desktop Chrome + WebGPU, production build",
        machine:
          process.env.ECO_PERF_MACHINE
          ?? getProfileBaseline(file, PROFILE_KEY)?.machine
          ?? "unspecified",
        modelId: MODEL_ID,
        samples: SAMPLES,
        capturedAt: new Date().toISOString(),
      });
      writeBaselineFile(BASELINE_PATH, updated);
      console.log(
        `perf gate — baseline for "${PROFILE_KEY}" re-recorded:\n${JSON.stringify(medians, null, 2)}`,
      );
      return;
    }

    const profile = getProfileBaseline(file, PROFILE_KEY);
    expect(
      profile,
      `no baseline for profile "${PROFILE_KEY}" — record one with `
        + "ECO_PERF_UPDATE_BASELINE=1 (see e2e-perf/README.md)",
    ).not.toBeNull();
    expect(
      profile!.modelId,
      "the committed baseline was captured on a different model",
    ).toBe(MODEL_ID);

    const report = evaluateRun(PROFILE_KEY, samplesByMetric, profile!);
    const rendered = formatReport(report);
    console.log(rendered);
    await test.info().attach("perf-report.json", {
      body: JSON.stringify({ profileKey: PROFILE_KEY, samples, report }, null, 2),
      contentType: "application/json",
    });

    expect(report.ok, `\n${rendered}\n`).toBe(true);
  });
});
