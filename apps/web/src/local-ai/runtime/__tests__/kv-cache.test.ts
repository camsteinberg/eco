// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  buildKvReuseReport,
  decideKvReuse,
  divergenceWindow,
  spliceOnTextPrefix,
  longestCommonPrefixLen,
} from '../kv-cache';
import type { TextPrefixSplice } from '../kv-cache';

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

describe('divergenceWindow', () => {
  // A decode that renders each id as its own bracketed token, so the window's
  // text shows exactly which ids were included.
  const decode = (ids: readonly number[]): string => ids.map((id) => `[${String(id)}]`).join('');

  it('returns the ids and text on both sides of the divergence point', () => {
    const cached = [1, 2, 3, 7, 8];
    const next = [1, 2, 3, 4, 5, 6];
    const w = divergenceWindow(cached, next, 3, decode, { before: 2, after: 2 });
    expect(w).toEqual({
      at: 3,
      cachedIds: [2, 3, 7, 8],
      nextIds: [2, 3, 4, 5],
      cached: '[2][3][7][8]',
      next: '[2][3][4][5]',
    });
  });

  it('clamps the window at the start of the sequences', () => {
    const w = divergenceWindow([9, 9], [1, 2, 3], 0, decode, { before: 8, after: 1 });
    expect(w.cachedIds).toEqual([9]);
    expect(w.nextIds).toEqual([1]);
  });

  it('clamps the window at the end of the shorter sequence', () => {
    const w = divergenceWindow([1, 2, 5], [1, 2, 3, 4, 6, 7], 2, decode, { before: 1, after: 16 });
    expect(w.cachedIds).toEqual([2, 5]);
    expect(w.nextIds).toEqual([2, 3, 4, 6, 7]);
  });

  it('defaults to 8 tokens before and 16 after', () => {
    const cached = Array.from({ length: 40 }, (_, i) => i);
    const next = [...cached.slice(0, 20), ...Array.from({ length: 30 }, (_, i) => 100 + i)];
    const w = divergenceWindow(cached, next, 20, decode);
    expect(w.cachedIds).toEqual(cached.slice(12, 36));
    expect(w.nextIds).toEqual(next.slice(12, 36));
  });
});

// ─── spliceOnTextPrefix ──────────────────────────────────────────────────────

/**
 * A fake tokenizer that models the defect this splice exists to fix.
 *
 * Vocabulary: every word is its own token, EXCEPT that the pair "very good"
 * merges into a single token when re-encoded from text — while a model
 * generating one token at a time emits "very" and "good" separately. That is
 * the tokenizer-merge asymmetry measured on LFM2-2.6B: identical text, fewer
 * ids on the re-encode, so the cached sequence stops being a prefix.
 */
const BOS = 1;
const VOCAB: Record<string, number> = {
  '<|startoftext|>': BOS,
  hello: 10,
  world: 11,
  very: 12,
  good: 13,
  'very good': 14,
  next: 15,
  turn: 16,
};
const REVERSE = new Map(Object.entries(VOCAB).map(([text, id]) => [id, text]));

/** Encode by greedy longest-match over space-separated words. */
function fakeEncode(text: string): number[] {
  const words = text.split(' ').filter((w) => w.length > 0);
  const ids: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? '';
    const nextWord = words[i + 1];
    const pairId = nextWord === undefined ? undefined : VOCAB[`${word} ${nextWord}`];
    if (pairId !== undefined) {
      ids.push(pairId);
      i++;
      continue;
    }
    const id = VOCAB[word];
    if (id === undefined) throw new Error(`unknown word: ${word}`);
    ids.push(id);
  }
  return ids;
}

/** Unwrap a result the test expects to be a splice, without a non-null assert. */
function splicedIds(out: TextPrefixSplice): number[] {
  if (!out.spliced) throw new Error('expected a splice');
  return out.ids;
}

function fakeDecode(ids: readonly number[]): string {
  return ids.map((id) => REVERSE.get(id) ?? '?').join(' ');
}

const tokenizeTail = (tail: string): Promise<readonly number[]> => Promise.resolve(fakeEncode(tail));

describe('spliceOnTextPrefix', () => {
  it('appends the tail ids when the render extends the cached text', async () => {
    // The cache holds ids as GENERATED: "very" and "good" separately.
    const cachedIds = [BOS, 10, 12, 13];
    const cachedText = fakeDecode(cachedIds); // '<|startoftext|> hello very good'
    const renderedText = `${cachedText} next turn`;

    const out = await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail });

    expect(out).toEqual({ spliced: true, ids: [BOS, 10, 12, 13, 15, 16] });
  });

  it('keeps the cache a strict prefix where a full re-tokenization would not', async () => {
    // The defect, end to end: re-encoding the whole render merges "very good"
    // into one token, so the cached ids are NOT a prefix of it and the gate
    // reports a miss even though nothing was evicted. The splice avoids it.
    const cachedIds = [BOS, 10, 12, 13];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = `${cachedText} next turn`;

    const reTokenized = fakeEncode(renderedText);
    expect(reTokenized.length).toBeLessThan(cachedIds.length + 2);
    expect(decideKvReuse(cachedIds, reTokenized).reuse).toBe(false);

    const out = await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail });
    expect(out.spliced).toBe(true);
    expect(decideKvReuse(cachedIds, splicedIds(out))).toEqual({
      reuse: true,
      cachedLen: 4,
      newTokens: 2,
    });
  });

  it('produces ids whose decode equals the full rendered text', async () => {
    const cachedIds = [BOS, 10, 12, 13];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = `${cachedText} next turn`;

    const out = await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail });

    expect(out.spliced).toBe(true);
    expect(fakeDecode(splicedIds(out))).toBe(renderedText);
  });

  it('carries the BOS through unchanged when both sides open with it', async () => {
    const cachedIds = [BOS, 10];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = `${cachedText} world`;

    const out = await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail });

    expect(out.spliced).toBe(true);
    expect(splicedIds(out)[0]).toBe(BOS);
    expect(fakeDecode(splicedIds(out)).startsWith('<|startoftext|>')).toBe(true);
  });

  it('falls back when the cached ids open with BOS but the render does not', async () => {
    // Not a crash: a render lacking the leading BOS simply is not an extension
    // of the cached text, so the caller tokenizes the whole thing.
    const cachedIds = [BOS, 10];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = 'hello world';

    expect(
      await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back on an edit — the render diverges inside the cached span', async () => {
    const cachedIds = [BOS, 10, 11];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = '<|startoftext|> hello next turn';

    expect(
      await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back on a regenerate — the render is shorter than the cached text', async () => {
    const cachedIds = [BOS, 10, 11, 15];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = '<|startoftext|> hello world';

    expect(
      await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back on a moved context window — the render drops the cached head', async () => {
    const cachedIds = [BOS, 10, 11];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = '<|startoftext|> world next turn';

    expect(
      await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back on a model switch — an empty cache has nothing to splice onto', async () => {
    expect(
      await spliceOnTextPrefix({
        cachedIds: [],
        cachedText: '',
        renderedText: '<|startoftext|> hello world',
        tokenizeTail,
      }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back when a filtered reply makes the stored text differ from what was generated', async () => {
    // The reply was generated as "hello very good" but stored/re-rendered
    // without the filtered span, so the render is not an extension.
    const cachedIds = [BOS, 10, 12, 13];
    const cachedText = fakeDecode(cachedIds);
    const renderedText = '<|startoftext|> hello next turn';

    expect(
      await spliceOnTextPrefix({ cachedIds, cachedText, renderedText, tokenizeTail }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back when the decode of the cached ids is empty', async () => {
    expect(
      await spliceOnTextPrefix({
        cachedIds: [BOS, 10],
        cachedText: '',
        renderedText: '<|startoftext|> hello world',
        tokenizeTail,
      }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back when the render equals the cached text exactly (no tail)', async () => {
    // Nothing new to generate — a real equal-or-shorter miss, not a splice.
    const cachedIds = [BOS, 10, 11];
    const cachedText = fakeDecode(cachedIds);

    expect(
      await spliceOnTextPrefix({
        cachedIds,
        cachedText,
        renderedText: cachedText,
        tokenizeTail,
      }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('falls back when the tail tokenizes to nothing', async () => {
    const cachedIds = [BOS, 10];
    const cachedText = fakeDecode(cachedIds);

    expect(
      await spliceOnTextPrefix({
        cachedIds,
        cachedText,
        renderedText: `${cachedText}   `,
        tokenizeTail,
      }),
    ).toEqual({ spliced: false, ids: null });
  });

  it('does not mutate the cached ids it was given', async () => {
    const cachedIds = [BOS, 10];
    const cachedText = fakeDecode(cachedIds);

    await spliceOnTextPrefix({
      cachedIds,
      cachedText,
      renderedText: `${cachedText} next turn`,
      tokenizeTail,
    });

    expect(cachedIds).toEqual([BOS, 10]);
  });
});
