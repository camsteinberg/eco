// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import { buildKvReuseReport, decideKvReuse, longestCommonPrefixLen } from '../kv-cache';

describe('decideKvReuse', () => {
  it('returns no-cache when the cache is empty', () => {
    expect(decideKvReuse([], [1, 2, 3])).toEqual({
      reuse: false,
      reason: 'no-cache',
    });
  });

  it('returns no-cache when both inputs are empty', () => {
    // Empty cache is reported as no-cache before the length comparison.
    expect(decideKvReuse([], [])).toEqual({
      reuse: false,
      reason: 'no-cache',
    });
  });

  it('reuses when the cache is a strict prefix (cache shorter, all match)', () => {
    expect(decideKvReuse([1, 2, 3], [1, 2, 3, 4, 5])).toEqual({
      reuse: true,
      cachedLen: 3,
      newTokens: 2,
    });
  });

  it('does not reuse when the tokens diverge before the end of the cache', () => {
    // Divergence at index 1 (k < cachedLen) => not a prefix.
    expect(decideKvReuse([1, 9, 3], [1, 2, 3, 4])).toEqual({
      reuse: false,
      reason: 'not-strict-prefix',
    });
  });

  it('does not reuse when divergence happens at the very last cached index', () => {
    // Divergence at index 2 == cachedLen - 1.
    expect(decideKvReuse([1, 2, 9], [1, 2, 3, 4])).toEqual({
      reuse: false,
      reason: 'not-strict-prefix',
    });
  });

  it('reports equal-or-shorter when the cache is longer than the next render', () => {
    // A longer cache can never be a prefix of a shorter next render.
    expect(decideKvReuse([1, 2, 3, 4, 5], [1, 2, 3])).toEqual({
      reuse: false,
      reason: 'equal-or-shorter',
    });
  });

  it('reports equal-or-shorter when the cache equals the next render exactly', () => {
    // Identical arrays => zero new tokens to generate => not a usable reuse.
    expect(decideKvReuse([1, 2, 3], [1, 2, 3])).toEqual({
      reuse: false,
      reason: 'equal-or-shorter',
    });
  });

  it('reports equal-or-shorter BEFORE scanning when cachedLen >= nextLen, even on divergence', () => {
    // The length check is ordered ahead of the prefix scan: a same-length
    // array that also diverges is still reported as equal-or-shorter.
    expect(decideKvReuse([1, 2, 9], [1, 2, 3])).toEqual({
      reuse: false,
      reason: 'equal-or-shorter',
    });
  });

  it('reuses when the cache is exactly one token shorter and all match', () => {
    // Mirrors the real off-by-one between get_seq_length() and
    // sequences.length: a single new token MUST still reuse the cache.
    expect(decideKvReuse([1, 2, 3, 4], [1, 2, 3, 4, 5])).toEqual({
      reuse: true,
      cachedLen: 4,
      newTokens: 1,
    });
  });

  it('reuses a single-token cache that is a strict prefix', () => {
    expect(decideKvReuse([7], [7, 8])).toEqual({
      reuse: true,
      cachedLen: 1,
      newTokens: 1,
    });
  });

  it('handles a large cache that is a strict prefix in linear time', () => {
    const cached = Array.from({ length: 2000 }, (_, i) => i);
    const next = [...cached, 2000, 2001, 2002];
    expect(decideKvReuse(cached, next)).toEqual({
      reuse: true,
      cachedLen: 2000,
      newTokens: 3,
    });
  });

  it('handles a large cache that diverges near the end', () => {
    const cached = Array.from({ length: 2000 }, (_, i) => i);
    const next = Array.from({ length: 2100 }, (_, i) => i);
    next[1999] = -1; // flip the last cached token
    expect(decideKvReuse(cached, next)).toEqual({
      reuse: false,
      reason: 'not-strict-prefix',
    });
  });
});

describe('buildKvReuseReport', () => {
  it('reports a reuse with both lengths and no reason/divergence fields', () => {
    expect(buildKvReuseReport([1, 2, 3], [1, 2, 3, 4, 5])).toEqual({
      decision: 'reuse',
      cachedLen: 3,
      promptLen: 5,
    });
  });

  it('reports a no-cache miss without a divergence point', () => {
    expect(buildKvReuseReport([], [1, 2, 3])).toEqual({
      decision: 'miss',
      reason: 'no-cache',
      cachedLen: 0,
      promptLen: 3,
    });
  });

  it('reports an equal-or-shorter miss without a divergence point', () => {
    expect(buildKvReuseReport([1, 2, 3], [1, 2, 3])).toEqual({
      decision: 'miss',
      reason: 'equal-or-shorter',
      cachedLen: 3,
      promptLen: 3,
    });
  });

  it('reports a not-strict-prefix miss WITH the divergence point', () => {
    expect(buildKvReuseReport([1, 9, 3], [1, 2, 3, 4])).toEqual({
      decision: 'miss',
      reason: 'not-strict-prefix',
      cachedLen: 3,
      promptLen: 4,
      commonPrefixLen: 1,
    });
  });

  it('pinpoints a divergence at the last cached index', () => {
    expect(buildKvReuseReport([1, 2, 9], [1, 2, 3, 4])).toEqual({
      decision: 'miss',
      reason: 'not-strict-prefix',
      cachedLen: 3,
      promptLen: 4,
      commonPrefixLen: 2,
    });
  });

  it('pinpoints the think-asymmetry signature: divergence mid-way through a long cache', () => {
    // Shape of the Qwen3.5 failure: shared conversation prefix, then the cache
    // holds template-injected think tokens where the re-render holds the
    // stored answer — LCP lands well before the cache end.
    const sharedPrefix = Array.from({ length: 800 }, (_, i) => i);
    const cached = [...sharedPrefix, 151667, 198, 198, 151668]; // <think>-ish tail
    const next = [...sharedPrefix, 9906, 4435, 13, 151645, 198, 872]; // answer-ish tail
    expect(buildKvReuseReport(cached, next)).toEqual({
      decision: 'miss',
      reason: 'not-strict-prefix',
      cachedLen: 804,
      promptLen: 806,
      commonPrefixLen: 800,
    });
  });
});

describe('longestCommonPrefixLen', () => {
  it('returns 0 for two empty arrays', () => {
    expect(longestCommonPrefixLen([], [])).toBe(0);
  });

  it('returns 0 when either array is empty', () => {
    expect(longestCommonPrefixLen([], [1, 2, 3])).toBe(0);
    expect(longestCommonPrefixLen([1, 2, 3], [])).toBe(0);
  });

  it('returns the full length when one array is a prefix of the other', () => {
    expect(longestCommonPrefixLen([1, 2, 3], [1, 2, 3, 4, 5])).toBe(3);
    expect(longestCommonPrefixLen([1, 2, 3, 4, 5], [1, 2, 3])).toBe(3);
  });

  it('returns the full length for identical arrays', () => {
    expect(longestCommonPrefixLen([1, 2, 3], [1, 2, 3])).toBe(3);
  });

  it('returns the index of the first divergence for a partial match', () => {
    expect(longestCommonPrefixLen([1, 2, 9, 4], [1, 2, 3, 4])).toBe(2);
  });

  it('returns 0 when the arrays diverge at the first element', () => {
    expect(longestCommonPrefixLen([9, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('is linear and correct on large matching arrays', () => {
    const a = Array.from({ length: 2000 }, (_, i) => i);
    const b = [...a, 2000, 2001];
    expect(longestCommonPrefixLen(a, b)).toBe(2000);
  });
});
