// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebLLM-lane funnel — the real thing, end to end.
 *
 * Walks the iOS WebKit-mobile journey (forced onto desktop Chrome via the
 * validation-harness profile params) with NO model mocks: fresh disk-backed
 * profile → auto-started download through `/api/local-models/` → WebLLM cache
 * bridge → smoke gate → ready → TWO real chat turns with streamed tokens.
 *
 * Each leg is a shipped-regression tripwire:
 *  - reaching `ready` after a real bridge download proves the smoke pre-flight
 *    consults WebLLM's own cache, not Eco staging (PR #63 — the bridge empties
 *    staging on success, so any Eco-cache probe declines a healthy install);
 *  - turn 2 completing proves the adapter drains the engine's token stream to
 *    completion (PR #64 — breaking out early left the engine busy forever and
 *    deadlocked every second generation).
 *
 * Requirements: real Chrome (channel "chrome"), WebGPU-capable machine, network
 * access for the model download. Headed on purpose — WebGPU is not available
 * in default headless Chromium. Runs only via playwright.webllm.config.ts.
 */

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

// The deterministic desktop repro of the iOS WebKit-mobile profile
// (device/profile.ts force params; gating decided in device/compatibility.ts).
const FORCED_IOS_WEBKIT_PROFILE =
  "eco-force-browser=safari"
  + "&eco-force-platform=mobile"
  + "&eco-force-capability=webgpu"
  + "&eco-force-device-memory=4";

// The known residual first-message latency defect is ~60s on real iPhones, so
// the first-turn budget is deliberately generous. Tighten once the latency
// defect is eliminated.
const READY_TIMEOUT_MS = 900_000;
const TURN_TIMEOUT_MS = 180_000;

const chatLog = (page: Page) => page.getByRole("log", { name: "Chat messages" });
const assistantMessages = (page: Page) =>
  chatLog(page).locator('[data-message-role="assistant"]');

async function stubAuth(context: BrowserContext): Promise<void> {
  await context.route("**/api/auth/get-session", (route) =>
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
  await context.route("**/api/auth/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
}

/** Send a prompt and wait for a NEW assistant message to complete. */
async function runChatTurn(
  page: Page,
  prompt: string,
  expectedAssistantCount: number,
): Promise<string> {
  // A composer that never re-enables after the previous turn is the
  // engine-never-finalized deadlock signature (PR #64) — fail here with a
  // bounded, diagnosable assertion instead of retrying fill() forever.
  await expect(page.getByLabel("Message input"), {
    message: "composer never re-enabled — previous generation likely never finalized",
  }).toBeEnabled({ timeout: TURN_TIMEOUT_MS });
  await page.getByLabel("Message input").fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const message = assistantMessages(page).nth(expectedAssistantCount - 1);
  await expect(assistantMessages(page)).toHaveCount(expectedAssistantCount, {
    timeout: TURN_TIMEOUT_MS,
  });

  // Wait for real content, then for the stream to finish (text stable for 3s).
  await expect
    .poll(async () => ((await message.textContent()) ?? "").trim().length, {
      timeout: TURN_TIMEOUT_MS,
      message: "assistant message never produced content",
    })
    .toBeGreaterThan(10);
  let previous = "";
  await expect
    .poll(
      async () => {
        const current = ((await message.textContent()) ?? "").trim();
        const stable = current.length > 10 && current === previous;
        previous = current;
        return stable;
      },
      {
        timeout: TURN_TIMEOUT_MS,
        intervals: [3_000],
        message: "assistant message never stopped streaming",
      },
    )
    .toBe(true);
  return previous;
}

test.describe("webllm lane — real funnel", () => {
  let profileDir: string;
  let context: BrowserContext;

  test.beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "eco-webllm-e2e-"));
    // Persistent context on a fresh temp dir: still a cold first-run profile,
    // but with disk-backed storage — ephemeral contexts back the Cache API in
    // memory and reject the ~270MB model put with "Unexpected internal error".
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: false,
    });
    await stubAuth(context);
  });

  test.afterAll(async () => {
    await context?.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  });

  test("fresh profile → download → bridge → smoke → ready → two streamed turns", async () => {
    const page = context.pages()[0] ?? (await context.newPage());

    const setupFailures: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("[eco-setup-failure]")) setupFailures.push(msg.text());
    });
    const modelRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/local-models/")) modelRequests.push(req.url());
    });

    await page.goto(`${WEB_BASE_URL}/chat?${FORCED_IOS_WEBKIT_PROFILE}`, {
      waitUntil: "domcontentloaded",
    });

    // The lane must engage: setup surface, never the mobile decline handoff.
    // (If the forced webgpu capability were ever downgraded by a real probe,
    // we'd land on the decline surface — fail loudly here rather than time out.)
    await expect(page.locator("[data-eco-setup-surface]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText(/Phones don't have the memory for that yet/i),
    ).toHaveCount(0);

    // Real download in flight: the progress bar exists and the model proxy is
    // actually being hit (no mocks anywhere on this path).
    await expect(
      page.getByRole("progressbar", { name: "Setup progress" }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => modelRequests.length, {
        timeout: 60_000,
        message: "no /api/local-models/ traffic — download never started",
      })
      .toBeGreaterThan(0);

    // Download + engine load + smoke → ready chat. Reaching this after a real
    // bridge download IS the PR #63 regression assertion. Wait on ready OR the
    // setup error surface so a failed funnel reports in minutes, not after the
    // full ready budget.
    const greeting = page.getByRole("heading", {
      name: /Good (morning|afternoon|evening)/,
    });
    const errorSurface = page.locator("[data-eco-setup-error-surface]");
    await expect(greeting.or(errorSurface).first()).toBeVisible({
      timeout: READY_TIMEOUT_MS,
    });
    await expect(errorSurface, {
      message: `setup landed on the error surface — funnel failed before ready (failures: ${setupFailures.join("; ")})`,
    }).toHaveCount(0);
    await expect(greeting).toBeVisible();
    await expect(page.locator("[data-eco-setup-surface]")).toHaveCount(0);
    expect(setupFailures, `setup failures: ${setupFailures.join("; ")}`).toEqual([]);

    // Turn 1: real generation, streamed into the assistant bubble.
    const prompt1 = "Please count from one to ten, one number per line.";
    const reply1 = await runChatTurn(page, prompt1, 1);
    expect(reply1).not.toContain(prompt1);

    // Turn 2: the PR #64 regression. Before the stream-drain fix, the engine
    // was never finalized after turn 1 and this generation deadlocked forever.
    const prompt2 = "Now write one short sentence about trees.";
    const reply2 = await runChatTurn(page, prompt2, 2);
    expect(reply2).not.toContain(prompt2);
  });
});
