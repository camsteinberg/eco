// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { PREFILL_CHUNK_TOKENS, planPrefillChunks } from '../prefill-plan';

describe('planPrefillChunks', () => {
  it('returns an empty plan when there is no delta to prefill', () => {
    // Cache already covers the whole prompt: nothing for the chunk loop, and
    // generate still has its reserved tail.
    expect(planPrefillChunks(10, 10, 4)).toEqual([]);
  });

  it('returns an empty plan when the delta fits entirely in the reserved tail', () => {
    // One new token — it must be left to generate, so the loop has no work.
    expect(planPrefillChunks(10, 11, 4)).toEqual([]);
  });

  it('splits an exact multiple into equal chunks', () => {
    expect(planPrefillChunks(0, 13, 4)).toEqual([
      { start: 0, end: 4 },
      { start: 4, end: 8 },
      { start: 8, end: 12 },
    ]);
  });

  it('leaves the remainder as a short final chunk', () => {
    expect(planPrefillChunks(0, 12, 5)).toEqual([
      { start: 0, end: 5 },
      { start: 5, end: 10 },
      { start: 10, end: 11 },
    ]);
  });

  it('stops exactly tailKeep tokens short of the prompt length', () => {
    // The tail is what generate forwards; the plan must never claim it, or
    // generate has nothing to run and returns no sequences.
    const plan = planPrefillChunks(0, 10, 3, 4);
    expect(plan.at(-1)?.end).toBe(6);
    expect(plan).toEqual([
      { start: 0, end: 3 },
      { start: 3, end: 6 },
    ]);
  });

  it('plans only the delta when a cache is already held (reuse path)', () => {
    expect(planPrefillChunks(100, 110, 4)).toEqual([
      { start: 100, end: 104 },
      { start: 104, end: 108 },
      { start: 108, end: 109 },
    ]);
  });

  it('returns an empty plan when chunking is disabled (the control arm)', () => {
    expect(planPrefillChunks(0, 1000, 0)).toEqual([]);
    expect(planPrefillChunks(0, 1000, -1)).toEqual([]);
  });

  it('treats a tailKeep of zero as prefilling the whole delta', () => {
    expect(planPrefillChunks(0, 4, 2, 0)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('covers the full range contiguously with no gaps or overlaps', () => {
    const plan = planPrefillChunks(7, 97, 13);
    expect(plan[0]?.start).toBe(7);
    expect(plan.at(-1)?.end).toBe(96);
    for (let i = 1; i < plan.length; i += 1) {
      expect(plan[i]!.start).toBe(plan[i - 1]!.end);
    }
  });

  it('exports a positive default chunk size', () => {
    expect(PREFILL_CHUNK_TOKENS).toBeGreaterThan(0);
  });
});
