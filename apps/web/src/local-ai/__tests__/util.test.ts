// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetSlotsForTesting,
  setSlot,
  setSlotStorage,
  type KeyValueStorage,
} from '../lifecycle/slots';
import { getContextTokens, resolveSelectedModelId } from '../util';

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

describe('getContextTokens', () => {
  it('keeps eval candidates behind an explicit validation opt-in', () => {
    expect(getContextTokens('candidate/gemma-4-e4b-litert', 777)).toBe(777);
    expect(
      getContextTokens('candidate/gemma-4-e4b-litert', 777, {
        allowValidationModel: true,
      }),
    ).toBe(2048);
  });

  it('continues to use catalog metadata without validation opt-in', () => {
    expect(getContextTokens('candidate/qwen3.5-2b-onnx', 777)).toBe(8192);
  });
});

describe('resolveSelectedModelId', () => {
  it('passes a concrete model id through unchanged', () => {
    expect(resolveSelectedModelId('local/bonsai-1.7b-q4')).toBe('local/bonsai-1.7b-q4');
  });

  it('resolves a slot to its bound model id', () => {
    setSlot('eco-fast', 'local/phi3-mini-4k-q4f16');
    expect(resolveSelectedModelId('eco-fast')).toBe('local/phi3-mini-4k-q4f16');
  });

  it('falls back to the choice when the slot has no bound model', () => {
    expect(resolveSelectedModelId('eco-fast')).toBe('eco-fast');
  });
});
