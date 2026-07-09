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
};

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
