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
 * Session plumbing (auth stub, empty-workspace pages, receipt-driven turns,
 * first-run prefetch) is shared with the KV-reuse measurement spec via
 * `lib/session.ts`.
 *
 * Requirements: real Chrome (channel "chrome"), a WebGPU-capable machine,
 * network access on the FIRST run only. Headed on purpose — WebGPU is not
 * available in default headless Chromium. Runs only via
 * playwright.perf.config.ts.
 */

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  METRIC_KEYS,
  getProfileBaseline,
  readBaselineFile,
  updateProfileBaseline,
  writeBaselineFile,
  type MetricKey,
} from "./lib/baseline";
import { evaluateRun, formatReport, median } from "./lib/compare";
import {
  MODEL_ID,
  READY_TIMEOUT_MS,
  decodeRate,
  ensureModelReady,
  openEmptyChat,
  requireBridge,
  runTurn,
  soleGeneration,
  stubAuth,
} from "./lib/session";

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

/** Long enough to make the decode rate stable, short enough to keep the gate quick. */
const PROMPT_TURN_1 = "Write a short paragraph, about five sentences, describing a garden in spring.";
const PROMPT_TURN_2 = "Now describe the same garden in autumn, in two sentences.";

type Sample = Record<MetricKey, number>;

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

    // These prompts are deliberately free of hard format constraints, so each
    // turn is exactly one generation; `soleGeneration` keeps that true.
    const turn1 = soleGeneration(await runTurn(page, PROMPT_TURN_1, 1), 1);
    const turn2 = soleGeneration(await runTurn(page, PROMPT_TURN_2, 2), 2);

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
    // Phase logging: this gate can legitimately run for many minutes on a fresh
    // profile, so it must say where it is instead of looking hung.
    await ensureModelReady(context);
    console.log(`  starting ${SAMPLES} samples`);

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
