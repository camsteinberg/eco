// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Deterministic CJK-token suppression for non-CJK conversations.
 *
 * The multilingual Qwen3.5 family reproducibly leaks CJK script mid-English
 * (eval probe s1 emitted "甲烷" — the Chinese translation of "methane" — 2/2
 * runs). A real-WebGPU sampling A/B (2026-06-11, wave25-cjk-fix-r1/r2) REFUTED
 * every sampling-level fix: the leaked token is HIGH-probability in its slot,
 * not tail noise, so no top_p/temperature value removes it. The deterministic
 * fix is logits-level: ban every CJK-script vocab token via Transformers.js
 * `suppress_tokens` (SuppressTokensLogitsProcessor sets their logits to
 * -Infinity each step), but ONLY when the conversation gives no signal that
 * CJK output is wanted.
 *
 * Three pure pieces, all unit-tested (the worker that consumes them cannot
 * run under vitest):
 *
 *   1. `decideCjkSuppression(messages)` — the conversation gate.
 *   2. `collectCjkTokenIds(decodeToken, vocabSize)` — the vocab scan.
 *   3. `startCjkTokenScan(...)` — scan lifecycle handle the worker holds.
 *
 * Gate semantics (deliberate, see each note):
 *   - SYSTEM + USER text only. Assistant turns are EXCLUDED: a prior
 *     assistant-side CJK leak must never legitimize further leaking. A genuine
 *     CJK thread keeps its escape active anyway, because the user/system signal
 *     that started it stays in the replayed history every turn.
 *   - The gate is a SUPERSET of the rubric's `noCjkLeak` allowance
 *     (lib/cjk-script.ts is the shared predicate): everything the rubric
 *     considers legitimate CJK output is also unsuppressed here. The
 *     additional language-request escape covers explicit translation asks
 *     ("how do you say hello in japanese") that contain no CJK characters —
 *     suppressing those would silently destroy a real capability. Escape
 *     misses degrade softly (the model romanizes); false escapes degrade to
 *     today's behavior (leak possible). Neither corrupts output.
 *
 * Suppression is per-model opt-in via the generation-profiles module
 * (`isCjkSuppressionEnabled`) — the everyday LFM2.5 default never pays the
 * scan or the gate.
 */

import { hasCjkScript } from '../../lib/cjk-script';

/**
 * Minimal structural message shape (ChatMessage from ./types is assignable).
 * Declared locally so ./types can import telemetry types from THIS module
 * without a circular import. Intentionally does NOT track future ChatMessage
 * fields — the gate reads only role + content.
 */
type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string };

// ─── Telemetry ──────────────────────────────────────────────────────────────

/**
 * Why suppression was or wasn't applied to a generation. Threaded into the
 * `done` event → usage store → GenerationReceipt (mirrors KvReuseTelemetry)
 * so "was the guard active on this turn?" is answerable from diagnostics.
 */
export type CjkSuppressionReason =
  | 'applied'
  /** The loaded model's profile did not opt into suppression. */
  | 'disabled'
  /** Prompt-side text (system/user) already contains CJK script. */
  | 'cjk-conversation'
  /** A user turn explicitly asks for CJK output (translation frame / script name). */
  | 'cjk-language-request'
  /** The vocab scan found no CJK tokens (unexpected for a multilingual vocab). */
  | 'scan-empty'
  /** The vocab scan failed — suppression unavailable, generation proceeds unguarded. */
  | 'scan-failed';

export type CjkSuppressionTelemetry = {
  /** Whether the loaded model opted into suppression. */
  enabled: boolean;
  /** Whether `suppress_tokens` was applied to this generation. */
  applied: boolean;
  reason: CjkSuppressionReason;
  /** Number of vocab token ids banned (0 when not applied). */
  bannedTokenCount: number;
  /** Vocab scan duration in ms (present once the scan has settled). */
  scanMs?: number;
};

// ─── Conversation gate ──────────────────────────────────────────────────────

/**
 * Names of CJK writing systems. Mentioning one is treated as an explicit
 * request for CJK output ("what's the kanji for water?") — no frame needed.
 */
const CJK_SCRIPT_NAME_RE = /\b(?:kanji|hanzi|hiragana|katakana|hangul|furigana)\b/i;

/**
 * Explicit translation/phrasing frame: a verb-ish head, then "in/into/to
 * <CJK language>" with the language name in TERMINAL position (end of
 * clause/line, or followed by "characters/script/writing"). The terminal
 * anchor is what keeps "the biggest city in chinese history" from matching —
 * topical mentions of a language are NOT requests for CJK output.
 */
// The trailing character class is terminal punctuation INCLUDING the curly
// double/single closing quotes (”’) — they look like encoding artifacts in a
// diff but are deliberate literals.
const CJK_TRANSLATION_FRAME_RE =
  /\b(?:say|says|said|write|writes|written|spell|spelled|spelt|translate[ds]?|translating|translation|express|expressed|call|called|pronounce|pronounced|mean|means|what(?:'s| is| are| was)?)\b[^.?!\n]{0,80}?\b(?:in|into|to)\s+(?:chinese|mandarin|cantonese|japanese|korean)(?:\s+please)?\s*(?:characters?\b|script\b|writing\b|[.?!,;:)"'”’]|$)/im;

export type CjkSuppressionDecision = {
  suppress: boolean;
  reason: Extract<CjkSuppressionReason, 'applied' | 'cjk-conversation' | 'cjk-language-request'>;
};

/**
 * The conversation gate: should this generation suppress CJK tokens?
 * Pure over the full message list the worker receives (history rides every
 * turn, so an escape granted by an earlier user turn stays active for the
 * whole conversation).
 */
export function decideCjkSuppression(
  messages: readonly PromptMessage[],
): CjkSuppressionDecision {
  const promptSide = messages
    .filter((m) => m.role !== 'assistant')
    .map((m) => m.content)
    .join('\n');

  if (hasCjkScript(promptSide)) {
    return { suppress: false, reason: 'cjk-conversation' };
  }

  const userSide = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');

  if (CJK_SCRIPT_NAME_RE.test(userSide) || CJK_TRANSLATION_FRAME_RE.test(userSide)) {
    return { suppress: false, reason: 'cjk-language-request' };
  }

  return { suppress: true, reason: 'applied' };
}

// ─── Vocab scan ─────────────────────────────────────────────────────────────

/** Ids decoded per chunk before yielding the thread (see `collectCjkTokenIds`). */
const SCAN_CHUNK_SIZE = 8192;

/**
 * Scan token ids `0..vocabSize-1`, returning every id whose decoded text
 * contains CJK script.
 *
 * Partial-byte BPE tokens decode to U+FFFD replacement characters — outside
 * every CJK range — so they are never banned: emoji and other multi-byte
 * sequences composed from byte-level tokens stay generatable. In practice the
 * leak class is single high-probability whole-CJK tokens, which this catches.
 *
 * The loop yields between chunks (default: a macrotask) so a `generate`
 * message arriving mid-scan isn't blocked behind the full vocab walk. Per-id
 * decode failures are skipped — an undecodable id can't render as CJK.
 */
export async function collectCjkTokenIds(
  decodeToken: (id: number) => string,
  vocabSize: number,
  yieldBetweenChunks: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 0)),
): Promise<number[]> {
  const ids: number[] = [];
  for (let start = 0; start < vocabSize; start += SCAN_CHUNK_SIZE) {
    const end = Math.min(start + SCAN_CHUNK_SIZE, vocabSize);
    for (let id = start; id < end; id++) {
      try {
        if (hasCjkScript(decodeToken(id))) {
          ids.push(id);
        }
      } catch {
        // Undecodable id — skip; it cannot render as CJK.
      }
    }
    if (end < vocabSize) {
      await yieldBetweenChunks();
    }
  }
  return ids;
}

// ─── Scan lifecycle handle ──────────────────────────────────────────────────

export type CjkTokenScan = {
  /** Resolves when the scan settles (success or failure) — never rejects. */
  ready: Promise<void>;
  /** Banned ids; null until ready, stays null on failure. */
  ids: number[] | null;
  /** Scan duration ms; null until ready. */
  scanMs: number | null;
  /** True when the scan threw (suppression unavailable for this load). */
  failed: boolean;
};

/**
 * Kick off the vocab scan and return a handle the worker stores next to the
 * loaded model. Callers `await handle.ready` only when a generation actually
 * needs the ids (typically already settled — the scan runs in the dead time
 * between model-ready and the first user message).
 */
export function startCjkTokenScan(
  decodeToken: (id: number) => string,
  vocabSize: number,
  now: () => number = () => Date.now(),
): CjkTokenScan {
  const startedAt = now();
  const handle: CjkTokenScan = {
    ready: Promise.resolve(),
    ids: null,
    scanMs: null,
    failed: false,
  };
  handle.ready = collectCjkTokenIds(decodeToken, vocabSize)
    .then((ids) => {
      handle.ids = ids;
      handle.scanMs = now() - startedAt;
    })
    .catch(() => {
      // Defensive: collectCjkTokenIds swallows per-id decode throws, so this
      // branch is unreachable today — it guards future refactors of the scan
      // (the worker treats `failed` as "proceed unguarded", never fatal).
      handle.failed = true;
      handle.scanMs = now() - startedAt;
    });
  return handle;
}
