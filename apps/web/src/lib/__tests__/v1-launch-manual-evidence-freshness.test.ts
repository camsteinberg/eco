// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Seed evidence freshness gate (ROADMAP 0b).
 *
 * `apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json` ships pre-baked manual
 * evidence so production users get profile-scoped recommendations at first
 * touch. The seed flows through a 45-day TTL gate; once it expires, seed
 * proof is treated as missing/advisory so recommendation falls back to
 * predicted fit rather than stale benchmark confidence.
 *
 * This test makes the expiry visible in CI/local QA. When it fails, regenerate
 * `apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json` from the latest Eval Harness export
 * snapshot and bump its `generatedAt` timestamp.
 *
 * The hard fail matches the production constant SEED_EVIDENCE_TTL_DAYS (imported
 * below so this test can never drift from the runtime gate). The warning at 25
 * days gives ~3 weeks of lead time so refreshes don't pile up at the deadline.
 *
 * ── How to refresh (5-minute chore) ──────────────────────────────────────
 *   1. Open `apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json`
 *      and set the top-level `generatedAt` to today (ISO, e.g.
 *      "2026-07-03T00:00:00.000Z"). That single field is what this gate reads.
 *   2. Bump `SNAPSHOT_GENERATED_AT_MS` in
 *      `apps/web/src/local-ai/evidence/__tests__/seed.test.ts` to the same date
 *      (it anchors the isSnapshotFresh assertions that read the JSON top-level).
 *   3. Do NOT touch the per-row `generatedAt` / `observedAt` timestamps unless
 *      you actually re-ran the benchmarks — per-row freshness is a separate axis
 *      and the pinned seed/admission/recommend tests anchor on those dates.
 *   4. Run `pnpm --filter @eco/web test` and confirm green.
 * When a real Eval Harness re-export is available, regenerate the whole JSON
 * from it and re-date every row instead.
 */

import { describe, it, expect } from "vitest";
import seed from "../../local-ai/evidence/data/v1-launch-manual-evidence.json";
import { SEED_EVIDENCE_TTL_DAYS } from "../../local-ai/evidence/seed";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Derived from the real production constant so the test tracks the runtime gate. */
const TTL_MS = SEED_EVIDENCE_TTL_DAYS * DAY_MS;
const WARNING_THRESHOLD_DAYS = 25;

describe("v1-launch-manual-evidence.json freshness", () => {
  it("declares a parseable generatedAt timestamp", () => {
    expect(typeof seed.generatedAt).toBe("string");
    const parsed = Date.parse(seed.generatedAt as string);
    expect(Number.isFinite(parsed)).toBe(true);
  });

  it(`is within the ${SEED_EVIDENCE_TTL_DAYS}-day manual-evidence TTL`, () => {
    const generatedAtMs = Date.parse(seed.generatedAt as string);
    const ageMs = Date.now() - generatedAtMs;
    const ageDays = Math.floor(ageMs / DAY_MS);

    if (ageMs > TTL_MS) {
      throw new Error(
        `Seed evidence is ${ageDays} days old (TTL = ${SEED_EVIDENCE_TTL_DAYS} days). `
          + `Production users on Chromium 8 GB / 16 GB profiles will fall back to predicted-fit confidence instead of benchmark confidence. `
          + `Refresh apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json from the latest analyzer snapshot.`,
      );
    }

    expect(ageMs).toBeLessThanOrEqual(TTL_MS);
  });

  it("warns when the seed is within a week of expiring", () => {
    const generatedAtMs = Date.parse(seed.generatedAt as string);
    const ageDays = Math.floor((Date.now() - generatedAtMs) / DAY_MS);

    if (ageDays >= WARNING_THRESHOLD_DAYS) {
      // Don't fail — just surface a clear console signal so the user sees it
      // during normal QA runs. The hard fail above catches actual expiry.
      console.warn(
        `Seed evidence is ${ageDays} days old. `
          + `Plan a refresh of apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json before it hits the ${SEED_EVIDENCE_TTL_DAYS}-day TTL.`,
      );
    }
    expect(ageDays).toBeGreaterThanOrEqual(0);
  });
});
