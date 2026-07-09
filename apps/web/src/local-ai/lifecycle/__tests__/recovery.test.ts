// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSlotsForTesting,
  setSlot,
  setSlotStatus,
  setSlotStorage,
  type KeyValueStorage,
} from '../slots';
import {
  getLocalRecoveryCandidateIds,
  resolveReadyLocalRecoveryModelId,
} from '../recovery';

// ─── In-memory storage (same pattern as slots.test.ts) ──────────────────

class FakeStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  setSlotStorage(storage);
});

afterEach(() => {
  _resetSlotsForTesting();
});

// ─── Helpers ────────────────────────────────────────────────────────────

/** Bind a catalog model to a slot and mark it ready. */
function bindReady(slot: 'eco-fast' | 'eco-smart', modelId: string): void {
  setSlot(slot, modelId);
  setSlotStatus(slot, 'ready');
}

// ─── resolveReadyLocalRecoveryModelId ───────────────────────────────────

describe('resolveReadyLocalRecoveryModelId', () => {
  it('returns currentModelId when it maps to a ready slot', async () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: 'local/phi3-mini-4k-q4f16',
    });
    expect(result).toBe('local/phi3-mini-4k-q4f16');
  });

  it('returns null when currentModelId is not a ready slot model', async () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: 'local/bonsai-1.7b-q4',
    });
    expect(result).toBeNull();
  });

  it('returns null when currentModelId is set and its slot is not ready', async () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    // status defaults to 'preparing', not 'ready'
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: 'local/phi3-mini-4k-q4f16',
    });
    expect(result).toBeNull();
  });

  it('falls back to eco-fast when currentModelId is null', async () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBe('local/phi3-mini-4k-q4f16');
  });

  it('falls back to eco-smart when eco-fast is empty', async () => {
    bindReady('eco-smart', 'local/smollm2-1.7b-webllm-q4f16');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBe('local/smollm2-1.7b-webllm-q4f16');
  });

  it('returns null when all slots are empty', async () => {
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when all slots are in error state', async () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlotStatus('eco-fast', 'error');
    setSlot('eco-smart', 'local/smollm2-1.7b-webllm-q4f16');
    setSlotStatus('eco-smart', 'error');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBeNull();
  });

  it('prefers preferredModelId over slot-scan when currentModelId is null', async () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    bindReady('eco-smart', 'local/smollm2-1.7b-webllm-q4f16');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
      preferredModelId: 'local/smollm2-1.7b-webllm-q4f16',
    });
    expect(result).toBe('local/smollm2-1.7b-webllm-q4f16');
  });

  it('ignores preferredModelId when it is not a ready slot model', async () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
      preferredModelId: 'local/bonsai-1.7b-q4',
    });
    // Falls back to eco-fast scan
    expect(result).toBe('local/phi3-mini-4k-q4f16');
  });
});

// ─── getLocalRecoveryCandidateIds ───────────────────────────────────────

describe('getLocalRecoveryCandidateIds', () => {
  it('returns empty array when no slots are ready', () => {
    expect(getLocalRecoveryCandidateIds()).toEqual([]);
  });

  it('returns only ready slot model ids', () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlot('eco-smart', 'local/smollm2-1.7b-webllm-q4f16');
    // eco-smart is 'preparing', not 'ready'
    const ids = getLocalRecoveryCandidateIds();
    expect(ids).toEqual(['local/phi3-mini-4k-q4f16']);
  });

  it('returns both when both slots are ready', () => {
    bindReady('eco-fast', 'local/phi3-mini-4k-q4f16');
    bindReady('eco-smart', 'local/smollm2-1.7b-webllm-q4f16');
    const ids = getLocalRecoveryCandidateIds();
    expect(ids).toEqual([
      'local/phi3-mini-4k-q4f16',
      'local/smollm2-1.7b-webllm-q4f16',
    ]);
  });
});
