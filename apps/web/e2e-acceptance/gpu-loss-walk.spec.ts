// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * GPU-loss walk — the page keeps running but loses its WebGPU device while it
 * is in the background, the way a phone treats a page through a long lock.
 *
 * Opt-in and separate from the acceptance walk: it runs only with
 * `ECO_GPU_LOSS_WALK=1`, on the acceptance lane's production harness build
 * (port 3120), in a WebLLM profile whose models are already downloaded (run
 * the WebLLM lane once first, or point `ECO_ACCEPTANCE_PROFILE_DIR` at one):
 *
 *   ECO_GPU_LOSS_WALK=1 pnpm --filter @eco/web exec playwright test \
 *     -c playwright.acceptance.config.ts gpu-loss-walk
 *
 * The loss comes from the harness seam `eco-force-gpu-loss` (localStorage,
 * read at bootstrap; see `installValidationGpuLoss`): when the tab is next
 * hidden it destroys every WebGPU device the page made, and optionally makes
 * `navigator.gpu.requestAdapter()` resolve null. The tab is put in the
 * background with the harness's `window.__ecoHarnessVisibility` control: under
 * Playwright, real tab hiding never reaches the page (measured — a tab behind
 * another, a minimized window and focus emulation all stayed `visible`), so
 * the control reports `hidden` and fires `visibilitychange` the way a phone
 * lock does. Each walk checks the page really reports `hidden` before it
 * trusts anything after. The real event order is the iPhone's to show.
 *
 *   W1 `hide`                     the page can still get an adapter: the model
 *                                 comes back with no error and no page reload;
 *                                 then Stop, and the next message still answers.
 *   W2 `hide-no-adapter`          it cannot: the page reloads by itself, once,
 *                                 with the conversation intact, and answers.
 *   W3 `hide-no-adapter`, the     the turn is saved, the page reloads once, and
 *      message sent while the     the reloaded page answers it without the
 *      page reports hidden        person sending it again.
 *   W4 `hide-no-adapter-sticky`   the GPU never comes back: exactly one
 *                                 automatic reload, then an honest error card —
 *                                 no reload loop.
 *
 * Every walk runs on Eco Mobile (the iPhone's model), on WebLLM, in real
 * Chrome presenting desktop Safari's user agent.
 */

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import { join } from "node:path";
import { assistantMessages, composer, setWebBaseUrl, stubAuth } from "../e2e-perf/lib/session";
import {
  finishGeneration,
  outcomeReceipt,
  sendTurn,
  stopMidReply,
  userMessages,
  waitForUsableChat,
  RESIDENCY_SETTLE_MS,
} from "./lib/walk";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3120";
const PROFILE_DIR =
  process.env.ECO_ACCEPTANCE_PROFILE_DIR ?? join(__dirname, ".browser-profile-webllm");
const DESKTOP_SAFARI_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/26.4 Safari/605.1.15";

const MODEL_ID = "candidate/qwen2.5-0.5b-mlc";
const SLOT = "eco-fast";
const GPU_LOSS_KEY = "eco-force-gpu-loss";

/** How long the tab stays in the background. The loss is immediate; this only lets it land. */
const HIDDEN_MS = 3_000;
/** Time for an invisible model reload (a cached load plus a one-token check) after the tab returns. */
const RECOVERY_SETTLE_MS = 20_000;
/** A page reload, then the model loading from the browser's cache. */
const RELOAD_TIMEOUT_MS = 60_000;

const PROMPT_1 = "How far is the Moon from Earth, roughly?";
const PROMPT_2 = "And how long does light take to cover that distance?";

const ENABLED = process.env.ECO_GPU_LOSS_WALK === "1";
test.skip(!ENABLED, "opt-in: set ECO_GPU_LOSS_WALK=1");

test.describe.configure({ mode: "serial" });

let context: BrowserContext;

test.beforeAll(async () => {
  if (!ENABLED) return;
  setWebBaseUrl(BASE_URL);
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    userAgent: DESKTOP_SAFARI_USER_AGENT,
  });
  await stubAuth(context);
});

test.afterAll(async () => {
  // Never leave a sticky value behind in the shared profile.
  const page = context?.pages()[0];
  if (page?.url().startsWith(BASE_URL)) {
    await page.evaluate((key) => window.localStorage.removeItem(key), GPU_LOSS_KEY).catch(() => undefined);
  }
  await context?.close();
});

/**
 * Open /chat on Eco Mobile with the seam armed. The init script runs on every
 * load of this tab, so the parts that must happen once — an empty workspace,
 * arming the seam — are guarded by the tab's sessionStorage, which survives a
 * reload. It also counts this tab's page loads.
 */
async function openChat(lever: string): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(
    ({ slot, modelId, key, value }) => {
      window.localStorage.setItem(`eco-local-ai-slot-${slot}`, modelId);
      window.localStorage.setItem(`eco-local-ai-slot-status-${slot}`, "ready");
      window.localStorage.setItem("eco-selected-model", slot);
      window.localStorage.setItem("eco-selected-model-explicit", "true");
      const loads = Number(window.sessionStorage.getItem("eco-gpu-walk-loads") ?? "0") + 1;
      window.sessionStorage.setItem("eco-gpu-walk-loads", String(loads));
      if (loads === 1) {
        window.sessionStorage.setItem("eco-skip-conversation-persistence-once", "true");
        window.localStorage.setItem(key, value);
      }
    },
    { slot: SLOT, modelId: MODEL_ID, key: GPU_LOSS_KEY, value: lever },
  );
  await page.goto(`${BASE_URL}/chat`, { waitUntil: "commit" });
  await waitForUsableChat(page);
  await expectResident(page);
  return page;
}

async function expectResident(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__ecoPerf?.activeModelId() ?? null), {
      timeout: RESIDENCY_SETTLE_MS,
      message: `${MODEL_ID} never became resident`,
    })
    .toBe(MODEL_ID);
}

const pageLoads = (page: Page): Promise<number> =>
  page.evaluate(() => Number(window.sessionStorage.getItem("eco-gpu-walk-loads") ?? "0"));

const visibility = (page: Page): Promise<string> =>
  page.evaluate(() => document.visibilityState);

/** Report the chat page as hidden or visible through the harness control. */
async function setVisibility(page: Page, state: "hidden" | "visible"): Promise<void> {
  const installed = await page.evaluate((next) => {
    if (!window.__ecoHarnessVisibility) return false;
    window.__ecoHarnessVisibility(next);
    return true;
  }, state);
  expect(installed, "window.__ecoHarnessVisibility missing — not a harness build?").toBe(true);
  expect(
    await visibility(page),
    "the visibility override did not take — nothing after this would mean anything",
  ).toBe(state);
}

async function hide(page: Page): Promise<void> {
  await setVisibility(page, "hidden");
  await page.waitForTimeout(HIDDEN_MS);
}

async function show(page: Page): Promise<void> {
  await setVisibility(page, "visible");
}

/** Type and send without waiting for the reply. */
async function submitWithoutWaiting(page: Page, prompt: string): Promise<void> {
  await composer(page).click();
  await page.keyboard.insertText(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
}

test("W1 — the device is lost in the background and an adapter is still there: the model comes back quietly", async () => {
  const page = await openChat("hide");
  const first = await sendTurn(page, PROMPT_1);
  expect(outcomeReceipt(first)?.status, "turn 1 did not answer").toBe("complete");

  await hide(page);
  await show(page);
  await page.waitForTimeout(RECOVERY_SETTLE_MS);

  const second = await sendTurn(page, PROMPT_2);
  const receipt = outcomeReceipt(second);
  expect(receipt?.status, `turn 2 after the loss: ${receipt?.errorCode ?? "no receipt"}`).toBe("complete");
  expect(
    receipt?.events?.some((event) => event.phase === "load-start") ?? false,
    "turn 2 had to load the model itself — recovery did not run when the tab came back",
  ).toBe(false);
  expect(await pageLoads(page), "the quiet branch reloaded the page").toBe(1);

  // What a person does next: stop a reply, then send another message.
  const before = await assistantMessages(page).count();
  await submitWithoutWaiting(page, "Explain in detail how the Moon formed.");
  await expect(assistantMessages(page)).toHaveCount(before + 1);
  const stop = await stopMidReply(page);
  expect(stop.stopped, stop.stopped ? "" : stop.reason).toBe(true);
  const after = await sendTurn(page, "Thanks. One sentence: what is a tide?");
  expect(outcomeReceipt(after)?.status, "the message after Stop did not answer").toBe("complete");
  await page.close();
});

test("W2 — the device is lost and this page cannot get another: one reload, conversation intact, answered", async () => {
  const page = await openChat("hide-no-adapter");
  const first = await sendTurn(page, PROMPT_1);
  expect(outcomeReceipt(first)?.status, "turn 1 did not answer").toBe("complete");

  await hide(page);
  await show(page);
  await expect.poll(() => pageLoads(page), { timeout: RELOAD_TIMEOUT_MS, message: "the page never reloaded" }).toBe(2);
  expect(
    await page.evaluate(
      () => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type,
    ),
  ).toBe("reload");

  await waitForUsableChat(page);
  await expectResident(page);
  await expect(userMessages(page).first(), "the conversation did not survive the reload").toContainText(PROMPT_1);

  const second = await sendTurn(page, PROMPT_2);
  expect(outcomeReceipt(second)?.status, "turn 2 after the reload did not answer").toBe("complete");
  expect(await pageLoads(page), "more than one automatic reload").toBe(2);
  await page.close();
});

test("W3 — a message sent before the page is shown again is saved, the page reloads once, and it is answered", async () => {
  const page = await openChat("hide-no-adapter");
  const first = await sendTurn(page, PROMPT_1);
  expect(outcomeReceipt(first)?.status, "turn 1 did not answer").toBe("complete");

  await hide(page);
  // Sent while the page reports hidden, so the send meets the lost device
  // before the page's own recovery can (on a phone: the device-lost event
  // arriving after the person already pressed Send). The reload brings the page
  // back visible: the override does not survive it.
  await submitWithoutWaiting(page, PROMPT_2);
  await expect.poll(() => pageLoads(page), { timeout: RELOAD_TIMEOUT_MS, message: "the page never reloaded" }).toBe(2);
  expect(await visibility(page)).toBe("visible");

  await waitForUsableChat(page);
  const answered = await finishGeneration(page, PROMPT_2, null);
  expect(outcomeReceipt(answered)?.status, "the saved turn was not answered after the reload").toBe("complete");
  await expect(userMessages(page), "the person's message is missing or was sent twice").toHaveCount(2);
  await expect(userMessages(page).last()).toContainText(PROMPT_2);
  expect(await pageLoads(page), "more than one automatic reload").toBe(2);
  await page.close();
});

test("W4 — the GPU never comes back: exactly one automatic reload, then an honest error, no loop", async () => {
  const page = await openChat("hide-no-adapter-sticky");
  try {
    const first = await sendTurn(page, PROMPT_1);
    expect(outcomeReceipt(first)?.status, "turn 1 did not answer").toBe("complete");

    await hide(page);
    await show(page);
    await expect.poll(() => pageLoads(page), { timeout: RELOAD_TIMEOUT_MS, message: "the page never reloaded" }).toBe(2);
    await waitForUsableChat(page);

    // Long enough for a loop to show itself several times over.
    await page.waitForTimeout(RECOVERY_SETTLE_MS);
    expect(await pageLoads(page), "the page kept reloading").toBe(2);

    const second = await sendTurn(page, PROMPT_2);
    expect(outcomeReceipt(second)?.status, "a page with no GPU answered — the seam did not hold").toBe("error");
    await expect(assistantMessages(page).last()).not.toHaveText("");
    await page.waitForTimeout(5_000);
    expect(await pageLoads(page), "the failed send reloaded the page again").toBe(2);
  } finally {
    await page.evaluate((key) => window.localStorage.removeItem(key), GPU_LOSS_KEY).catch(() => undefined);
    await page.close();
  }
});
