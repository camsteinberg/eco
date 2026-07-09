// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { toTransformersGenerateArgs } from '../transformers-generate-args';
import type { WorkerGenerateOptions } from '../transformers-adapter';

const DEFAULTS = { maxTokens: 512 } as const;

describe('toTransformersGenerateArgs', () => {
  it('emits only max_new_tokens + do_sample + temperature when no sampling fields are present', () => {
    const args = toTransformersGenerateArgs({ maxTokens: 128, temperature: 0.7 }, DEFAULTS);
    expect(args).toEqual({
      max_new_tokens: 128,
      do_sample: true,
      temperature: 0.7,
    });
    // No sampling keys leaked in.
    expect('top_p' in args).toBe(false);
    expect('top_k' in args).toBe(false);
    expect('repetition_penalty' in args).toBe(false);
    expect('no_repeat_ngram_size' in args).toBe(false);
  });

  it('forwards all four sampling fields under the confirmed TJS param names when present', () => {
    const options: WorkerGenerateOptions = {
      maxTokens: 256,
      temperature: 0.6,
      topP: 0.95,
      topK: 40,
      repetitionPenalty: 1.1,
      noRepeatNgramSize: 3,
    };
    const args = toTransformersGenerateArgs(options, DEFAULTS);
    expect(args).toEqual({
      max_new_tokens: 256,
      do_sample: true,
      temperature: 0.6,
      top_p: 0.95,
      top_k: 40,
      repetition_penalty: 1.1,
      no_repeat_ngram_size: 3,
    });
  });

  it('sets do_sample false at temperature 0 (greedy) and keeps temperature in args', () => {
    const args = toTransformersGenerateArgs({ maxTokens: 64, temperature: 0 }, DEFAULTS);
    expect(args.do_sample).toBe(false);
    expect(args.temperature).toBe(0);
    expect(args.max_new_tokens).toBe(64);
  });

  it('sets do_sample true for any temperature greater than 0', () => {
    const args = toTransformersGenerateArgs({ temperature: 0.01 }, DEFAULTS);
    expect(args.do_sample).toBe(true);
  });

  it('applies defaults when options is undefined (default maxTokens + 0.7 temp, do_sample greedy)', () => {
    // Preserves the original worker semantics exactly: do_sample reads
    // `temperature ?? 0` (→ greedy when omitted), while the temperature ARG
    // itself defaults to 0.7. The asymmetry is intentional and inherited.
    const args = toTransformersGenerateArgs(undefined, DEFAULTS);
    expect(args).toEqual({
      max_new_tokens: 512,
      do_sample: false,
      temperature: 0.7,
    });
  });

  it('uses the default maxTokens when maxTokens is omitted', () => {
    const args = toTransformersGenerateArgs({ temperature: 0.5 }, { maxTokens: 999 });
    expect(args.max_new_tokens).toBe(999);
  });

  it('defaults the temperature ARG to 0.7 but leaves do_sample greedy when temperature is omitted', () => {
    // do_sample uses `temperature ?? 0`, so an omitted temperature stays
    // greedy (false) even though the temperature arg itself is 0.7.
    const args = toTransformersGenerateArgs({ maxTokens: 100 }, DEFAULTS);
    expect(args.temperature).toBe(0.7);
    expect(args.do_sample).toBe(false);
  });

  it('omits sampling keys entirely when their source fields are null (never emits undefined)', () => {
    const options = {
      maxTokens: 100,
      temperature: 0.7,
      topP: null,
      topK: null,
      repetitionPenalty: null,
      noRepeatNgramSize: null,
    } as unknown as WorkerGenerateOptions;
    const args = toTransformersGenerateArgs(options, DEFAULTS);
    expect('top_p' in args).toBe(false);
    expect('top_k' in args).toBe(false);
    expect('repetition_penalty' in args).toBe(false);
    expect('no_repeat_ngram_size' in args).toBe(false);
    // The sampling keys are absent (not present-with-undefined), so only the
    // three baseline keys remain.
    expect(Object.keys(args).sort()).toEqual(['do_sample', 'max_new_tokens', 'temperature']);
  });

  it('forwards each sampling field independently (partial profile)', () => {
    const args = toTransformersGenerateArgs(
      { temperature: 0.7, topP: 0.9, repetitionPenalty: 1.05 },
      DEFAULTS,
    );
    expect(args.top_p).toBe(0.9);
    expect(args.repetition_penalty).toBe(1.05);
    expect('top_k' in args).toBe(false);
    expect('no_repeat_ngram_size' in args).toBe(false);
  });

  it('allows top_k of 0 through (0 is a valid value, not absent)', () => {
    const args = toTransformersGenerateArgs({ temperature: 0.7, topK: 0 }, DEFAULTS);
    expect(args.top_k).toBe(0);
  });
});
