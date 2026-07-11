// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetSlotsForTesting,
  SLOTS,
  clearAllSlots,
  clearSlot,
  getAllSlots,
  getLegacyKeyPrefixes,
  getSlot,
  readRawSlotIdForMigration,
  setSlot,
  setSlotStatus,
  setSlotStorage,
  subscribe,
  type KeyValueStorage,
} from '../slots';

vi.mock('../../../lib/validation-harness', () => ({
  getValidationSlotModelOverride: vi.fn(() => null),
  getValidationSlotStatusOverride: vi.fn(() => null),
  isValidationHarnessEnabled: vi.fn(() => false),
}));

const {
  getValidationSlotModelOverride,
  getValidationSlotStatusOverride,
  isValidationHarnessEnabled,
} = await import('../../../lib/validation-harness');
const mockGetValidationSlotModelOverride = vi.mocked(getValidationSlotModelOverride);
const mockGetValidationSlotStatusOverride = vi.mocked(getValidationSlotStatusOverride);
const mockIsValidationHarnessEnabled = vi.mocked(isValidationHarnessEnabled);

class FakeStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

let storage: FakeStorage;

beforeEach(() => {
  storage = new FakeStorage();
  setSlotStorage(storage);
  mockGetValidationSlotModelOverride.mockReturnValue(null);
  mockGetValidationSlotStatusOverride.mockReturnValue(null);
  mockIsValidationHarnessEnabled.mockReturnValue(false);
});

afterEach(() => {
  _resetSlotsForTesting();
});

describe('Slot read/write basics', () => {
  it('empty slot returns status=empty and modelId=null', () => {
    const s = getSlot('eco-fast');
    expect(s.modelId).toBeNull();
    expect(s.status).toBe('empty');
    expect(s.model).toBeNull();
  });

  it('setSlot writes the id and a preparing status by default', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    const s = getSlot('eco-fast');
    expect(s.modelId).toBe('local/phi3-mini-4k-q4f16');
    expect(s.status).toBe('preparing');
    expect(s.model?.friendlyName).toBe('Phi-3 Mini');
  });

  it('setSlot with null clears the slot', () => {
    setSlot('eco-smart', 'local/qwen3-0.6b');
    setSlot('eco-smart', null);
    expect(getSlot('eco-smart').modelId).toBeNull();
    expect(getSlot('eco-smart').status).toBe('empty');
  });

  it('setSlot accepts a ModelConfig directly', () => {
    setSlot('eco-fast', { id: 'local/phi3-mini-4k-q4f16' } as unknown as Parameters<typeof setSlot>[1]);
    expect(getSlot('eco-fast').modelId).toBe('local/phi3-mini-4k-q4f16');
  });

  it('setSlotStatus updates only the status', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlotStatus('eco-fast', 'ready');
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('binding a DIFFERENT id over a ready slot flips it to preparing (phantom-pick fix)', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlotStatus('eco-fast', 'ready');
    // Re-bind to a different model — its bytes are unverified, so the slot must
    // not stay 'ready' (that is the interrupted-download phantom pick).
    setSlot('eco-fast', 'local/qwen3-0.6b');
    const s = getSlot('eco-fast');
    expect(s.modelId).toBe('local/qwen3-0.6b');
    expect(s.status).toBe('preparing');
  });

  it('re-binding the SAME id preserves the status', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlotStatus('eco-fast', 'ready');
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('an empty slot still defaults to preparing on first bind', () => {
    expect(getSlot('eco-fast').status).toBe('empty');
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    expect(getSlot('eco-fast').status).toBe('preparing');
  });

  it('setSlot(null) clears both the id and status keys', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlotStatus('eco-fast', 'ready');
    setSlot('eco-fast', null);
    expect(storage.getItem('eco-local-ai-slot-eco-fast')).toBeNull();
    expect(storage.getItem('eco-local-ai-slot-status-eco-fast')).toBeNull();
  });

  it('clearSlot is equivalent to setSlot(slot, null)', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    clearSlot('eco-fast');
    expect(getSlot('eco-fast').modelId).toBeNull();
  });

  it('a stored id not in the catalog reads as empty', () => {
    storage.setItem('eco-local-ai-slot-eco-fast', 'unknown/model-id');
    const s = getSlot('eco-fast');
    expect(s.modelId).toBeNull();
    expect(s.model).toBeNull();
  });

  it('keeps eval-only candidate ids empty when the validation harness is disabled', () => {
    storage.setItem('eco-local-ai-slot-eco-fast', 'candidate/gemma-4-e4b-litert');
    storage.setItem('eco-local-ai-slot-status-eco-fast', 'ready');

    const s = getSlot('eco-fast');
    expect(s.modelId).toBeNull();
    expect(s.status).toBe('empty');
    expect(s.model).toBeNull();
  });

  it('resolves eval-only candidate ids while the validation harness is enabled', () => {
    mockIsValidationHarnessEnabled.mockReturnValue(true);
    storage.setItem('eco-local-ai-slot-eco-fast', 'candidate/gemma-4-e4b-litert');
    storage.setItem('eco-local-ai-slot-status-eco-fast', 'ready');

    const s = getSlot('eco-fast');
    expect(s.modelId).toBe('candidate/gemma-4-e4b-litert');
    expect(s.status).toBe('ready');
    expect(s.model?.friendlyName).toBe('Gemma 4 E4B (LiteRT)');
  });

  it('uses validation slot overrides before persisted slot state', () => {
    mockIsValidationHarnessEnabled.mockReturnValue(true);
    mockGetValidationSlotModelOverride.mockImplementation((slot) =>
      slot === 'eco-fast' ? 'candidate/gemma-4-e4b-litert' : null,
    );
    mockGetValidationSlotStatusOverride.mockImplementation((slot) =>
      slot === 'eco-fast' ? 'ready' : null,
    );
    storage.setItem('eco-local-ai-slot-eco-fast', 'local/qwen3-0.6b');
    storage.setItem('eco-local-ai-slot-status-eco-fast', 'preparing');

    const s = getSlot('eco-fast');
    expect(s.modelId).toBe('candidate/gemma-4-e4b-litert');
    expect(s.status).toBe('ready');
    expect(s.model?.friendlyName).toBe('Gemma 4 E4B (LiteRT)');
  });
});

describe('getAllSlots', () => {
  it('returns state for every slot id', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    const all = getAllSlots();
    expect(all['eco-fast'].modelId).toBe('local/phi3-mini-4k-q4f16');
    expect(all['eco-smart'].modelId).toBeNull();
  });

  it('clearAllSlots empties every slot', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlot('eco-smart', 'local/qwen3-0.6b');
    clearAllSlots();
    for (const slot of SLOTS) {
      expect(getSlot(slot).modelId).toBeNull();
    }
  });
});

describe('Legacy key migration', () => {
  it('reads legacy "eco-model-slot-*" keys and promotes to the new key on read', () => {
    storage.setItem('eco-model-slot-eco-fast', 'local/phi3-mini-4k-q4f16');
    // Before promotion: new key is empty.
    expect(storage.getItem('eco-local-ai-slot-eco-fast')).toBeNull();

    const s = getSlot('eco-fast');
    expect(s.modelId).toBe('local/phi3-mini-4k-q4f16');
    // After: new key is populated.
    expect(storage.getItem('eco-local-ai-slot-eco-fast')).toBe('local/phi3-mini-4k-q4f16');
  });

  it('reads legacy "eco-slot-*" keys with same behavior', () => {
    storage.setItem('eco-slot-eco-smart', 'local/qwen3-0.6b');
    const s = getSlot('eco-smart');
    expect(s.modelId).toBe('local/qwen3-0.6b');
  });

  it('prefers the new key when both new and legacy are present', () => {
    storage.setItem('eco-local-ai-slot-eco-fast', 'local/phi3-mini-4k-q4f16');
    storage.setItem('eco-model-slot-eco-fast', 'local/qwen3-0.6b');
    expect(getSlot('eco-fast').modelId).toBe('local/phi3-mini-4k-q4f16');
  });

  it('legacy prefixes are exposed for self-heal', () => {
    expect(getLegacyKeyPrefixes()).toContain('eco-model-slot-');
    expect(getLegacyKeyPrefixes()).toContain('eco-slot-');
  });
});

describe('subscribe', () => {
  it('notifies on setSlot', () => {
    const events: string[] = [];
    const unsub = subscribe((slot, state) => events.push(`${slot}:${state.modelId ?? 'null'}`));
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    expect(events).toEqual(['eco-fast:local/phi3-mini-4k-q4f16']);
    unsub();
  });

  it('unsubscribe stops notifications', () => {
    const events: string[] = [];
    const unsub = subscribe(() => events.push('fire'));
    unsub();
    setSlot('eco-smart', 'local/qwen3-0.6b');
    expect(events).toHaveLength(0);
  });

  it('notifies with the flipped status when a re-bind changes the model', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    setSlotStatus('eco-fast', 'ready');
    const statuses: string[] = [];
    const unsub = subscribe((_slot, state) => statuses.push(state.status));
    setSlot('eco-fast', 'local/qwen3-0.6b');
    expect(statuses).toEqual(['preparing']);
    unsub();
  });
});

describe('readRawSlotIdForMigration', () => {
  // A synthetic id standing in for a just-retired model — deliberately NOT a
  // catalog id, so getSlot() resolves it to no model and nulls it.
  const RETIRED_ID = 'local/retired-model-q4';

  it('returns a persisted id that has left the catalog (getSlot would null it)', () => {
    // Write the raw slot key directly — setSlot would resolve/normalize; the
    // migration path is about whatever bytes are actually persisted.
    storage.setItem('eco-local-ai-slot-eco-fast', RETIRED_ID);

    // getSlot nulls the retired id (not in catalog, harness disabled)…
    expect(getSlot('eco-fast').modelId).toBeNull();
    // …but the raw migration read still sees it.
    expect(readRawSlotIdForMigration('eco-fast')).toBe(RETIRED_ID);
  });

  it('reads the retired id from a legacy slot key', () => {
    storage.setItem('eco-model-slot-eco-smart', RETIRED_ID);
    expect(readRawSlotIdForMigration('eco-smart')).toBe(RETIRED_ID);

    storage.removeItem('eco-model-slot-eco-smart');
    storage.setItem('eco-slot-eco-smart', RETIRED_ID);
    expect(readRawSlotIdForMigration('eco-smart')).toBe(RETIRED_ID);
  });

  it('does NOT promote a legacy value to the canonical key (read-only)', () => {
    storage.setItem('eco-model-slot-eco-fast', RETIRED_ID);
    readRawSlotIdForMigration('eco-fast');
    // Unlike readSlotId(), the raw migration read never writes the value
    // forward — the canonical key stays empty.
    expect(storage.getItem('eco-local-ai-slot-eco-fast')).toBeNull();
  });

  it('returns null when neither the canonical nor legacy keys hold a value', () => {
    expect(readRawSlotIdForMigration('eco-fast')).toBeNull();
  });

  it('returns the canonical key even when a legacy key also holds a value', () => {
    storage.setItem('eco-local-ai-slot-eco-fast', RETIRED_ID);
    storage.setItem('eco-model-slot-eco-fast', 'local/some-other-legacy-id');
    expect(readRawSlotIdForMigration('eco-fast')).toBe(RETIRED_ID);
  });
});
