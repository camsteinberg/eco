// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runs the observer through the REAL Transformers.js `LogitsProcessorList`,
 * which calls each processor as a function. A duck-typed `{ _call }` object
 * passes `push()` but throws on the first decode step — this test is the
 * one that would have caught that.
 */

import { LogitsProcessorList, Tensor } from '@huggingface/transformers';
import { describe, expect, it } from 'vitest';
import { ConfidenceAccumulator } from '../confidence';
import { ConfidenceObserver } from '../confidence-observer';

describe('ConfidenceObserver', () => {
  it('is invoked by LogitsProcessorList as a callable and records the step', () => {
    const acc = new ConfidenceAccumulator();
    const list = new LogitsProcessorList();
    list.push(new ConfidenceObserver(acc));

    const logits = new Tensor('float32', new Float32Array([1, 5, 2, 0]), [1, 4]);
    const out = list._call([[1n, 2n]], logits);

    expect(out).toBe(logits);
    expect(acc.summarize(true)?.steps).toBe(1);
  });

  it('skips non-float32 logits rather than mis-reading them', () => {
    const acc = new ConfidenceAccumulator();
    const list = new LogitsProcessorList();
    list.push(new ConfidenceObserver(acc));
    const logits = new Tensor('int64', new BigInt64Array([1n, 5n]), [1, 2]);
    expect(list._call([[1n]], logits)).toBe(logits);
    expect(acc.summarize(true)).toBeNull();
  });
});
