// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { test, expect, type Page, type Request } from "@playwright/test";
import { mkdirSync } from "node:fs";

const launchRcScreenshotDir = "test-results/launch-rc";
const browserDirectLookupUrl =
  /^https:\/\/(?:en\.wikipedia\.org|www\.wikidata\.org)\//;
const localFixtureSearch =
  // Slot readiness rides on the URL through the validation harness — the
  // legacy localStorage slot keys are no longer honored as a seeding seam, and
  // without these params the gate runs REAL setup (a genuine model download
  // through the dev proxy) which keeps the network busy for the whole test.
  "eco-validation-slot-eco-fast=local/qwen3-0.6b"
  + "&eco-validation-slot-status-eco-fast=ready"
  + "&eco-validation-selected-model=eco-fast"
  + "&eco-local-generation-fixture=smoke-ready"
  + "&eco-local-generation-model=local/qwen3-0.6b"
  + "&eco-local-generation-slot=eco-fast"
  + "&eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16"
  + "&eco-force-opfs=true"
  // This fixture primes a 'ready' eco-fast slot with NO cache bytes; treat that
  // primed cache as verified so boot reconcile does not flip the slot to
  // 'preparing' (which would suppress the faked local generation below).
  + "&eco-force-cache-verified=1";

async function seedCompletedLocalOnboarding(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          step: "complete",
          hardwareCapability: "wasm",
          deviceMemoryGB: 16,
          recommendedModelId: "local/qwen3-0.6b",
        },
        version: 1,
      }),
    );
    window.localStorage.setItem("eco-home-entry-dismissed", "true");
    window.localStorage.setItem("eco-tour-completed", "true");
    window.localStorage.setItem("eco-discovery-model-selector", "true");
    window.localStorage.setItem("eco-discovery-keyboard-shortcuts", "true");
    window.localStorage.setItem("eco-local-ai-slot-eco-fast", "local/qwen3-0.6b");
    window.localStorage.setItem("eco-local-ai-slot-status-eco-fast", "ready");
    window.localStorage.setItem("eco-selected-model", "eco-fast");
    window.localStorage.setItem("eco-selected-model-explicit", "false");
    window.localStorage.setItem("eco-privacy-tier", "device");
    window.localStorage.setItem("eco-privacy-tier-explicit", "false");
    window.localStorage.setItem("eco-cookie-consent-dismissed", "true");
    window.sessionStorage.setItem("eco-skip-sw-registration-once", "true");
  });
}

async function waitForPersistedSetting(page: Page, key: string): Promise<void> {
  await page.waitForFunction(async (settingKey) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("eco-settings", 1);
      request.onerror = () => reject(request.error ?? new Error("Failed to open settings database"));
      request.onsuccess = () => resolve(request.result);
    });

    try {
      if (!database.objectStoreNames.contains("settings")) {
        return false;
      }

      return await new Promise<boolean>((resolve, reject) => {
        const transaction = database.transaction("settings", "readonly");
        const request = transaction.objectStore("settings").get(settingKey as string);
        request.onerror = () => reject(request.error ?? new Error("Failed to read setting"));
        request.onsuccess = () => {
          const record = request.result as { ciphertext?: unknown; nonce?: unknown } | undefined;
          resolve(typeof record?.ciphertext === "string" && typeof record.nonce === "string");
        };
      });
    } finally {
      database.close();
    }
  }, key);
}

function requestContainsText(request: Request, text: string): boolean {
  const encodedText = encodeURIComponent(text);
  const headers = Object.entries(request.headers())
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [request.url(), headers, request.postData() ?? ""].some(
    (part) => part.includes(text) || part.includes(encodedText),
  );
}

test.beforeEach(async ({ context, page }) => {
  mkdirSync(launchRcScreenshotDir, { recursive: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

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

test("local fixture generation never sends prompt text to network routes", async ({ page }) => {
  const privatePrompt = "PRIVATE_PROMPT_SHOULD_NOT_EGRESS_LOCAL_TURN";
  const promptEgressRequests: string[] = [];
  await seedCompletedLocalOnboarding(page);

  page.on("request", (request) => {
    if (requestContainsText(request, privatePrompt)) {
      promptEgressRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto(`/chat?${localFixtureSearch}`, { waitUntil: "networkidle" });

  await page.getByLabel("Message input").fill(privatePrompt);
  await page.getByRole("button", { name: "Send message" }).click();

  await expect(page.getByText(/local\/fixture response/i)).toBeVisible();
  await expect(page.getByText(/no Eco Network prompt egress was needed/i)).toBeVisible();
  await expect(page.getByText(/Fixture complete/i)).toBeVisible();
  await page.screenshot({ path: `${launchRcScreenshotDir}/chromium-webgpu.png`, fullPage: true });

  expect(promptEgressRequests).toEqual([]);
});

test("web lookups off: fact query declines deterministically with no egress", async ({ page }) => {
  // A sentinel rides along with a realistic tool-triggering prompt so a regression
  // that egressed the prompt via ANY route (not just the known lookup hosts) is
  // caught, while the host trap still proves the specific lookup hosts stay dark.
  const factPrompt = "tell me about the Eiffel Tower ECOFACTPROBE-FACT";
  const browserDirectRequests: string[] = [];
  const promptEgressRequests: string[] = [];
  await seedCompletedLocalOnboarding(page);
  await page.route(browserDirectLookupUrl, (route) => {
    browserDirectRequests.push(`${route.request().method()} ${route.request().url()}`);
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  page.on("request", (request) => {
    if (requestContainsText(request, "ECOFACTPROBE-FACT")) {
      promptEgressRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto("/settings?tab=models&eco-force-cache-verified=1", { waitUntil: "networkidle" });

  const webLookupSwitch = page.getByRole("switch", {
    name: "Toggle web fact lookups",
  });
  await expect(webLookupSwitch).toBeVisible({ timeout: 15_000 });
  await expect(webLookupSwitch).toHaveAttribute("aria-checked", "true");
  await webLookupSwitch.click();
  await expect(webLookupSwitch).toHaveAttribute("aria-checked", "false");
  await waitForPersistedSetting(page, "grounding-enabled");

  await page.goto(`/chat?${localFixtureSearch}`, { waitUntil: "networkidle" });
  await page.getByLabel("Message input").fill(factPrompt);
  await page.getByRole("button", { name: "Send message" }).click();

  // With lookups off, a factual query is declined DETERMINISTICALLY by the host —
  // the model is never invoked, so it cannot fabricate a falsely-sourced answer
  // (F-1). The decline message renders instead of the fixture model output.
  await expect(page.getByText(/web lookups are turned off/i)).toBeVisible();
  // The fixture model never ran (no "Fixture complete" — generation was skipped).
  await expect(page.getByText(/Fixture complete/i)).toHaveCount(0);
  // The core guarantee: the query never egressed anything.
  expect(browserDirectRequests).toEqual([]);
  expect(promptEgressRequests).toEqual([]);
});

test("offline after local readiness stays on the browser-local path", async ({ page, context }) => {
  const privatePrompt = "PRIVATE_PROMPT_OFFLINE_AFTER_READY_SHOULD_NOT_EGRESS";
  const promptEgressRequests: string[] = [];
  await seedCompletedLocalOnboarding(page);

  page.on("request", (request) => {
    if (requestContainsText(request, privatePrompt)) {
      promptEgressRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto(`/chat?${localFixtureSearch}`, { waitUntil: "networkidle" });
  await context.setOffline(true);

  try {
    await page.getByLabel("Message input").fill(privatePrompt);
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(page.getByText(/local\/fixture response/i)).toBeVisible();
    await expect(page.getByText(/Fixture complete/i)).toBeVisible();
    await expect(page.getByText(/Use Eco Network instead/i)).toHaveCount(0);
    await page.screenshot({ path: `${launchRcScreenshotDir}/offline-after-ready.png`, fullPage: true });
    expect(promptEgressRequests).toEqual([]);
  } finally {
    await context.setOffline(false);
  }
});
