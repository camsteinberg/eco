// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Pure KV-cache reuse gate.
 *
 * Multi-turn chat re-tokenizes the WHOLE conversation each turn, so the
 * inference worker re-prefills every prior token before generating the
 * next reply (measured 5–8s TTFT mid-conversation). Reusing the previous
 * turn's KV cache skips that reprefill (~10–20× faster in a throwaway
 * spike) — but only when it is CORRECT to do so.
 *
 * Transformers.js v4 exposes a `past_key_values` INPUT (the decoder slices
 * `input_ids` against it) but NO truncation API, so reuse is all-or-nothing
 * per turn: it is valid iff the previously-cached token sequence is a STRICT
 * token-prefix of the new turn's tokenization. This module is that decision,
 * and only that decision.
 *
 * It lives in a SEPARATE module from the worker on purpose: the worker
 * imports `@huggingface/transformers` and cannot run under vitest/jsdom (no
 * Worker context, no real WebGPU). This file imports NOTHING that touches
 * TJS or the DOM — just array logic — so the correctness-critical core is
 * fully unit-testable. NEVER ship KV-cache reuse without a byte-identical
 * correctness gate; this is half of that gate.
 */

export type KvReuseDecision =
  | { reuse: true; cachedLen: number; newTokens: number }
  | { reuse: false; reason: 'no-cache' | 'not-strict-prefix' | 'equal-or-shorter' };

/**
 * Decide whether the cached KV state may be reused for the next render.
 *
 * Reuse iff `cachedTokenIds` is a STRICT prefix of `nextTokenIds`:
 *   - empty cache                      => no-cache (nothing to reuse)
 *   - cachedLen >= nextLen             => equal-or-shorter (an equal-length
 *     match leaves zero tokens to generate; a longer cache can't be a
 *     prefix). Reported BEFORE the scan, so a same-length divergence is
 *     still equal-or-shorter.
 *   - cachedLen < nextLen, all match   => reuse, generating nextLen-cachedLen
 *     new tokens
 *   - cachedLen < nextLen, diverges    => not-strict-prefix
 *
 * "Strict" matters: if the cache already covers the entire next render
 * there is nothing left to generate, so that is a miss, not a reuse.
 */
export function decideKvReuse(
  cachedTokenIds: readonly number[],
  nextTokenIds: readonly number[],
): KvReuseDecision {
  const cachedLen = cachedTokenIds.length;

  if (cachedLen === 0) {
    return { reuse: false, reason: 'no-cache' };
  }

  // Ordered ahead of the prefix scan: when the cache is as long as (or
  // longer than) the next render it cannot be a strict prefix, regardless
  // of content.
  if (cachedLen >= nextTokenIds.length) {
    return { reuse: false, reason: 'equal-or-shorter' };
  }

  // Linear scan over the cached span; a clear scan beats cleverness here.
  for (let i = 0; i < cachedLen; i++) {
    if (cachedTokenIds[i] !== nextTokenIds[i]) {
      return { reuse: false, reason: 'not-strict-prefix' };
    }
  }

  return { reuse: true, cachedLen, newTokens: nextTokenIds.length - cachedLen };
}

/**
 * Outward-facing reuse report for one generation.
 *
 * Built from a `KvReuseDecision` plus the divergence point on a
 * not-strict-prefix miss. The worker attaches this (with `cacheCommitted`,
 * see `KvReuseTelemetry`) to the `done` message so receipts/diagnostics can
 * answer "did this turn reprefill, and why?" without a debugger. The Qwen3.5
 * everyday-swap block (turn TTFT 5.9–7.0s vs LFM's 1.5s, 2026-06-11) was
 * invisible precisely because this signal stopped inside the worker.
 */
export type KvReuseReport = {
  decision: 'reuse' | 'miss';
  /** Present only on a miss. */
  reason?: 'no-cache' | 'not-strict-prefix' | 'equal-or-shorter';
  /** Cached token count at decision time (0 when no cache was held). */
  cachedLen: number;
  /** Full token length of this turn's render. */
  promptLen: number;
  /**
   * Where the cached sequence and the new render diverged — present only on
   * a not-strict-prefix miss (the one reason where "where?" is the question).
   */
  commonPrefixLen?: number;
  /**
   * The tokens on each side of the divergence, decoded — present only on a
   * not-strict-prefix miss. Answers "what differed?" where `commonPrefixLen`
   * answers "where?": a miss inside the previous reply (s39: the 2.6B missed
   * with headroom, common prefix 213 of 612) cannot be diagnosed from a
   * position alone. Attached by the worker, which owns the tokenizer.
   */
  divergence?: KvDivergenceWindow;
  /**
   * Whether this turn's token ids came from `spliceOnTextPrefix` (appended to
   * the ids the cache already held) rather than a fresh tokenization of the
   * whole render. Set by the worker, which owns the tokenizer;
   * `buildKvReuseReport` cannot know it. A miss with `spliced: false` on a turn
   * that evicted nothing is the tokenizer-merge signature the splice exists to
   * remove, so receipts need to show which path a turn took.
   */
  spliced?: boolean;
};

/** A short decoded window around a prefix divergence. */
export type KvDivergenceWindow = {
  /** Index of the first differing token (= `commonPrefixLen`). */
  at: number;
  cachedIds: number[];
  nextIds: number[];
  cached: string;
  next: string;
};

/**
 * Decode a window of tokens around the divergence point on both sequences.
 * Pure over a supplied `decode`, so the worker's tokenizer stays out of this
 * module. Window bounds clamp to each sequence's length.
 */
export function divergenceWindow(
  cachedTokenIds: readonly number[],
  nextTokenIds: readonly number[],
  at: number,
  decode: (ids: readonly number[]) => string,
  span: { before: number; after: number } = { before: 8, after: 16 },
): KvDivergenceWindow {
  const start = Math.max(0, at - span.before);
  const end = at + span.after;
  const cachedIds = cachedTokenIds.slice(start, end);
  const nextIds = nextTokenIds.slice(start, end);
  return { at, cachedIds, nextIds, cached: decode(cachedIds), next: decode(nextIds) };
}

/**
 * What actually crosses the worker boundary: the gate's report plus whether
 * the runtime RETURNED a cache for this generation. `cacheCommitted: false`
 * with a healthy decision is the signature of a runtime that never
 * round-trips `past_key_values` — distinct from a template-shaped prefix
 * miss, and otherwise indistinguishable from the outside.
 */
export type KvReuseTelemetry = KvReuseReport & { cacheCommitted: boolean };

/**
 * Build the outward report for one gate decision. Pure; the worker calls
 * this right after `decideKvReuse` with the same inputs.
 */
export function buildKvReuseReport(
  cachedTokenIds: readonly number[],
  nextTokenIds: readonly number[],
): KvReuseReport {
  const decision = decideKvReuse(cachedTokenIds, nextTokenIds);
  if (decision.reuse) {
    return {
      decision: 'reuse',
      cachedLen: cachedTokenIds.length,
      promptLen: nextTokenIds.length,
    };
  }
  return {
    decision: 'miss',
    reason: decision.reason,
    cachedLen: cachedTokenIds.length,
    promptLen: nextTokenIds.length,
    ...(decision.reason === 'not-strict-prefix'
      ? { commonPrefixLen: longestCommonPrefixLen(cachedTokenIds, nextTokenIds) }
      : {}),
  };
}

/**
 * Length of the longest common prefix of two token sequences.
 *
 * Diagnostics/logging helper for the worker — when reuse is declined, this
 * pinpoints where the two tokenizations diverged.
 */
export function longestCommonPrefixLen(a: readonly number[], b: readonly number[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) {
    i++;
  }
  return i;
}

/**
 * Splice this turn's token ids onto the ids the cache already holds, when the
 * new render is a TEXT prefix extension of the cached sequence.
 *
 * Why this exists (measured 2026-09-04, LFM2-2.6B, ten-turn chat, production
 * build): re-tokenizing the whole rendered transcript each turn is NOT
 * guaranteed to reproduce the ids the model actually generated. Re-encoding
 * the previous assistant reply from its TEXT, inside the full template render,
 * can merge differently than the ids the sampler emitted one at a time — same
 * text, fewer tokens. On a turn where nothing was evicted (identical window
 * start) the gate reported `miss/equal-or-shorter` at promptLen 2525 vs
 * cachedLen 2533 and the turn re-prefilled from scratch: 14.0s to first token.
 *
 * The fix is what every reference runtime does: APPEND to the ids you already
 * hold instead of re-tokenizing the transcript. If the decode of the cached
 * ids is a prefix of the new render's text, only the tail is tokenized and the
 * result is `cachedIds ++ tailIds` — byte-equivalent text, and a strict token
 * prefix by construction, so `decideKvReuse` reuses.
 *
 * Pure over the supplied `tokenizeTail`, so it unit-tests with a fake
 * tokenizer; the worker owns the real one.
 *
 * Refuses (and the caller falls back to tokenizing the whole render, keeping
 * today's miss reasons intact) whenever the premise does not hold:
 *   - no cached ids, or their decode is empty (a decode we cannot trust)
 *   - the render does not start with the cached text — edit, regenerate,
 *     model switch, a moved context window, or a filtered reply whose stored
 *     text differs from what was generated. Also covers a cached sequence that
 *     opens with BOS where the render does not.
 *   - the tail is empty, or tokenizes to nothing: there would be nothing new
 *     to generate, which is a real `equal-or-shorter` miss, not a splice.
 */
export type TextPrefixSplice =
  | { spliced: true; ids: number[] }
  | { spliced: false; ids: null };

export async function spliceOnTextPrefix(args: {
  cachedIds: readonly number[];
  cachedText: string;
  renderedText: string;
  tokenizeTail: (tail: string) => Promise<readonly number[]>;
}): Promise<TextPrefixSplice> {
  const { cachedIds, cachedText, renderedText, tokenizeTail } = args;

  if (cachedIds.length === 0 || cachedText.length === 0) {
    return { spliced: false, ids: null };
  }
  if (!renderedText.startsWith(cachedText)) {
    return { spliced: false, ids: null };
  }

  const tail = renderedText.slice(cachedText.length);
  if (tail.length === 0) {
    return { spliced: false, ids: null };
  }

  const tailIds = await tokenizeTail(tail);
  if (tailIds.length === 0) {
    return { spliced: false, ids: null };
  }

  return { spliced: true, ids: [...cachedIds, ...tailIds] };
}
