// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PromptRepetitionPenalty } from '../webllm-prompt-penalty';

describe('PromptRepetitionPenalty', () => {
  it('divides a positive logit and multiplies a negative one (Hugging Face rule)', () => {
    const penalty = new PromptRepetitionPenalty(2, () => [0, 1]);
    const out = penalty.processLogits(new Float32Array([4, -4, 4]));
    expect(Array.from(out)).toEqual([2, -8, 4]);
  });

  it('penalises each id once, however often it appears', () => {
    const penalty = new PromptRepetitionPenalty(2, () => [1, 1, 1]);
    penalty.processSampledToken(1);
    const out = penalty.processLogits(new Float32Array([4, 4]));
    expect(Array.from(out)).toEqual([4, 2]);
  });

  it('covers the prompt ids and the tokens generated so far', () => {
    const penalty = new PromptRepetitionPenalty(2, () => [0]);
    penalty.processLogits(new Float32Array([4, 4, 4]));
    penalty.processSampledToken(2);
    const out = penalty.processLogits(new Float32Array([4, 4, 4]));
    expect(Array.from(out)).toEqual([2, 4, 2]);
  });

  it('reads the prompt once per round, on the first logits', () => {
    let reads = 0;
    const penalty = new PromptRepetitionPenalty(2, () => {
      reads++;
      return [0];
    });
    expect(reads).toBe(0);
    penalty.processLogits(new Float32Array([4]));
    penalty.processLogits(new Float32Array([4]));
    expect(reads).toBe(1);
  });

  it('forgets generated tokens on reset and reads the new prompt after it', () => {
    let prompt = [0];
    const penalty = new PromptRepetitionPenalty(2, () => prompt);
    penalty.processLogits(new Float32Array([4, 4, 4]));
    penalty.processSampledToken(1);
    penalty.resetState();
    prompt = [2];
    const out = penalty.processLogits(new Float32Array([4, 4, 4]));
    expect(Array.from(out)).toEqual([4, 4, 2]);
  });

  it('ignores ids outside the vocabulary', () => {
    const penalty = new PromptRepetitionPenalty(2, () => [-1, 5]);
    const out = penalty.processLogits(new Float32Array([4, 4]));
    expect(Array.from(out)).toEqual([4, 4]);
  });
});

// The adapter falls back SILENTLY to WebLLM's generated-only penalty if these
// private internals move, so a web-llm bump must fail here instead.
describe('the WebLLM internals the prompt-wide penalty relies on', () => {
  const source = readFileSync(createRequire(import.meta.url).resolve('@mlc-ai/web-llm'), 'utf8');

  it.each([
    'this.loadedModelIdToPipeline.set(',
    'this.logitProcessor = logitProcessor',
    'this.logitProcessor.processLogits(',
    '.processSampledToken(sampledToken)',
    '.resetState()',
    'this.conversation.getPromptArray(this.config)',
    'this.conversation.config.system_prefix_token_ids',
    'this.tokenizer.encode(',
  ])('the installed library still contains %s', (needle) => {
    expect(source.includes(needle), `missing from @mlc-ai/web-llm: ${needle}`).toBe(true);
  });
});
