// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Invariant 8 — All failures recoverable without page reload.
 *
 * Every documented `AdapterErrorCode` is exercised through the lifecycle
 * and the slot state, asserting:
 *
 *   - load() failures throw an AdapterError carrying the right code
 *   - cooldown-trigger codes (oom, device-lost, init-failed) record a
 *     cooldown that prevents immediate reload
 *   - the lifecycle's activeAdapter / activeModel are cleared so the
 *     slot can be reassigned
 *   - generate() failures yield an `{ kind: 'error' }` event and the
 *     active adapter remains for subsequent generations
 *   - after clearing the cooldown, the same model loads cleanly
 *   - slot status transitions are observable (preparing → error → preparing
 *     → ready) — no stuck 'active' flag
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetLifecycleForTesting,
  configureLifecycle,
  clearCooldown,
  getCooldown,
  loadModel,
  generate,
  unloadActive,
  setAdapterFactory,
  getActiveAdapter,
  getActiveModel,
} from '../runtime/lifecycle';
import {
  _resetSlotsForTesting,
  getSlot,
  setSlot,
  setSlotStatus,
  setSlotStorage,
  type KeyValueStorage,
} from '../lifecycle/slots';
import {
  AdapterError,
  type AdapterErrorCode,
  type RuntimeAdapter,
  type TokenEvent,
} from '../runtime/types';
import { getModel } from '../catalog/catalog';
import type { ModelConfig } from '../types';

const TEST_MODEL = (() => {
  const model = getModel('local/phi3-mini-4k-q4f16');
  if (!model) throw new Error('Test setup: phi3-mini missing from catalog');
  return model;
})();

// In-memory storage so each test starts clean.
function createMemoryStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => { store.delete(key); },
  };
}

// Adapter that fails load() with a specific code.
function failingLoadAdapter(model: ModelConfig, code: AdapterErrorCode): RuntimeAdapter {
  return {
    runtime: 'transformers',
    isLoaded: false,
    backend: null,
    activeModel: null,
    async load() {
      throw new AdapterError(`Simulated ${code} during load of ${model.friendlyName}`, code);
    },
    async *generate(): AsyncIterable<TokenEvent> {
      // unreachable in this test
    },
    async unload() { /* no-op */ },
  };
}

// Adapter that succeeds load() but yields an error event during generate().
function failingGenerateAdapter(model: ModelConfig, code: AdapterErrorCode): RuntimeAdapter {
  let loaded = false;
  return {
    runtime: 'transformers',
    get isLoaded() { return loaded; },
    backend: 'webgpu',
    activeModel: model,
    async load() { loaded = true; },
    async *generate() {
      yield { kind: 'token' as const, text: 'partial ' };
      yield { kind: 'error' as const, reason: `simulated ${code}`, code };
    },
    async unload() { loaded = false; },
  };
}

// Adapter that succeeds at both load() and a normal generate.
function happyAdapter(model: ModelConfig): RuntimeAdapter {
  let loaded = false;
  return {
    runtime: 'transformers',
    get isLoaded() { return loaded; },
    backend: 'webgpu',
    activeModel: model,
    async load() { loaded = true; },
    async *generate() {
      yield { kind: 'token' as const, text: 'hi' };
      yield { kind: 'done' as const, promptTokens: 1, completionTokens: 1 };
    },
    async unload() { loaded = false; },
  };
}

const memoryStorage = createMemoryStorage();

beforeEach(() => {
  _resetLifecycleForTesting();
  _resetSlotsForTesting();
  setSlotStorage(memoryStorage);
  configureLifecycle({
    storage: memoryStorage,
    cooldownMs: 1_000_000, // long enough that no test accidentally clears it
    now: () => 1_700_000_000_000,
  });
});

afterEach(() => {
  setSlotStorage(null);
  setAdapterFactory(null);
});

const COOLDOWN_TRIGGER_CODES: AdapterErrorCode[] = ['oom', 'device-lost', 'init-failed'];
const NON_TRIGGER_CODES: AdapterErrorCode[] = ['webgpu-unavailable', 'generation-failed', 'timeout'];

describe('Invariant 8 — load() failures are recoverable per AdapterErrorCode', () => {
  it.each(COOLDOWN_TRIGGER_CODES)(
    '%s during load: records a cooldown, leaves no active adapter, second load is blocked until cooldown clears',
    async (code) => {
      setAdapterFactory((m) => failingLoadAdapter(m, code));

      // First load — fails with the expected code.
      await expect(loadModel(TEST_MODEL)).rejects.toMatchObject({
        name: 'AdapterError',
        code,
      });

      // Lifecycle has no leftover active state.
      expect(getActiveAdapter()).toBeNull();
      expect(getActiveModel()).toBeNull();

      // Cooldown was recorded.
      const cooldown = getCooldown(TEST_MODEL.id);
      expect(cooldown).not.toBeNull();
      expect(cooldown!.code).toBe(code);

      // Slot can be marked error — user-facing state transitions cleanly.
      setSlot('eco-fast', TEST_MODEL);
      setSlotStatus('eco-fast', 'error');
      expect(getSlot('eco-fast').status).toBe('error');

      // Reload during cooldown: lifecycle throws 'cooldown-active' so the
      // shim's translator can route to the LOCAL_MODEL_COOLDOWN UI branch
      // (preserving the "Ns left" countdown). The original trigger code
      // remains recorded on the cooldown itself for triggering policy.
      await expect(loadModel(TEST_MODEL)).rejects.toMatchObject({
        name: 'AdapterError',
        code: 'cooldown-active',
      });

      // After explicit clear, the same model can load again (with a happy adapter).
      clearCooldown(TEST_MODEL.id);
      setAdapterFactory((m) => happyAdapter(m));
      const adapter = await loadModel(TEST_MODEL);
      expect(adapter.isLoaded).toBe(true);

      // User can flip the slot back to ready and resume.
      setSlotStatus('eco-fast', 'ready');
      expect(getSlot('eco-fast').status).toBe('ready');
    },
  );

  it.each(NON_TRIGGER_CODES)(
    '%s during load: no cooldown recorded, lifecycle clears, retry is immediate',
    async (code) => {
      setAdapterFactory((m) => failingLoadAdapter(m, code));

      await expect(loadModel(TEST_MODEL)).rejects.toMatchObject({
        name: 'AdapterError',
        code,
      });

      // No cooldown — these codes don't block immediate retry.
      expect(getCooldown(TEST_MODEL.id)).toBeNull();
      expect(getActiveAdapter()).toBeNull();

      // Immediate retry with the same (still-failing) factory still throws,
      // but the lifecycle did not gate it on a cooldown.
      await expect(loadModel(TEST_MODEL)).rejects.toMatchObject({
        name: 'AdapterError',
        code,
      });

      // After swapping the factory to one that succeeds, retry works.
      setAdapterFactory((m) => happyAdapter(m));
      const adapter = await loadModel(TEST_MODEL);
      expect(adapter.isLoaded).toBe(true);
    },
  );
});

describe('Invariant 8 — generate() failures are recoverable', () => {
  it.each(COOLDOWN_TRIGGER_CODES)(
    '%s during generate: error event surfaced, cooldown recorded, model can be reloaded after clear',
    async (code) => {
      setAdapterFactory((m) => failingGenerateAdapter(m, code));
      await loadModel(TEST_MODEL);
      expect(getActiveAdapter()).not.toBeNull();

      const events: TokenEvent[] = [];
      for await (const event of generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }

      // The error is surfaced as an event — not thrown.
      const errorEvents = events.filter((e) => e.kind === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0]).toMatchObject({ kind: 'error', code });

      // Cooldown recorded after the generate-time crash.
      const cooldown = getCooldown(TEST_MODEL.id);
      expect(cooldown).not.toBeNull();
      expect(cooldown!.code).toBe(code);

      // Reset by user: clear cooldown, unload, reload with a happy adapter.
      clearCooldown(TEST_MODEL.id);
      await unloadActive();
      setAdapterFactory((m) => happyAdapter(m));
      const adapter = await loadModel(TEST_MODEL);
      expect(adapter.isLoaded).toBe(true);

      // Generate cleanly the second time.
      const goodEvents: TokenEvent[] = [];
      for await (const event of generate([{ role: 'user', content: 'hi' }])) {
        goodEvents.push(event);
      }
      expect(goodEvents.some((e) => e.kind === 'done')).toBe(true);
    },
  );

  it('generation-failed during generate: error surfaced, NO cooldown (recoverable on next call)', async () => {
    setAdapterFactory((m) => failingGenerateAdapter(m, 'generation-failed'));
    await loadModel(TEST_MODEL);

    const events: TokenEvent[] = [];
    for await (const event of generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events.filter((e) => e.kind === 'error')).toHaveLength(1);

    // 'generation-failed' is NOT a cooldown trigger — immediate retry must
    // be possible without clearing anything.
    expect(getCooldown(TEST_MODEL.id)).toBeNull();
    expect(getActiveAdapter()).not.toBeNull();
  });
});

describe('Invariant 8 — slot status transitions are reachable from every error', () => {
  it('preparing → error → preparing → ready survives each failure code without page reload', async () => {
    for (const code of COOLDOWN_TRIGGER_CODES) {
      // Fresh in-memory storage per iteration so prior-loop slot status
      // doesn't leak forward (setSlot only auto-defaults 'preparing'
      // from 'empty').
      const fresh = createMemoryStorage();
      _resetLifecycleForTesting();
      _resetSlotsForTesting();
      setSlotStorage(fresh);
      configureLifecycle({ storage: fresh, cooldownMs: 1_000_000, now: () => 1_700_000_000_000 });

      // Assign + mark preparing
      setSlot('eco-fast', TEST_MODEL);
      expect(getSlot('eco-fast').status).toBe('preparing');

      // Trigger the failure
      setAdapterFactory((m) => failingLoadAdapter(m, code));
      await expect(loadModel(TEST_MODEL)).rejects.toBeInstanceOf(AdapterError);
      setSlotStatus('eco-fast', 'error');
      expect(getSlot('eco-fast').status).toBe('error');

      // User retries: clear cooldown, mark preparing again
      clearCooldown(TEST_MODEL.id);
      setSlotStatus('eco-fast', 'preparing');
      expect(getSlot('eco-fast').status).toBe('preparing');

      // Recovery succeeds
      setAdapterFactory((m) => happyAdapter(m));
      await loadModel(TEST_MODEL);
      setSlotStatus('eco-fast', 'ready');
      expect(getSlot('eco-fast').status).toBe('ready');
    }
  });
});
