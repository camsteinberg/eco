// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Pure mapping from Eco's `WorkerGenerateOptions` (the structured-cloneable
 * subset of `GenerateOptions` that crosses the postMessage boundary) to the
 * argument object Transformers.js `model.generate(...)` accepts.
 *
 * This lives in a SEPARATE module from the worker on purpose: the worker
 * imports `@huggingface/transformers` and so cannot run under vitest/jsdom
 * (no Worker context, no real WebGPU). This file imports NOTHING that touches
 * TJS or the DOM, so the mapping is fully unit-testable.
 *
 * Param names are confirmed against Transformers.js v4 (Context7,
 * 2026-06-05): `max_new_tokens`, `do_sample`, `temperature`, `top_p`,
 * `top_k`, `repetition_penalty`, `no_repeat_ngram_size` — all snake_case,
 * all accepted directly by `GenerationConfig`. Eco previously built rich
 * per-model sampling profiles (top_p/top_k/repetition_penalty/
 * no_repeat_ngram_size) that were SEVERED here — only max_new_tokens,
 * do_sample and temperature were forwarded. This module is what makes the
 * full profile live.
 */

import type { WorkerGenerateOptions } from './transformers-adapter';

/**
 * Build the TJS `generate()` sampling args from worker options.
 *
 * Semantics preserved from the prior inline call:
 *   - `max_new_tokens = options.maxTokens ?? defaults.maxTokens`
 *   - `temperature   = options.temperature ?? 0.7`
 *   - `do_sample     = (options.temperature ?? 0) > 0`  (greedy at temp 0)
 *
 * The four sampling keys (top_p / top_k / repetition_penalty /
 * no_repeat_ngram_size) are emitted ONLY when their source field is
 * non-null/non-undefined, so a greedy or unprofiled call stays clean and
 * lets TJS fall back to its own defaults rather than receiving `undefined`.
 */
export function toTransformersGenerateArgs(
  options: WorkerGenerateOptions | undefined,
  defaults: { maxTokens: number },
): Record<string, number | boolean> {
  const temperature = options?.temperature ?? 0.7;
  const args: Record<string, number | boolean> = {
    max_new_tokens: options?.maxTokens ?? defaults.maxTokens,
    do_sample: (options?.temperature ?? 0) > 0,
    temperature,
  };

  if (options?.topP != null) {
    args.top_p = options.topP;
  }
  if (options?.topK != null) {
    args.top_k = options.topK;
  }
  if (options?.repetitionPenalty != null) {
    args.repetition_penalty = options.repetitionPenalty;
  }
  if (options?.noRepeatNgramSize != null) {
    args.no_repeat_ngram_size = options.noRepeatNgramSize;
  }

  return args;
}
