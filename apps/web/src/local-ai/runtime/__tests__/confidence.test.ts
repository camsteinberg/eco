// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest';
import {
  logSoftmax,
  entropyFromLogProbs,
  argmax,
  ConfidenceAccumulator,
} from '../confidence';

// ─── logSoftmax ────────────────────────────────────────────────────────────

describe('logSoftmax', () => {
  it('sums to 1 in probability space', () => {
    const logits = new Float32Array([1, 2, 3, 4]);
    const out = new Float32Array(4);
    logSoftmax(logits, out);
    const sumProb = Array.from(out).reduce((s, lp) => s + Math.exp(lp), 0);
    expect(sumProb).toBeCloseTo(1.0, 6);
  });

  it('preserves relative ordering', () => {
    const logits = new Float32Array([10, 5, 8]);
    const out = new Float32Array(3);
    logSoftmax(logits, out);
    expect(out[0]!).toBeGreaterThan(out[2]!);
    expect(out[2]!).toBeGreaterThan(out[1]!);
  });

  it('handles uniform logits (all equal)', () => {
    const n = 100;
    const logits = new Float32Array(n).fill(5.0);
    const out = new Float32Array(n);
    logSoftmax(logits, out);
    const expected = -Math.log(n);
    for (let i = 0; i < n; i++) {
      expect(out[i]!).toBeCloseTo(expected, 5);
    }
  });

  it('can write in-place (out aliases logits)', () => {
    const logits = new Float32Array([1, 2, 3]);
    logSoftmax(logits, logits);
    const sumProb = Array.from(logits).reduce((s, lp) => s + Math.exp(lp), 0);
    expect(sumProb).toBeCloseTo(1.0, 6);
  });
});

// ─── entropyFromLogProbs ───────────────────────────────────────────────────

describe('entropyFromLogProbs', () => {
  it('uniform distribution: entropy = ln(V)', () => {
    const v = 50;
    const logProbs = new Float32Array(v).fill(-Math.log(v));
    const h = entropyFromLogProbs(logProbs);
    expect(h).toBeCloseTo(Math.log(v), 5);
  });

  it('one-hot distribution: entropy = 0', () => {
    // p = [1, 0, 0, ...] → logp = [0, -Inf, -Inf, ...]
    const v = 10;
    const logProbs = new Float32Array(v).fill(-Infinity);
    logProbs[0] = 0; // log(1) = 0
    const h = entropyFromLogProbs(logProbs);
    expect(h).toBeCloseTo(0, 10);
  });

  it('entropy is non-negative', () => {
    const logits = new Float32Array([3, 1, 0.5, -2]);
    const out = new Float32Array(4);
    logSoftmax(logits, out);
    expect(entropyFromLogProbs(out)).toBeGreaterThanOrEqual(0);
  });
});

// ─── argmax ────────────────────────────────────────────────────────────────

describe('argmax', () => {
  it('returns the index of the maximum', () => {
    expect(argmax(new Float32Array([1, 5, 3]))).toBe(1);
  });

  it('returns first index on ties', () => {
    expect(argmax(new Float32Array([7, 7, 7]))).toBe(0);
  });
});

// ─── ConfidenceAccumulator ─────────────────────────────────────────────────

describe('ConfidenceAccumulator', () => {
  it('returns null when no steps recorded', () => {
    const acc = new ConfidenceAccumulator();
    expect(acc.summarize(true)).toBeNull();
  });

  it('tracks single step correctly', () => {
    const acc = new ConfidenceAccumulator();
    // One-hot-ish: token 0 has very high logit
    const logits = new Float32Array([100, 0, 0, 0]);
    acc.recordStep(logits);
    const summary = acc.summarize(true);
    expect(summary).not.toBeNull();
    expect(summary!.steps).toBe(1);
    expect(summary!.minAt).toBe(0);
    expect(summary!.maxEntropyAt).toBe(0);
    expect(summary!.greedy).toBe(true);
    // Top-1 logprob should be very close to 0 (log(1))
    expect(summary!.minTop1LogProb).toBeCloseTo(0, 2);
    expect(summary!.meanTop1LogProb).toBeCloseTo(0, 2);
    // Entropy should be very close to 0
    expect(summary!.meanEntropy).toBeCloseTo(0, 2);
    expect(summary!.maxEntropy).toBeCloseTo(0, 2);
  });

  it('tracks min/max indices across multiple steps', () => {
    const acc = new ConfidenceAccumulator();
    // Step 0: confident (one-hot-ish)
    acc.recordStep(new Float32Array([100, 0, 0, 0]));
    // Step 1: uncertain (uniform-ish)
    acc.recordStep(new Float32Array([1, 1, 1, 1]));
    // Step 2: medium confidence
    acc.recordStep(new Float32Array([5, 0, 0, 0]));

    const summary = acc.summarize(false);
    expect(summary).not.toBeNull();
    expect(summary!.steps).toBe(3);
    expect(summary!.greedy).toBe(false);
    // Min top-1 logprob should be at step 1 (most uncertain)
    expect(summary!.minAt).toBe(1);
    // Max entropy should also be at step 1
    expect(summary!.maxEntropyAt).toBe(1);
    // Uniform over 4 tokens: entropy = ln(4)
    expect(summary!.maxEntropy).toBeCloseTo(Math.log(4), 2);
  });

  it('mean top1LogProb is arithmetic mean', () => {
    const acc = new ConfidenceAccumulator();
    // Two steps with known logprobs
    // Step 0: one-hot → top1 logprob ≈ 0
    acc.recordStep(new Float32Array([100, -100, -100]));
    // Step 1: uniform → top1 logprob ≈ -ln(3)
    acc.recordStep(new Float32Array([0, 0, 0]));

    const summary = acc.summarize(true);
    expect(summary).not.toBeNull();
    const expectedMean = (0 + (-Math.log(3))) / 2;
    expect(summary!.meanTop1LogProb).toBeCloseTo(expectedMean, 2);
  });

  it('handles growing vocab size (buffer reuse)', () => {
    const acc = new ConfidenceAccumulator();
    acc.recordStep(new Float32Array([1, 2]));
    // Larger vocab on next step — buffer should grow
    acc.recordStep(new Float32Array([1, 2, 3, 4, 5]));
    const summary = acc.summarize(true);
    expect(summary).not.toBeNull();
    expect(summary!.steps).toBe(2);
  });
});
