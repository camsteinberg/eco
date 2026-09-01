// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { ranToCapFromUsage, usageFromDone } from '../usage';

describe('usageFromDone', () => {
  it('carries every field the done event reports, plus the REQUESTED budget', () => {
    expect(
      usageFromDone(
        {
          kind: 'done',
          finishReason: 'length',
          promptTokens: 10,
          completionTokens: 20,
          maxInterTokenGapMs: 333,
        },
        512,
      ),
    ).toEqual({
      finishReason: 'length',
      promptTokens: 10,
      completionTokens: 20,
      maxTokens: 512,
      maxInterTokenGapMs: 333,
    });
  });

  it('keeps a null maxInterTokenGapMs (fewer than two tokens streamed) distinct from absent', () => {
    expect(usageFromDone({ kind: 'done', maxInterTokenGapMs: null }, 64).maxInterTokenGapMs)
      .toBeNull();
    expect('maxInterTokenGapMs' in usageFromDone({ kind: 'done' }, 64)).toBe(false);
  });

  it('still records the requested budget when the adapter emitted no done event', () => {
    // The pre-R4b shim's `!lastUsageRecorded` branch: downstream truncation and
    // ran-to-cap logic needs the cap even when the counts never arrived.
    expect(usageFromDone(null, 512)).toEqual({ maxTokens: 512 });
  });

  it('is empty when neither a done event nor a requested budget exists', () => {
    expect(usageFromDone(null, undefined)).toEqual({});
  });

  it('omits absent counts rather than defaulting them to zero', () => {
    expect(usageFromDone({ kind: 'done', completionTokens: 3 }, 128)).toEqual({
      completionTokens: 3,
      maxTokens: 128,
    });
  });
});

describe('ranToCapFromUsage (#28 ran-to-cap signal)', () => {
  it('is true when completionTokens reaches the cap exactly', () => {
    expect(ranToCapFromUsage({ completionTokens: 512, maxTokens: 512 })).toBe(true);
  });

  it('is true when completionTokens exceeds the cap', () => {
    expect(ranToCapFromUsage({ completionTokens: 513, maxTokens: 512 })).toBe(true);
  });

  it('is false when generation stopped short of the cap (natural stop)', () => {
    expect(ranToCapFromUsage({ completionTokens: 40, maxTokens: 512 })).toBe(false);
  });

  it('is false when the cap or count is unknown', () => {
    expect(ranToCapFromUsage({ completionTokens: 512 })).toBe(false);
    expect(ranToCapFromUsage({ maxTokens: 512 })).toBe(false);
    expect(ranToCapFromUsage(null)).toBe(false);
    expect(ranToCapFromUsage(undefined)).toBe(false);
  });

  it('is false for a non-positive cap (guards a divide-by-zero-shaped edge)', () => {
    expect(ranToCapFromUsage({ completionTokens: 0, maxTokens: 0 })).toBe(false);
  });

  it('does not treat the 0.95 possibly-truncated band as ran-to-cap (stricter than the UI heuristic)', () => {
    // 486 / 512 = 0.949... — below the exact cap, so ranToCap stays false even
    // though possiblyTruncated (0.95 * maxTokens) might flag it in the UI.
    expect(ranToCapFromUsage({ completionTokens: 486, maxTokens: 512 })).toBe(false);
  });
});
