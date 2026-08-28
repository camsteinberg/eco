// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSlot,
  setSlot,
  setSlotStatus,
  setSlotStorage,
  getDemotedFrom,
  setDemotedFrom,
  clearDemotedFrom,
  type KeyValueStorage,
} from '../slots';
import type { ModelConfig } from '../../types';

const model = (id: string) => ({ id, friendlyName: `Model ${id}` } as ModelConfig);

function makeStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

describe('slot demotedFrom state', () => {
  let storage: KeyValueStorage;

  beforeEach(() => {
    storage = makeStorage();
    setSlotStorage(storage);
  });

  it('cascade demote records demotedFrom with the original model id', () => {
    setDemotedFrom('eco-fast', { modelId: 'candidate/lfm2.5-1.2b-instruct-onnx', at: 1000 });
    const demoted = getDemotedFrom('eco-fast');
    expect(demoted).toEqual({ modelId: 'candidate/lfm2.5-1.2b-instruct-onnx', at: 1000 });
  });

  it('a second demotion keeps the first (highest) model', () => {
    setDemotedFrom('eco-fast', { modelId: 'candidate/lfm2.5-1.2b-instruct-onnx', at: 1000 });
    setDemotedFrom('eco-fast', { modelId: 'candidate/lfm2.5-350m-onnx', at: 2000 });
    const demoted = getDemotedFrom('eco-fast');
    expect(demoted?.modelId).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(demoted?.at).toBe(1000);
  });

  it('original model reaching ready clears demotedFrom', () => {
    setDemotedFrom('eco-fast', { modelId: 'candidate/lfm2.5-1.2b-instruct-onnx', at: 1000 });
    clearDemotedFrom('eco-fast', 'candidate/lfm2.5-1.2b-instruct-onnx');
    expect(getDemotedFrom('eco-fast')).toBeUndefined();
  });

  it('clearing with a different model id does NOT clear demotedFrom', () => {
    setDemotedFrom('eco-fast', { modelId: 'candidate/lfm2.5-1.2b-instruct-onnx', at: 1000 });
    clearDemotedFrom('eco-fast', 'candidate/lfm2.5-350m-onnx');
    expect(getDemotedFrom('eco-fast')).toBeDefined();
  });

  it('legacy persisted records without the field load with demotedFrom undefined', () => {
    // Simulate a legacy slot with no demotedFrom key at all
    storage.setItem('eco-local-ai-slot-eco-fast', 'candidate/lfm2.5-350m-onnx');
    storage.setItem('eco-local-ai-slot-status-eco-fast', 'ready');
    const demoted = getDemotedFrom('eco-fast');
    expect(demoted).toBeUndefined();
  });
});
