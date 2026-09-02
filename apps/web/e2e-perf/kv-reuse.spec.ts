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
 * per-generation receipts actually recorded: hit rate, miss reasons, TTFT by
 * decision, and whether reuse resumed after the eviction-forced miss. It is a
 * MEASUREMENT, not a gate: it asserts only that the instrument itself is
 * alive (every receipt carries KV telemetry; the runtime round-trips a cache
 * every generation). Everything about how OFTEN reuse hits is reported, never
 * asserted.
 *
 * MEASUREMENT DESIGN — read before changing a prompt. A turn is not always one
 * generation. When the reply violates a hard constraint the user stated, the
 * product runs a hard-constraint REPAIR: a second generation with the repair
 * instruction prepended to the system prompt and the last user turn rewritten
 * (`lib/local-generation-constraints`). A repair therefore:
 *
 *   - always misses, by construction — it changes the FRONT of the prompt, so
 *     no cached sequence can be a prefix of it; and
 *   - commits ITS sequence as the held cache, so the NEXT turn is compared
 *     against a prompt the conversation never contained and misses too.
 *
 * This spec's original corpus asked for "one short sentence" on every turn,
 * which armed that repair on all of them, and receipts were per-TURN rather
 * than per-generation — so the row that survived was the repair's, and the
 * measured hit rate described the repair path rather than the conversation.
 * The steady-state and eviction phases below are deliberately free of hard
 * format constraints; the constrained phase at the end exists to measure the
 * repair's cost on purpose, and is excluded from the steady-state hit rate.
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

/**
 * Short prompts keep decode time out of the measurement's way — WITHOUT a hard
 * format constraint, which would arm the repair path and measure that instead
 * of the conversation (see MEASUREMENT DESIGN above). "Briefly" shortens the
 * reply; the constraint regexes in `lib/local-generation-constraints` need an
 * explicit "one sentence" / "exactly N lines" / "one word" shape to fire.
 */
const SHORT_PROMPTS = [
  "Briefly, name a vegetable that grows well in spring.",
  "Briefly, name a flower that blooms in summer.",
  "Briefly, name a tree that turns red in autumn.",
  "Briefly, name a plant that survives winter.",
  "Briefly, name a common garden bird.",
  "Briefly, name a useful garden tool.",
];

/**
 * Deliberately constraint-bearing — these arm the hard-constraint repair so
 * its cost is measured on purpose rather than contaminating the steady state.
 */
const CONSTRAINED_PROMPTS = [
  "In one short sentence, name a herb that likes full sun.",
  "In one short sentence, name a fruit that ripens in late summer.",
];

const PASTE_TURNS = 3;

type Phase = "steady" | "paste" | "after-eviction" | "constrained";

type TurnRow = {
  turn: number;
  phase: Phase;
  /** Rows of one turn share its number; a repair turn contributes two. */
  generationRole: "primary" | "repair";
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
    generationRole: receipt.generationRole,
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
      // Let the app lay out to the real window. Playwright otherwise emulates a
      // fixed 1280x720 viewport inside a taller window, so the `h-dvh` shell
      // renders short and the run looks broken to anyone watching it.
      viewport: null,
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
        // One row per GENERATION: a repair turn returns two receipts.
        for (const receipt of await runTurn(page, prompt, turn)) {
          const row = toRow(receipt, turn, phase);
          rows.push(row);
          console.log(
            `  turn ${row.turn} [${row.phase}/${row.generationRole}]`
            + ` ${row.decision}${row.reason ? `/${row.reason}` : ""}`
            + ` cached=${row.cachedLen} prompt=${row.promptLen} ttft=${Math.round(row.firstTokenMs)}ms`,
          );
        }
      };

      // ── Phase 1: steady state ─────────────────────────────────────────────
      for (const prompt of SHORT_PROMPTS.slice(0, 3)) {
        await walk(prompt, "steady");
      }

      // ── Phase 2: saturate the history budget ──────────────────────────────
      for (let i = 0; i < PASTE_TURNS; i++) {
        await walk(`${PASTE_BLOCK}\nBriefly, what is this text about?`, "paste");
      }

      // ── Phase 3: after eviction ───────────────────────────────────────────
      for (const prompt of SHORT_PROMPTS.slice(3)) {
        await walk(prompt, "after-eviction");
      }

      // ── Phase 4: the repair path, on purpose ──────────────────────────────
      // Last, so the misses a repair forces cannot leak into the phases above.
      for (const prompt of CONSTRAINED_PROMPTS) {
        await walk(prompt, "constrained");
      }
    } finally {
      // The conversation's own reuse behavior is the PRIMARY generations of the
      // constraint-free phases. Repair generations are excluded on purpose:
      // they miss by construction, so folding them in measures the repair path
      // and calls it the hit rate.
      const conversationRows = rows.filter(
        (row) => row.generationRole === "primary" && row.phase !== "constrained",
      );
      const repairRows = rows.filter((row) => row.generationRole === "repair");
      const reuseRows = conversationRows.filter((row) => row.decision === "reuse");
      const missReasons: Record<string, number> = {};
      for (const row of conversationRows) {
        if (row.decision === "miss") {
          missReasons[row.reason ?? "unknown"] = (missReasons[row.reason ?? "unknown"] ?? 0) + 1;
        }
      }
      // Eviction is the history WINDOW SLIDING, and its signature is the render
      // getting SHORTER than the previous turn's — which surfaces as an
      // `equal-or-shorter` miss, not `not-strict-prefix`. Keying off the reason
      // string found the first prompt-shaped miss instead (a front-of-prompt
      // injection several turns earlier) and reported it as the eviction turn.
      const evictionMissIndex = conversationRows.findIndex(
        (row, i) =>
          i > 0
          && row.decision === "miss"
          && row.promptLen < conversationRows[i - 1]!.promptLen,
      );
      const summary = {
        generations: rows.length,
        conversationTurns: conversationRows.length,
        reuseCount: reuseRows.length,
        // Turn 1 can never reuse (no cache exists) — exclude it from the rate.
        hitRateAfterTurn1:
          conversationRows.length > 1
            ? reuseRows.length / (conversationRows.length - 1)
            : null,
        missReasons,
        medianTtftReuseMs: medianOf(reuseRows.map((row) => row.firstTokenMs)),
        medianTtftColdMs: medianOf(
          conversationRows
            .filter((row) => row.reason === "no-cache")
            .map((row) => row.firstTokenMs),
        ),
        medianTtftReprefillMs: medianOf(
          conversationRows
            .filter((row) => row.reason === "not-strict-prefix")
            .map((row) => row.firstTokenMs),
        ),
        evictionMissTurn:
          evictionMissIndex >= 0 ? conversationRows[evictionMissIndex]!.turn : null,
        reuseResumedAfterEviction:
          evictionMissIndex >= 0
          && conversationRows
            .slice(evictionMissIndex + 1)
            .some((row) => row.decision === "reuse"),
        // The base system prompt must not drift across a conversation; if this
        // is false, something is rewriting the FRONT of the prompt per turn and
        // every downstream reuse number is describing that instead.
        systemPromptStable:
          new Set(conversationRows.map((row) => row.systemPromptHash)).size <= 1,
        // What the repair path costs, measured on purpose.
        repairPath: {
          generations: repairRows.length,
          reuseCount: repairRows.filter((row) => row.decision === "reuse").length,
          medianTtftMs: medianOf(repairRows.map((row) => row.firstTokenMs)),
          // A repair turn's own primary generation, for the paired comparison.
          medianTtftPrimaryMs: medianOf(
            rows
              .filter((row) => row.phase === "constrained" && row.generationRole === "primary")
              .map((row) => row.firstTokenMs),
          ),
        },
      };
      const body = JSON.stringify({ summary, generations: rows }, null, 2);
      console.log(`kv-reuse summary: ${JSON.stringify(summary, null, 2)}`);
      const reportPath = join(__dirname, "..", "test-results", "kv-report.json");
      mkdirSync(join(__dirname, "..", "test-results"), { recursive: true });
      writeFileSync(reportPath, body);
      console.log(`  full per-generation report: ${reportPath}`);
      await test.info().attach("kv-report.json", {
        body,
        contentType: "application/json",
      });
    }

    // ── Instrument-liveness invariants (everything else is report-only) ─────
    // The walk must have produced all its turns, every receipt must carry KV
    // telemetry, and the runtime must round-trip a cache on every completed
    // generation — a healthy decision stream with cacheCommitted=false is the
    // signature of a runtime that never returns `past_key_values` (see
    // runtime/kv-cache.ts). Note the deliberate absences: turn 1 is NOT
    // asserted to be a miss (the mount-warmup smoke can pre-populate the
    // cache — that is a finding this spec exists to surface, not a broken
    // instrument), and no hit RATE is asserted (that is the measurement).
    const expectedTurns =
      3 + PASTE_TURNS + (SHORT_PROMPTS.length - 3) + CONSTRAINED_PROMPTS.length;
    expect(
      new Set(rows.map((row) => row.turn)).size,
      "the walk did not complete every turn",
    ).toBe(expectedTurns);
    // The constraint-free phases must stay constraint-free: a repair there
    // would mean a prompt (or the model's output shape) started tripping
    // `lib/local-generation-constraints`, and the steady-state numbers would
    // quietly become repair-path numbers again.
    expect(
      rows.filter((row) => row.generationRole === "repair" && row.phase !== "constrained"),
      "a constraint-free phase ran a repair — the steady-state corpus is contaminated",
    ).toEqual([]);
    for (const row of rows) {
      expect(
        row.cacheCommitted,
        `turn ${row.turn} (${row.generationRole}) did not commit a KV cache`,
      ).toBe(true);
    }
  });
});
