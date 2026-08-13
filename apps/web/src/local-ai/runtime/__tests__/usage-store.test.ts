// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetUsageStoreForTesting,
  getLastUsage,
  ranToCapFromUsage,
  setLastUsage,
} from '../usage-store';

afterEach(() => {
  _resetUsageStoreForTesting();
});

describe('usage-store', () => {
  it('round-trips the last usage, including maxInterTokenGapMs', () => {
    setLastUsage({ promptTokens: 10, completionTokens: 20, maxTokens: 512, maxInterTokenGapMs: 333 });
    expect(getLastUsage()).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      maxTokens: 512,
      maxInterTokenGapMs: 333,
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
