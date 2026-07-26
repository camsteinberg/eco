// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * KV-cache reuse measurement — real browser, real GPU, real model.
 *
 * Multi-turn chat re-renders the whole conversation every turn; the
 * transformers worker skips the re-prefill by holding `past_key_values`, but
 * ONLY when the cached token sequence is a strict prefix of the new render
 * (`runtime/kv-cache.ts`). Two product mechanisms govern how often that gate
 * hits:
 *
 *   1. steady state — every plain follow-up turn should reuse; anything that
 *      perturbs the rendered prefix (system-prompt drift, template changes)
 *      silently turns every turn into a full re-prefill, and
 *   2. context eviction — when the history budget saturates, the window start
 *      moves. `context-window.ts` quantizes that movement (1/8-budget steps)
 *      precisely so reuse RESUMES after one miss instead of missing forever.
 *
 * This spec walks one conversation through both regimes and reports what the
 * per-turn receipts actually recorded: hit rate, miss reasons, TTFT by
 * decision, and whether reuse resumed after the eviction-forced miss. It is a
 * MEASUREMENT, not a gate: it asserts only that the instrument itself is
 * alive (every receipt carries KV telemetry; the runtime round-trips a cache
 * every turn). Everything about how OFTEN reuse hits is reported, never
 * asserted — the first runs of this spec measured a 12–25% hit rate and four
 * distinct defeat mechanisms (the mount-warmup smoke pre-populating the
 * cache, replies re-rendering shorter than they were generated once filters
 * strip content, per-turn system-prompt drift, and auxiliary scoped
 * generations clobbering the chat cache mid-conversation), and those are
 * product findings for adjudication, not instrument failures.
 *
 * TTFT numbers land in `test-results/kv-report.json` for analysis, never in
 * a pass/fail band — run-to-run variance belongs to the regression gate.
 *
 * Phase sizing: the starter model's context window is 4096 tokens, so the
 * history budget is ~3072 estimator-tokens minus the system prompt
 * (`context-window.ts` trims with the chars/4 heuristic, which makes paste
 * sizing deterministic regardless of how replies vary). Three ~4,400-char
 * pastes total ~3,300 estimator-tokens and are guaranteed to cross the
 * budget.
 *
 * Runs only via playwright.perf.config.ts (production build, port 3100,
 * persistent real-Chrome profile). See e2e-perf/README.md.
 */

import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerationReceipt } from "../src/local-ai/lifecycle/generation-receipt";
import {
  ensureModelReady,
  openEmptyChat,
  requireBridge,
  runTurn,
  stubAuth,
} from "./lib/session";

const PROFILE_DIR =
  process.env.ECO_PERF_PROFILE_DIR ?? join(__dirname, ".browser-profile");

/**
 * ~4,400 chars ≈ 1,100 estimator-tokens per paste. Deliberately plain prose —
 * a realistic "pasted an article" shape, not a token-stuffing string.
 */
const PASTE_BLOCK = (
  "The greenhouse effect of a well-tended garden is easy to underestimate. "
  + "Raised beds warm earlier in the year than open ground, and a gardener who "
  + "plans the season around that difference can start harvesting weeks ahead of "
  + "the almanac. Companion planting matters too: beans fix nitrogen that heavy "
  + "feeders like squash consume, while marigolds keep certain pests away from "
  + "tomatoes. Water management is the quiet discipline underneath all of it — "
  + "deep, infrequent watering trains roots downward, while daily sprinkling "
  + "keeps them shallow and fragile. "
).repeat(8);

/** Short prompts keep decode time out of the measurement's way. */
const SHORT_PROMPTS = [
  "In one short sentence, name a vegetable that grows well in spring.",
  "In one short sentence, name a flower that blooms in summer.",
  "In one short sentence, name a tree that turns red in autumn.",
  "In one short sentence, name a plant that survives winter.",
  "In one short sentence, name a common garden bird.",
  "In one short sentence, name a useful garden tool.",
];

const PASTE_TURNS = 3;

type Phase = "steady" | "paste" | "after-eviction";

type TurnRow = {
  turn: number;
  phase: Phase;
  decision: "reuse" | "miss";
  reason?: string;
  cachedLen: number;
  promptLen: number;
  commonPrefixLen?: number;
  cacheCommitted: boolean;
  promptTokens: number;
  completionTokens: number;
  firstTokenMs: number;
  durationMs: number;
  systemPromptHash: string;
};

function toRow(receipt: GenerationReceipt, turn: number, phase: Phase): TurnRow {
  const kv = receipt.kvReuse;
  expect(kv, `turn ${turn} receipt carries no kvReuse telemetry — instrument is dead`).toBeTruthy();
  return {
    turn,
    phase,
    decision: kv!.decision,
    ...(kv!.reason !== undefined ? { reason: kv!.reason } : {}),
    cachedLen: kv!.cachedLen,
    promptLen: kv!.promptLen,
    ...(kv!.commonPrefixLen !== undefined ? { commonPrefixLen: kv!.commonPrefixLen } : {}),
    cacheCommitted: kv!.cacheCommitted,
    promptTokens: receipt.promptTokens,
    completionTokens: receipt.completionTokens,
    firstTokenMs: receipt.firstTokenMs ?? -1,
    durationMs: receipt.durationMs,
    systemPromptHash: receipt.systemPromptHash,
  };
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

test.describe("local-AI KV-cache reuse measurement", () => {
  let context: BrowserContext;

  test.beforeAll(async () => {
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

  test("steady-state turns reuse the KV cache and reuse resumes after context eviction", async () => {
    await ensureModelReady(context);

    const page = await openEmptyChat(context);
    const rows: TurnRow[] = [];
    try {
      await requireBridge(page);

      let turn = 0;
      const walk = async (prompt: string, phase: Phase) => {
        turn += 1;
        const receipt = await runTurn(page, prompt, turn);
        const row = toRow(receipt, turn, phase);
        rows.push(row);
        console.log(
          `  turn ${row.turn} [${row.phase}] ${row.decision}${row.reason ? `/${row.reason}` : ""}`
          + ` cached=${row.cachedLen} prompt=${row.promptLen} ttft=${Math.round(row.firstTokenMs)}ms`,
        );
      };

      // ── Phase 1: steady state ─────────────────────────────────────────────
      for (const prompt of SHORT_PROMPTS.slice(0, 3)) {
        await walk(prompt, "steady");
      }

      // ── Phase 2: saturate the history budget ──────────────────────────────
      for (let i = 0; i < PASTE_TURNS; i++) {
        await walk(
          `${PASTE_BLOCK}\nIn one short sentence, what is this text about?`,
          "paste",
        );
      }

      // ── Phase 3: after eviction ───────────────────────────────────────────
      for (const prompt of SHORT_PROMPTS.slice(3)) {
        await walk(prompt, "after-eviction");
      }
    } finally {
      const reuseRows = rows.filter((row) => row.decision === "reuse");
      const missReasons: Record<string, number> = {};
      for (const row of rows) {
        if (row.decision === "miss") {
          missReasons[row.reason ?? "unknown"] = (missReasons[row.reason ?? "unknown"] ?? 0) + 1;
        }
      }
      const evictionMissIndex = rows.findIndex(
        (row) => row.turn > 1 && row.reason === "not-strict-prefix",
      );
      const summary = {
        turns: rows.length,
        reuseCount: reuseRows.length,
        // Turn 1 can never reuse (no cache exists) — exclude it from the rate.
        hitRateAfterTurn1:
          rows.length > 1 ? reuseRows.length / (rows.length - 1) : null,
        missReasons,
        medianTtftReuseMs: medianOf(reuseRows.map((row) => row.firstTokenMs)),
        medianTtftColdMs: medianOf(
          rows.filter((row) => row.reason === "no-cache").map((row) => row.firstTokenMs),
        ),
        medianTtftReprefillMs: medianOf(
          rows
            .filter((row) => row.reason === "not-strict-prefix")
            .map((row) => row.firstTokenMs),
        ),
        evictionMissTurn: evictionMissIndex >= 0 ? rows[evictionMissIndex]!.turn : null,
        reuseResumedAfterEviction:
          evictionMissIndex >= 0
          && rows.slice(evictionMissIndex + 1).some((row) => row.decision === "reuse"),
        systemPromptStable: new Set(rows.map((row) => row.systemPromptHash)).size <= 1,
      };
      const body = JSON.stringify({ summary, turns: rows }, null, 2);
      console.log(`kv-reuse summary: ${JSON.stringify(summary, null, 2)}`);
      const reportPath = join(__dirname, "..", "test-results", "kv-report.json");
      mkdirSync(join(__dirname, "..", "test-results"), { recursive: true });
      writeFileSync(reportPath, body);
      console.log(`  full per-turn report: ${reportPath}`);
      await test.info().attach("kv-report.json", {
        body,
        contentType: "application/json",
      });
    }

    // ── Instrument-liveness invariants (everything else is report-only) ─────
    // The walk must have produced all its turns, every receipt must carry KV
    // telemetry, and the runtime must round-trip a cache on every completed
    // turn — a healthy decision stream with cacheCommitted=false is the
    // signature of a runtime that never returns `past_key_values` (see
    // runtime/kv-cache.ts). Note the deliberate absences: turn 1 is NOT
    // asserted to be a miss (the mount-warmup smoke can pre-populate the
    // cache — that is a finding this spec exists to surface, not a broken
    // instrument), and no hit RATE is asserted (that is the measurement).
    expect(rows.length, "the walk did not complete every turn").toBe(
      3 + PASTE_TURNS + (SHORT_PROMPTS.length - 3),
    );
    for (const row of rows) {
      expect(row.cacheCommitted, `turn ${row.turn} did not commit a KV cache`).toBe(true);
    }
  });
});
