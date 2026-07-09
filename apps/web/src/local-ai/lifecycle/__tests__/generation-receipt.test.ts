// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWarnedMissingSubtle,
  clearGenerationReceipts,
  getReceiptByGenerationId,
  getRecentReceipts,
  hashSystemPrompt,
  MAX_RECEIPTS,
  recordGenerationReceipt,
  type GenerationReceipt,
} from '../generation-receipt';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeReceipt(overrides: Partial<GenerationReceipt> = {}): GenerationReceipt {
  return {
    generationId: overrides.generationId ?? `gen-${Math.random().toString(36).slice(2, 8)}`,
    modelId: 'local/phi3-mini-4k-q4f16',
    timestamp: Date.now(),
    templateName: null,
    systemPromptHash: 'abcd1234',
    samplingProfile: { temperature: 0.7, topP: 0.9 },
    promptTokens: 42,
    completionTokens: 10,
    durationMs: 350,
    status: 'complete',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('generation-receipt', () => {
  afterEach(() => {
    clearGenerationReceipts();
  });

  it('records a receipt and retrieves it via getRecentReceipts', () => {
    const receipt = makeReceipt({ generationId: 'g-1' });
    recordGenerationReceipt(receipt);

    const recent = getRecentReceipts(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.generationId).toBe('g-1');
  });

  it(`evicts the oldest entry after ${MAX_RECEIPTS} receipts`, () => {
    for (let i = 0; i < MAX_RECEIPTS + 1; i++) {
      recordGenerationReceipt(makeReceipt({ generationId: `g-${i}` }));
    }

    const all = getRecentReceipts(MAX_RECEIPTS + 10);
    expect(all).toHaveLength(MAX_RECEIPTS);

    // The very first receipt (g-0) should have been evicted.
    expect(all.find((r) => r.generationId === 'g-0')).toBeUndefined();
    // The second receipt (g-1) should still be present — it's the oldest survivor.
    expect(all.find((r) => r.generationId === 'g-1')).toBeDefined();
    // The newest receipt should be present.
    expect(all.find((r) => r.generationId === `g-${MAX_RECEIPTS}`)).toBeDefined();
  });

  it('returns receipts in newest-first order', () => {
    recordGenerationReceipt(makeReceipt({ generationId: 'first' }));
    recordGenerationReceipt(makeReceipt({ generationId: 'second' }));
    recordGenerationReceipt(makeReceipt({ generationId: 'third' }));

    const recent = getRecentReceipts();
    expect(recent[0]?.generationId).toBe('third');
    expect(recent[1]?.generationId).toBe('second');
    expect(recent[2]?.generationId).toBe('first');
  });

  it('clears all receipts', () => {
    recordGenerationReceipt(makeReceipt());
    recordGenerationReceipt(makeReceipt());
    expect(getRecentReceipts()).toHaveLength(2);

    clearGenerationReceipts();
    expect(getRecentReceipts()).toHaveLength(0);
  });

  it('returns a receipt by generationId, or null if not found', () => {
    const receipt = makeReceipt({ generationId: 'lookup-me' });
    recordGenerationReceipt(receipt);

    expect(getReceiptByGenerationId('lookup-me')).toEqual(receipt);
    expect(getReceiptByGenerationId('nonexistent')).toBeNull();
  });

  describe('hashSystemPrompt', () => {
    it('returns an 8-character hex string for a non-empty input', async () => {
      const hash = await hashSystemPrompt('You are a helpful assistant.');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('returns the same hash for the same input (deterministic)', async () => {
      const a = await hashSystemPrompt('identical prompt');
      const b = await hashSystemPrompt('identical prompt');
      expect(a).toBe(b);
    });

    it('returns different hashes for different inputs', async () => {
      const a = await hashSystemPrompt('prompt alpha');
      const b = await hashSystemPrompt('prompt beta');
      expect(a).not.toBe(b);
    });

    it('returns sentinel and warns once when crypto.subtle is unavailable', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      _resetWarnedMissingSubtle();

      const savedCrypto = globalThis.crypto;
      try {
        // Remove crypto.subtle entirely.
        Object.defineProperty(globalThis, 'crypto', {
          value: { subtle: undefined },
          configurable: true,
        });

        const a = await hashSystemPrompt('a');
        const b = await hashSystemPrompt('b');

        expect(a).toBe('00000000');
        expect(b).toBe('00000000');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('crypto.subtle unavailable'),
        );
      } finally {
        // Restore crypto so subsequent tests are unaffected.
        Object.defineProperty(globalThis, 'crypto', {
          value: savedCrypto,
          configurable: true,
        });
        _resetWarnedMissingSubtle();
        warnSpy.mockRestore();
      }
    });
  });

  it('does not throw when helpers are called in any order on empty state', () => {
    expect(getRecentReceipts()).toEqual([]);
    expect(getReceiptByGenerationId('anything')).toBeNull();
    clearGenerationReceipts();
    expect(getRecentReceipts(5)).toEqual([]);
  });
});
