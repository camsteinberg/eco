// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Setup responsiveness walk — a person's first run, from the welcome card to a
 * ready model, must leave the page usable while the model downloads and is
 * checked.
 *
 * Opt-in and separate from the acceptance walk: it runs only with
 * `ECO_SETUP_RESPONSIVENESS_WALK=1`, on the acceptance lane's production
 * harness build (port 3120), and downloads the model into a fresh profile it
 * deletes afterwards (~0.8 GB of disk for Eco Fast while it runs):
 *
 *   ECO_SETUP_RESPONSIVENESS_WALK=1 pnpm --filter @eco/web exec playwright test \
 *     -c playwright.acceptance.config.ts setup-responsiveness
 *
 * `ECO_SETUP_RESPONSIVENESS_PICK` picks the welcome tile (default `Eco Fast`);
 * `ECO_SETUP_RESPONSIVENESS_QUERY` appends to `/chat` (e.g.
 * `?eco-force-shader-f16=off` for the f16-less tiles, where Eco Deeper is
 * Gemma on LiteRT); `ECO_SETUP_RESPONSIVENESS_SAFARI_UA=1` presents desktop
 * Safari's user agent, so setup downloads the WebLLM model.
 *
 * LiteRT builds its engine on the main thread: Gemma's load is one ~0.65 s task
 * (s81, Mac), which this walk flags. That is the runtime's load, not the
 * download.
 *
 * The page's main thread is watched with the Long Tasks API from the Start
 * click until setup records its check. Each download's integrity check (a
 * SHA-256 over every byte) used to run on the main thread after the last byte
 * arrived: on this walk's model that was ~15 s of back-to-back ~600 ms tasks,
 * so every click and keystroke on the page waited up to 0.6 s.
 */

import { chromium, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setWebBaseUrl, stubAuth } from "../e2e-perf/lib/session";

const ENABLED = process.env.ECO_SETUP_RESPONSIVENESS_WALK === "1";
test.skip(!ENABLED, "opt-in: set ECO_SETUP_RESPONSIVENESS_WALK=1");

const WEB_BASE_URL = "http://localhost:3120";
const PICK = process.env.ECO_SETUP_RESPONSIVENESS_PICK ?? "Eco Fast";
const QUERY = process.env.ECO_SETUP_RESPONSIVENESS_QUERY ?? "";
const DESKTOP_SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/26.4 Safari/605.1.15";
const SAFARI_UA = process.env.ECO_SETUP_RESPONSIVENESS_SAFARI_UA === "1";

/** No single task may hold the page this long (a click feels stuck past ~200 ms). */
const MAX_LONG_TASK_MS = 250;
/** All long tasks together, from Start to ready. */
const TOTAL_LONG_TASK_MS = 1_000;

test("setup keeps the page responsive while the model downloads", async () => {
  test.setTimeout(1_800_000);
  setWebBaseUrl(WEB_BASE_URL);
  const profileDir = mkdtempSync(join(tmpdir(), "eco-setup-responsiveness-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
    ...(SAFARI_UA ? { userAgent: DESKTOP_SAFARI_USER_AGENT } : {}),
  });
  try {
    await stubAuth(context);
    const page = await context.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { __ecoLongTasks: Array<{ at: number; ms: number }> };
      w.__ecoLongTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          w.__ecoLongTasks.push({ at: Math.round(performance.timeOrigin + e.startTime), ms: Math.round(e.duration) });
        }
      }).observe({ type: "longtask", buffered: true });
    });

    await page.goto(`${WEB_BASE_URL}/chat${QUERY}`, { waitUntil: "commit" });
    const start = page.getByRole("button", { name: /^Start with / });
    await start.waitFor({ state: "visible", timeout: 120_000 });
    // Two tiles where the device has a choice; desktop Safari gets one model and no tiles.
    if (!SAFARI_UA) await page.getByRole("radio").filter({ hasText: PICK }).first().click();
    const startLabel = (await start.innerText()).replace(/\s+/g, " ").trim();
    await start.click();
    const startedAt = Date.now();

    // Setup writes its ledger once the downloaded model has passed (or failed) its check.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("eco-local-ai-ledger-v1")), {
        timeout: 1_500_000,
        intervals: [2_000],
      })
      .not.toBeNull();
    const readyAt = Date.now();

    const result = await page.evaluate(() => ({
      ledger: JSON.parse(localStorage.getItem("eco-local-ai-ledger-v1") ?? "[]") as Array<{ modelId: string; outcome: string }>,
      longTasks: (window as unknown as { __ecoLongTasks: Array<{ at: number; ms: number }> }).__ecoLongTasks,
    }));
    const during = result.longTasks.filter((t) => t.at >= startedAt && t.at <= readyAt);
    const totalMs = during.reduce((sum, t) => sum + t.ms, 0);
    const maxMs = during.reduce((max, t) => Math.max(max, t.ms), 0);
    const summary = {
      pick: SAFARI_UA ? null : PICK,
      startLabel,
      query: QUERY,
      safariUserAgent: SAFARI_UA,
      ledger: result.ledger,
      startToReadyMs: readyAt - startedAt,
      longTasks: during.length,
      longTaskTotalMs: totalMs,
      longTaskMaxMs: maxMs,
      tasks: during.map((t) => ({ sinceStartMs: t.at - startedAt, ms: t.ms })),
    };
    console.log(`[setup-responsiveness] ${JSON.stringify(summary)}`);
    await test.info().attach("setup-responsiveness.json", {
      body: JSON.stringify(summary, null, 2),
      contentType: "application/json",
    });

    expect(result.ledger.map((r) => r.outcome), "the downloaded model passed setup's check").toContain("smoke-pass");
    expect(maxMs, "longest main-thread task between Start and ready").toBeLessThan(MAX_LONG_TASK_MS);
    expect(totalMs, "main-thread long tasks between Start and ready, total").toBeLessThan(TOTAL_LONG_TASK_MS);
  } finally {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
});
