// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Mid-file chunk resume (PR-L1) — real-browser coverage.
 *
 * The download path pulls files above RANGE_CHUNK_BYTES (32 MiB) in sequential
 * `bytes=start-end` requests, persisting each completed chunk under its own
 * storage entry (`${file.url}.ecopart.${stamp}.${offset}`). An interruption
 * (tab close, abort, network death) resumes mid-file from the last persisted
 * chunk instead of restarting the ~2 GB largest weight from byte 0. The offset
 * bookkeeping — resume enumeration, stale-stamp cleanup, per-chunk persist,
 * preflight netting, deletion ordering, and the L2 proxy-fallback composition —
 * is the primary gate and is covered deterministically in the unit suite
 * (`download.test.ts`, "mid-file chunk resume", 11 cases driving `downloadByPlan`
 * with a fake Range fetcher, a tiny `rangeChunkBytes`, and a shared storage
 * across a simulated interrupt+resume).
 *
 * WHY THE REAL-BYTES JOURNEY IS NOT WIRED HERE (structural, not flakiness):
 *
 *   1. The chunk path only engages for a file whose plan-declared `sizeBytes`
 *      exceeds RANGE_CHUNK_BYTES (32 MiB). That threshold is a module constant,
 *      and the production call site (`downloadModel` → `downloadByPlan`) never
 *      passes the `rangeChunkBytes` override — it exists only for unit tests.
 *      There is no URL/query/env harness seam to shrink it in a real browser
 *      (confirmed: no `rangeChunkBytes` reader outside download.ts + its tests).
 *      So a browser-observable resume requires a genuinely >32 MiB file.
 *
 *   2. The plan's per-file `sizeBytes`/`oid` come from the manifest endpoint
 *      (`/api/local-models/manifest/:id`), and `fetchManifestPlan` falls back to
 *      heuristic sizes unless the manifest lists EVERY catalog file for the
 *      selected model (bootstrap.ts completeness guard). Stubbing a synthetic
 *      >32 MiB file therefore means stubbing the model's entire file set with
 *      SHA-matching bytes — brittle to catalog changes.
 *
 *   3. Even then, "download completes to the observable ready state" is
 *      unreachable with synthetic bytes: after download the setup pipeline runs
 *      the smoke/load stage against the real runtime (Transformers.js / LiteRT),
 *      which needs actually-loadable weights, not filler. Driving the true chunk
 *      path with a real multi-GB weight across a mid-download reload is neither
 *      fast nor deterministic in CI — exactly the flaky real-bytes journey the
 *      task said to avoid faking.
 *
 * Activating this spec cleanly needs a small, deliberate harness seam (e.g. a
 * dev-only `eco-force-range-chunk-bytes` param threaded into `downloadModel`,
 * plus a synthetic loadable fixture model) — out of scope for L1, which must not
 * touch bootstrap/catalog. Until that seam exists, the offset logic is fully
 * gated by the unit suite and the orchestrator's manual felt-walk (a primed
 * interrupt+reload of a real large weight in a real browser). The scaffold below
 * is the intended journey, kept ready for that seam; it is skipped, not faked.
 *
 * Uses chromium.launchPersistentContext with a throwaway profile per the
 * download doctrine (ephemeral contexts break large Cache.put), matching
 * download-cdn-fallback.spec.ts. Deliberately does NOT set
 * eco-force-cache-verified — the real cache-write path is the point of a
 * chunk-resume walk.
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

/** Parse a `bytes=start-end` request Range header into its start offset. */
function rangeStartOf(rangeHeader: string | null): number | null {
  if (!rangeHeader) return null;
  const match = /bytes=(\d+)-/.exec(rangeHeader);
  return match ? Number(match[1]) : null;
}

test.describe("model download — mid-file chunk resume (real browser)", () => {
  let context: BrowserContext;
  let profileDir: string;

  test.beforeEach(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "eco-chunk-resume-"));
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
    });
  });

  test.afterEach(async () => {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  });

  // Skipped: the real-bytes chunk path needs a >32 MiB manifest-declared,
  // genuinely-loadable file and cannot be driven deterministically in local dev
  // without an out-of-scope harness seam (see the file header). The offset logic
  // is fully covered by download.test.ts; the orchestrator runs the primed
  // interrupt+reload felt-walk against a real weight as the browser gate.
  test.skip("resumes past the last completed chunk after a mid-download reload", async () => {
    const page = await context.newPage();
    await stubBackendRoutes(page);
    await seedFreshNoSlot(page);

    // Intended journey (activate once a rangeChunkBytes seam + synthetic loadable
    // fixture exist): route the model-file proxy, parse the request Range header,
    // fulfill 206 slices of a synthetic body while recording every start offset;
    // serve the first K chunks, then fail further requests; reload; let setup
    // re-enter; assert the post-reload Range starts past K·chunk (never bytes=0-).
    const rangeStarts: number[] = [];
    let reloaded = false;
    const CHUNK_COUNT_BEFORE_INTERRUPT = 3;

    await page.route("**/api/local-models/**", async (route) => {
      const start = rangeStartOf(route.request().headers()["range"] ?? null);
      if (start != null) rangeStarts.push(start);
      // Before reload: serve the first K chunks, then abort to force resume.
      if (!reloaded && rangeStarts.length > CHUNK_COUNT_BEFORE_INTERRUPT) {
        return route.abort();
      }
      // A real activation fulfills a 206 slice with a matching Content-Range here.
      return route.continue();
    });

    await page.goto(
      `${WEB_BASE_URL}/chat?local-ai-v1=1&${FORCED_DEVICE_PROFILE}`,
      { waitUntil: "domcontentloaded" },
    );

    reloaded = true;
    await page.reload({ waitUntil: "domcontentloaded" });

    // The post-reload transport must resume, not restart from byte 0.
    const postReloadStarts = rangeStarts.slice(CHUNK_COUNT_BEFORE_INTERRUPT);
    expect(postReloadStarts.length).toBeGreaterThan(0);
    expect(Math.min(...postReloadStarts)).toBeGreaterThan(0);
  });
});
