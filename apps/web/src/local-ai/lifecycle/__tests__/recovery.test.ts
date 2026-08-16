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
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: 'candidate/lfm2.5-1.2b-instruct-onnx',
    });
    expect(result).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('returns null when currentModelId is not a ready slot model', async () => {
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: 'local/qwen3-0.6b',
    });
    expect(result).toBeNull();
  });

  it('returns null when currentModelId is set and its slot is not ready', async () => {
    setSlot('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    // status defaults to 'preparing', not 'ready'
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: 'candidate/lfm2.5-1.2b-instruct-onnx',
    });
    expect(result).toBeNull();
  });

  it('falls back to eco-fast when currentModelId is null', async () => {
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('falls back to eco-smart when eco-fast is empty', async () => {
    bindReady('eco-smart', 'candidate/qwen3.5-2b-onnx');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBe('candidate/qwen3.5-2b-onnx');
  });

  it('returns null when all slots are empty', async () => {
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBeNull();
  });

  it('returns null when all slots are in error state', async () => {
    setSlot('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    setSlotStatus('eco-fast', 'error');
    setSlot('eco-smart', 'candidate/qwen3.5-2b-onnx');
    setSlotStatus('eco-smart', 'error');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
    });
    expect(result).toBeNull();
  });

  it('prefers preferredModelId over slot-scan when currentModelId is null', async () => {
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    bindReady('eco-smart', 'candidate/qwen3.5-2b-onnx');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
      preferredModelId: 'candidate/qwen3.5-2b-onnx',
    });
    expect(result).toBe('candidate/qwen3.5-2b-onnx');
  });

  it('ignores preferredModelId when it is not a ready slot model', async () => {
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    const result = await resolveReadyLocalRecoveryModelId({
      currentModelId: null,
      preferredModelId: 'local/qwen3-0.6b',
    });
    // Falls back to eco-fast scan
    expect(result).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
  });
});

// ─── getLocalRecoveryCandidateIds ───────────────────────────────────────

describe('getLocalRecoveryCandidateIds', () => {
  it('returns empty array when no slots are ready', () => {
    expect(getLocalRecoveryCandidateIds()).toEqual([]);
  });

  it('returns only ready slot model ids', () => {
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    setSlot('eco-smart', 'candidate/qwen3.5-2b-onnx');
    // eco-smart is 'preparing', not 'ready'
    const ids = getLocalRecoveryCandidateIds();
    expect(ids).toEqual(['candidate/lfm2.5-1.2b-instruct-onnx']);
  });

  it('returns both when both slots are ready', () => {
    bindReady('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    bindReady('eco-smart', 'candidate/qwen3.5-2b-onnx');
    const ids = getLocalRecoveryCandidateIds();
    expect(ids).toEqual([
      'candidate/lfm2.5-1.2b-instruct-onnx',
      'candidate/qwen3.5-2b-onnx',
    ]);
  });
});
