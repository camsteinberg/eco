// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSetup } from '../setup-runner';
import type { ModelConfig, DeviceProfile } from '../../types';
import type { SlotState, KeyValueStorage } from '../slots';
import { setSlotStorage, getDemotedFrom } from '../slots';

const PROFILE = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
} as DeviceProfile;

const model = (id: string) => ({ id, friendlyName: `Model ${id}` } as ModelConfig);
const emptySlot = { modelId: null, status: 'empty', model: null } as unknown as SlotState;

function makeStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
}

function fakeActions() {
  return {
    onProgressEvent: vi.fn(),
    setBelowFloor: vi.fn(),
    setReady: vi.fn(),
    setError: vi.fn(),
    markPriorAttemptFailed: vi.fn(),
    markFindingFit: vi.fn(),
    markResuming: vi.fn(),
  };
}

function seams(over = {}) {
  return {
    bootstrap: vi.fn(async () => {}),
    resolveProfile: vi.fn(async () => PROFILE),
    isBelowFloor: vi.fn(() => false),
    getSlot: vi.fn(() => emptySlot),
    setSlot: vi.fn(),
    setSlotStatus: vi.fn(),
    recommend: vi.fn(() => model('candidate/lfm2.5-1.2b-instruct-onnx')),
    nextInCascade: vi.fn(() => model('candidate/lfm2.5-350m-onnx')),
    recordEvidence: vi.fn(),
    runAttempt: vi.fn(async () => ({ ok: true as const })),
    starterModelForSlot: vi.fn(() => null),
    isModelCached: vi.fn(async () => false),
    ...over,
  };
}

describe('executeSetup — demotion notice (demotedFrom on slot state)', () => {
  let storage: KeyValueStorage;

  beforeEach(() => {
    storage = makeStorage();
    setSlotStorage(storage);
  });

  it('cascade demote sets demotedFrom with the original model id on the slot', async () => {
    let calls = 0;
    const a = fakeActions();
    const s = seams({
      runAttempt: vi.fn(async () =>
        ++calls === 1
          ? { ok: false as const, phase: 'load-or-smoke' as const, reason: 'OOM' }
          : { ok: true as const },
      ),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    const demoted = getDemotedFrom('eco-fast');
    expect(demoted).toBeDefined();
    expect(demoted?.modelId).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('a second demotion in the same cascade keeps the first model', async () => {
    let calls = 0;
    const a = fakeActions();
    const thirdModel = model('candidate/smollm2-360m-instruct-onnx');
    const s = seams({
      runAttempt: vi.fn(async () =>
        ++calls <= 2
          ? { ok: false as const, phase: 'load-or-smoke' as const, reason: 'OOM' }
          : { ok: true as const },
      ),
      nextInCascade: vi.fn((_f: ModelConfig, _s: unknown, _p: unknown, _i: unknown, o: { excludeIds: string[] }) => {
        if (!o.excludeIds.includes('candidate/lfm2.5-350m-onnx')) return model('candidate/lfm2.5-350m-onnx');
        if (!o.excludeIds.includes('candidate/smollm2-360m-instruct-onnx')) return thirdModel;
        return null;
      }),
    });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    const demoted = getDemotedFrom('eco-fast');
    expect(demoted?.modelId).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('original model reaching ready clears demotedFrom', async () => {
    const a = fakeActions();
    // First: set a demotion state
    storage.setItem('eco-local-ai-slot-demoted-from-eco-fast', JSON.stringify({
      modelId: 'candidate/lfm2.5-1.2b-instruct-onnx',
      at: 1000,
    }));
    // Now simulate the original model reaching ready (the slot holds the
    // original model, slot is already 'ready')
    const readyModel = model('candidate/lfm2.5-1.2b-instruct-onnx');
    const readySlot = {
      modelId: 'candidate/lfm2.5-1.2b-instruct-onnx',
      status: 'ready',
      model: readyModel,
    } as unknown as SlotState;
    const s = seams({ getSlot: vi.fn(() => readySlot) });
    await executeSetup(a, { slot: 'eco-fast', seams: s });
    expect(a.setReady).toHaveBeenCalledWith(readyModel);
    expect(getDemotedFrom('eco-fast')).toBeUndefined();
  });
});
