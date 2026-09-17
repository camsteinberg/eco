// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Pure plan for a CHUNKED prefill.
 *
 * A single full prefill is one ORT forward pass over the whole prompt window,
 * and its peak allocation scales with that window. Measured on Safari 26.4
 * (s55, Eco Compact / Qwen3-0.6B): a 785-token single prefill took the
 * WebContent process from 6.6 GB to 12.5 GB *inside one forward pass*, and
 * Safari killed the tab at its 8,192 MB per-process limit. Chunking the
 * prefill bounds the per-pass allocation: each chunk is a forward pass over at
 * most `chunkSize` tokens that EXTENDS the KV cache, and `generate()` then
 * finishes from that cache.
 *
 * This module is the arithmetic only — which token ranges to run, in order. It
 * imports nothing (no `@huggingface/transformers`, no DOM), for the same
 * reason `kv-cache.ts` doesn't: the worker cannot run under vitest (no Worker
 * context, no real WebGPU), so the off-by-one-critical part lives here where
 * it is unit-testable.
 */

/** One chunk of the prefill: token range `[start, end)` of the full prompt. */
export type PrefillChunk = {
  start: number;
  end: number;
};

/**
 * Tokens per chunked prefill pass.
 *
 * PROVENANCE: **UNMEASURED** default. The motivating reading is the s55 Safari
 * number above (785 tokens in one pass = 5.9 GB of growth, killed at 8 GB);
 * 256 is a first cut chosen to be well under it while keeping the pass count
 * small enough that per-pass overhead stays in the noise. The chunk-size sweep
 * (128 / 256 / 512, footprint per chunk on Safari and cold-miss TTFT per tier
 * on Chrome) replaces this number with a measured one. Until then it is a
 * guess, and the harness param `eco-force-prefill-chunk` exists to sweep it
 * without a rebuild.
 *
 * It is deliberately NOT a catalog field: chunk size is a property of the
 * engine and the device's memory ceiling, not a description of a model. If a
 * per-model override is ever needed, `capabilities` in `local-ai/types.ts`
 * (next to `contextTokens`) is the right home.
 */
export const PREFILL_CHUNK_TOKENS = 256;

/**
 * Plan the chunked prefill for one turn.
 *
 * Covers `[cachedLen, promptLen - tailKeep)` — the tokens the cache does not
 * already hold, minus a tail left for `generate()` itself. That tail matters:
 * transformers.js slices `input_ids` down to the unprocessed tail whenever a
 * cache is present, so `generate()` must be left at least one real token to
 * forward, or it has nothing to run and never produces `sequences` /
 * `past_key_values`.
 *
 * @param cachedLen Tokens the held KV cache already covers (0 on a miss).
 * @param promptLen Full token length of this turn's render.
 * @param chunkSize Tokens per pass. `<= 0` means "no chunking" — an EMPTY
 *   plan, which is the control arm (the caller falls back to a single pass).
 * @param tailKeep Trailing tokens reserved for `generate()`.
 * @returns Chunks in ascending order; empty when there is nothing to prefill
 *   by hand (no delta, a delta that fits entirely in the reserved tail, or
 *   chunking disabled).
 */
export function planPrefillChunks(
  cachedLen: number,
  promptLen: number,
  chunkSize: number,
  tailKeep = 1,
): PrefillChunk[] {
  if (chunkSize <= 0) return [];
  const from = Math.max(0, cachedLen);
  const to = promptLen - Math.max(0, tailKeep);
  if (to <= from) return [];

  const chunks: PrefillChunk[] = [];
  for (let start = from; start < to; start += chunkSize) {
    chunks.push({ start, end: Math.min(start + chunkSize, to) });
  }
  return chunks;
}
