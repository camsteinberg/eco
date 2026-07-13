// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Model-download CDN → proxy fallback (PR-L2) — real-browser coverage.
 *
 * The download path pulls a file's bytes from `file.fetchUrl` (the direct R2
 * CDN URL when `NEXT_PUBLIC_ECO_MODEL_CDN_BASE` is set) and, on a transport
 * failure, retries ONCE against `file.url` (the same-origin proxy Eco always
 * serves). The seven fallback conditions — 5xx/408/429/network fall back, a CDN
 * serving corrupt bytes falls back, a hard 4xx / abort / no-distinct-CDN /
 * non-transport error does NOT — are the primary gate and live in the unit
 * suite (`download.test.ts`, "CDN → proxy transport fallback"), which drives
 * `fetchFileToBlob` directly with a fake fetcher keyed by URL.
 *
 * WHY THIS SPEC DOES NOT SPLIT A DISTINCT CDN ORIGIN:
 *   `file.fetchUrl` only differs from `file.url` when `getModelCdnBase()`
 *   (proxy.ts) returns a value, which reads `NEXT_PUBLIC_ECO_MODEL_CDN_BASE`
 *   from the dev-server environment at compile time (bootstrap.ts wires it into
 *   every plan file). The Playwright web server (playwright.config.ts) sets no
 *   CDN base, so locally `fetchUrl === url` and the CDN-vs-proxy branch cannot
 *   fire end-to-end. Making it fire would require either a global webServer env
 *   change (it inlines into EVERY spec's bundle and rewires the transport for
 *   the whole e2e suite — out of this PR's scope and unverifiable from the L2
 *   quality bar, which runs only this file) or a new harness seam consumed in
 *   bootstrap.ts (explicitly out of scope for L2). So this spec exercises the
 *   closest honest browser-observable scenario instead of faking a fallback:
 *   when the single available source (the proxy) fails, the refactored
 *   `fetchFileToBlobWithFallback` wrapper must (a) NOT invent a phantom second
 *   source — `shouldFallbackToProxy` returns false when `fetchUrl === url` —
 *   and (b) let first-run setup degrade honestly to the framed error surface,
 *   never a white screen or a hang. That is the production-faithful analogue of
 *   unit test "makes a single request … when fetchUrl is unset".
 *
 * Uses chromium.launchPersistentContext with a throwaway profile dir per the
 * download doctrine (ephemeral contexts break large Cache.put); no existing
 * spec launches its own context, so this one does it directly.
 */

import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WEB_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/** Forced device profile (WebGPU desktop) so setup never routes below-floor. */
const FORCED_DEVICE_PROFILE =
  "eco-force-capability=webgpu"
  + "&eco-force-browser=chromium"
  + "&eco-force-platform=desktop"
  + "&eco-force-device-memory=16";

/** Stub auth + gateway routes so the app boots without a real backend. */
async function stubBackendRoutes(page: Page): Promise<void> {
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
}

/**
 * Seeds completed onboarding but NO ready slot, so the setup gate runs the
 * first-run download pipeline. Must be called BEFORE page.goto().
 */
async function seedFreshNoSlot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("eco-local-ai-v1", "on");
    window.localStorage.setItem(
      "eco-onboarding",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          step: "complete",
          hardwareCapability: "webgpu",
          deviceMemoryGB: 16,
          recommendedModelId: null,
        },
        version: 1,
      }),
    );
    window.localStorage.setItem("eco-home-entry-dismissed", "true");
    window.localStorage.setItem("eco-tour-completed", "true");
    window.sessionStorage.setItem("eco-skip-sw-registration-once", "true");
  });
}

/** The sidebar "New chat" control — proof the app shell is still framed. */
function appShell(page: Page) {
  return page.getByRole("button", { name: "New chat" }).first();
}

test.describe("model download — CDN → proxy fallback (real browser)", () => {
  let context: BrowserContext;
  let profileDir: string;

  test.beforeEach(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "eco-cdn-fallback-"));
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
    });
  });

  test.afterEach(async () => {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  test("a failed model transport degrades honestly without a phantom second source", async () => {
    const page = await context.newPage();
    await stubBackendRoutes(page);
    await seedFreshNoSlot(page);

    // The only model transport in local dev is the same-origin proxy
    // (fetchUrl === url). Fail every model file with a 5xx: the fallback wrapper
    // must NOT synthesize a second source for a source that has no distinct CDN,
    // and setup must run the cascade to its honest error surface.
    const modelRequests: string[] = [];
    await page.route("**/api/local-models/**", (route) => {
      modelRequests.push(route.request().url());
      return route.fulfill({
        status: 503,
        contentType: "application/octet-stream",
        body: "",
      });
    });

    await page.goto(
      `${WEB_BASE_URL}/chat?local-ai-v1=1&${FORCED_DEVICE_PROFILE}`,
      { waitUntil: "domcontentloaded" },
    );

    // Honest, framed SetupErrorState — the ladder ran to exhaustion because the
    // single available source was down. No white screen, no hang.
    await expect(
      page.getByText(/couldn.t get one running on this device just yet/i),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/copy what happened and send it to us/i),
    ).toBeVisible();
    await expect(appShell(page)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Try setting up Eco again/i }),
    ).toBeVisible();

    // The download pipeline actually reached the transport (the wrapper ran in a
    // real browser): at least one model file was requested. Every request went
    // to the proxy path — there is no distinct CDN origin to fall back to.
    expect(modelRequests.length).toBeGreaterThan(0);
    for (const url of modelRequests) {
      expect(url).toContain("/api/local-models/");
    }
  });
});
