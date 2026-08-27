// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import {
  _resetLifecycleForTesting,
  clearCooldown,
  configureLifecycle,
  generate,
  getActiveAdapter,
  getActiveModel,
  getCooldown,
  hasAdapterFactory,
  hasFaultStrike,
  loadModel,
  recordCooldown,
  setAdapterFactory,
  unloadActive,
  type KeyValueStorage,
} from '../lifecycle';
import { AdapterError, type RuntimeAdapter } from '../types';

const MODEL_A: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 0.57,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
};

const MODEL_B: ModelConfig = { ...MODEL_A, id: 'candidate/lfm2.5-1.2b-instruct-onnx', friendlyName: 'LFM2.5 1.2B' };

class FakeStorage implements KeyValueStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

class FakeAdapter implements RuntimeAdapter {
  readonly runtime = 'transformers' as const;
  isLoaded = false;
  backend: 'webgpu' | 'wasm' | null = null;
  activeModel: ModelConfig | null = null;
  loadCalls = 0;
  unloadCalls = 0;
  failOnLoad: AdapterError | null = null;
  failOnGenerateEvent: { code: import('../types').AdapterErrorCode; reason: string } | null = null;
  throwOnGenerate: AdapterError | null = null;

  async load(model: ModelConfig): Promise<void> {
    this.loadCalls++;
    if (this.failOnLoad) {
      throw this.failOnLoad;
    }
    this.isLoaded = true;
    this.backend = 'webgpu';
    this.activeModel = model;
  }

  async *generate(): AsyncIterable<import('../types').TokenEvent> {
    if (this.throwOnGenerate) {
      throw this.throwOnGenerate;
    }
    if (this.failOnGenerateEvent) {
      yield { kind: 'error', reason: this.failOnGenerateEvent.reason, code: this.failOnGenerateEvent.code };
      return;
    }
    yield { kind: 'token', text: 'hello' };
    yield { kind: 'done' };
  }

  async unload(): Promise<void> {
    this.unloadCalls++;
    this.isLoaded = false;
    this.backend = null;
    this.activeModel = null;
  }
}

let now = 1_000_000;
let storage: FakeStorage;

beforeEach(() => {
  _resetLifecycleForTesting();
  now = 1_000_000;
  storage = new FakeStorage();
  configureLifecycle({
    cooldownMs: 5 * 60 * 1000,
    now: () => now,
    storage,
  });
});

afterEach(() => {
  _resetLifecycleForTesting();
});

// ─── Adapter factory DI ────────────────────────────────────────────────────

describe('adapter factory DI', () => {
  it('throws when loadModel called without a registered factory', async () => {
    expect(hasAdapterFactory()).toBe(false);
    await expect(loadModel(MODEL_A)).rejects.toBeInstanceOf(AdapterError);
  });

  it('delegates to the registered factory', async () => {
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);
    expect(adapter.loadCalls).toBe(1);
    expect(getActiveModel()).toEqual(MODEL_A);
    expect(getActiveAdapter()).toBe(adapter);
  });
});

// ─── Singleton ─────────────────────────────────────────────────────────────

describe('singleton behavior', () => {
  it('loading the same model twice is a no-op', async () => {
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);
    await loadModel(MODEL_A);
    expect(adapter.loadCalls).toBe(1);
  });

  it('switching models unloads the previous adapter', async () => {
    const adapterA = new FakeAdapter();
    const adapterB = new FakeAdapter();
    let next = adapterA;
    setAdapterFactory(() => next);
    await loadModel(MODEL_A);
    next = adapterB;
    await loadModel(MODEL_B);
    expect(adapterA.unloadCalls).toBe(1);
    expect(adapterB.loadCalls).toBe(1);
    expect(getActiveModel()).toEqual(MODEL_B);
  });

  it('unloadActive clears active and calls adapter.unload', async () => {
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);
    await unloadActive();
    expect(adapter.unloadCalls).toBe(1);
    expect(getActiveAdapter()).toBeNull();
    expect(getActiveModel()).toBeNull();
  });
});

// ─── Cooldown ──────────────────────────────────────────────────────────────

describe('cooldown', () => {
  it('records a cooldown when load throws an OOM AdapterError', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnLoad = new AdapterError('out of memory', 'oom', true);
    setAdapterFactory(() => adapter);

    await expect(loadModel(MODEL_A)).rejects.toBeInstanceOf(AdapterError);
    const cooldown = getCooldown(MODEL_A.id);
    expect(cooldown).not.toBeNull();
    expect(cooldown!.code).toBe('oom');
  });

  it('does NOT record a cooldown for non-trigger error codes', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnLoad = new AdapterError('aborted', 'aborted', true);
    setAdapterFactory(() => adapter);

    await expect(loadModel(MODEL_A)).rejects.toBeInstanceOf(AdapterError);
    expect(getCooldown(MODEL_A.id)).toBeNull();
  });

  it('blocks a subsequent load of the same model while cooldown is active', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnLoad = new AdapterError('device lost', 'device-lost', true);
    setAdapterFactory(() => adapter);
    await expect(loadModel(MODEL_A)).rejects.toBeInstanceOf(AdapterError);

    // Same model, cooldown active.
    const ok = new FakeAdapter();
    setAdapterFactory(() => ok);
    await expect(loadModel(MODEL_A)).rejects.toThrowError(/cooling down/i);
    expect(ok.loadCalls).toBe(0);
  });

  it('expires after cooldownMs', async () => {
    recordCooldown(MODEL_A.id, 'init-failed');
    expect(getCooldown(MODEL_A.id)).not.toBeNull();
    now += 5 * 60 * 1000 + 1;
    expect(getCooldown(MODEL_A.id)).toBeNull();
  });

  it('clearCooldown(modelId) removes a single record', () => {
    recordCooldown(MODEL_A.id, 'oom');
    recordCooldown(MODEL_B.id, 'oom');
    clearCooldown(MODEL_A.id);
    expect(getCooldown(MODEL_A.id)).toBeNull();
    expect(getCooldown(MODEL_B.id)).not.toBeNull();
  });

  it('clearCooldown() with no arg clears all', () => {
    recordCooldown(MODEL_A.id, 'oom');
    recordCooldown(MODEL_B.id, 'oom');
    clearCooldown();
    expect(getCooldown(MODEL_A.id)).toBeNull();
    expect(getCooldown(MODEL_B.id)).toBeNull();
  });

  it('cooldown survives reload via storage', () => {
    recordCooldown(MODEL_A.id, 'oom');
    // Simulate a fresh page boot: re-attach storage with same backing map.
    configureLifecycle({ cooldownMs: 5 * 60 * 1000, now: () => now, storage });
    expect(getCooldown(MODEL_A.id)).not.toBeNull();
  });
});

// ─── Generate path ─────────────────────────────────────────────────────────

// unloadActive() is fired-and-forgotten in generate()'s finally, running under
// the lifecycle lock. Flush the queued lock continuation + the async unload
// before asserting.
const flushUnload = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('generate', () => {
  it('throws when no model is loaded', async () => {
    await expect((async () => {
      for await (const _ of generate([])) { void _; }
    })()).rejects.toBeInstanceOf(AdapterError);
  });

  it('yields events from the active adapter', async () => {
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]!.kind).toBe('done');
  });

  // A generation-time fault is usually the prompt's size (KV-cache overflow on
  // a long chat), not the weights — so the first one must NOT lock the user
  // out for five minutes. It records a strike; the next send reloads cleanly.
  it('does NOT cool down on the first generation-time OOM — the next load succeeds', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnGenerateEvent = { code: 'oom', reason: 'GPU oom' };
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    for await (const event of generate([])) {
      void event;
    }
    await flushUnload();
    expect(getCooldown(MODEL_A.id)).toBeNull();
    expect(hasFaultStrike(MODEL_A.id)).toBe(true);

    adapter.failOnGenerateEvent = null;
    await expect(loadModel(MODEL_A)).resolves.toBeDefined();
    expect(adapter.loadCalls).toBe(2);
  });

  it('records a cooldown on a REPEAT generation-time fault while the strike is live', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnGenerateEvent = { code: 'oom', reason: 'GPU oom' };
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);
    for await (const event of generate([])) { void event; }
    await flushUnload();

    await loadModel(MODEL_A);
    adapter.failOnGenerateEvent = { code: 'device-lost', reason: 'device lost' };
    for await (const event of generate([])) { void event; }
    await flushUnload();

    expect(getCooldown(MODEL_A.id)).not.toBeNull();
    expect(getCooldown(MODEL_A.id)!.code).toBe('device-lost');
    expect(hasFaultStrike(MODEL_A.id)).toBe(false);
    await expect(loadModel(MODEL_A)).rejects.toMatchObject({ code: 'cooldown-active' });
  });

  it('a strike expires after cooldownMs, so a fault much later is a first fault again', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnGenerateEvent = { code: 'oom', reason: 'GPU oom' };
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);
    for await (const event of generate([])) { void event; }
    await flushUnload();

    now += 5 * 60 * 1000 + 1;
    await loadModel(MODEL_A);
    for await (const event of generate([])) { void event; }
    await flushUnload();
    expect(getCooldown(MODEL_A.id)).toBeNull();
  });

  it('a load-time OOM still cools down immediately (weights that did not fit will not fit on retry)', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnLoad = new AdapterError('oom', 'oom', true);
    setAdapterFactory(() => adapter);
    await expect(loadModel(MODEL_A)).rejects.toBeInstanceOf(AdapterError);
    expect(getCooldown(MODEL_A.id)).not.toBeNull();
  });
});

// ─── Fault unload ───────────────────────────────────────────────────────────

describe('fault unload', () => {
  it('unloads the dead adapter when generate emits a fault error event', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnGenerateEvent = { code: 'oom', reason: 'GPU oom' };
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    for await (const event of generate([])) {
      void event;
    }
    await flushUnload();

    expect(adapter.unloadCalls).toBe(1);
    expect(getActiveModel()).toBeNull();
    expect(getActiveAdapter()).toBeNull();
  });

  it('unloads the adapter when generate emits a timeout (stalled) error so the next send is not rejected', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnGenerateEvent = { code: 'timeout', reason: 'Generation stalled: no token for 30s.' };
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    for await (const event of generate([])) {
      void event;
    }
    await flushUnload();

    expect(adapter.unloadCalls).toBe(1);
    expect(getActiveAdapter()).toBeNull();
  });

  it('unloads the dead adapter when generate throws an OOM', async () => {
    const adapter = new FakeAdapter();
    adapter.throwOnGenerate = new AdapterError('out of memory', 'oom', true);
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    await expect((async () => {
      for await (const event of generate([])) {
        void event;
      }
    })()).rejects.toBeInstanceOf(AdapterError);
    await flushUnload();

    expect(adapter.unloadCalls).toBe(1);
    expect(getActiveModel()).toBeNull();
  });

  it('does NOT unload when generate emits an aborted error event', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnGenerateEvent = { code: 'aborted', reason: 'user stopped' };
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    for await (const event of generate([])) {
      void event;
    }
    await flushUnload();

    expect(adapter.unloadCalls).toBe(0);
    expect(getActiveModel()).toEqual(MODEL_A);
  });

  it('does NOT unload when the caller signal is aborted, even on a fault throw', async () => {
    const adapter = new FakeAdapter();
    adapter.throwOnGenerate = new AdapterError('out of memory', 'oom', true);
    setAdapterFactory(() => adapter);
    await loadModel(MODEL_A);

    const controller = new AbortController();
    controller.abort();
    await expect((async () => {
      for await (const event of generate([], { signal: controller.signal })) {
        void event;
      }
    })()).rejects.toBeInstanceOf(AdapterError);
    await flushUnload();

    expect(adapter.unloadCalls).toBe(0);
    expect(getActiveModel()).toEqual(MODEL_A);
  });
});

// ─── Load timeout / cancellation ───────────────────────────────────────────

// Regression coverage for the confirmed-live LiteRT/Gemma-4 defect: its
// vendor library (@litert-lm/core) has NO cancellation parameter at all, so
// an adapter that never reacts to the signal must still be forced to settle
// — otherwise a stuck load wedges the lifecycle lock forever (the switch-model
// lease, the smoke gate, and the sustained probe all inherit the hang).

describe('load timeout / cancellation', () => {
  it('forces a timeout rejection when a non-cooperating adapter never settles', async () => {
    const adapter = new FakeAdapter();
    // Models a vendor library with no cancellation support: load() never
    // resolves or rejects, matching LiteRT's real Engine.create().
    adapter.load = () => new Promise(() => {});
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects immediately with timeout when the signal is already aborted', async () => {
    const adapter = new FakeAdapter();
    adapter.load = () => new Promise(() => {});
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    controller.abort();

    await expect(loadModel(MODEL_A, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'timeout' });
  });

  it("does not override a cooperating adapter's own abort classification", async () => {
    const adapter = new FakeAdapter();
    let notifyListenerRegistered: () => void;
    const listenerRegistered = new Promise<void>((resolve) => {
      notifyListenerRegistered = resolve;
    });
    // Models TransformersAdapter: genuinely listens to the signal and
    // rejects with its own classification. Waiting for the listener to
    // register before aborting makes the test deterministic — the real
    // production race (adapter's own microtask-based rejection vs. our
    // deliberately-deferred macrotask fallback) is exercised regardless of
    // this ordering, but an unsynchronized abort() here could itself win
    // the race against the adapter even registering its own listener.
    adapter.load = (_model: ModelConfig, options?: import('../types').LoadOptions) =>
      new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new AdapterError('load aborted', 'aborted', true));
        }, { once: true });
        notifyListenerRegistered();
      });
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    await listenerRegistered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });

  it('does not record a cooldown for a forced timeout', async () => {
    const adapter = new FakeAdapter();
    adapter.load = () => new Promise(() => {});
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    controller.abort();
    await pending.catch(() => undefined);

    expect(getCooldown(MODEL_A.id)).toBeNull();
  });

  // A forced timeout stops us waiting but cannot cancel a non-cooperating
  // vendor load (LiteRT's Engine.create). If that load completes later, it
  // adopts a fully-loaded engine (GBs of heap) the lifecycle will never see —
  // loadModel disposes it best-effort so it doesn't leak on exactly the
  // memory-constrained devices the timeout protects.
  it('disposes a late-succeeding orphaned engine after a forced timeout', async () => {
    const adapter = new FakeAdapter();
    let resolveLoad!: () => void;
    // Slow-but-not-hung: settles only when we let it, after the forced timeout.
    adapter.load = () => new Promise<void>((resolve) => { resolveLoad = resolve; });
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    // Load is still in flight — nothing to dispose yet.
    expect(adapter.unloadCalls).toBe(0);

    // The orphaned vendor load finally returns.
    resolveLoad();
    await flushUnload();

    expect(adapter.unloadCalls).toBe(1);
    // The orphan is dead to the state machine — disposal must not touch state.
    expect(getActiveAdapter()).toBeNull();
    expect(getActiveModel()).toBeNull();
  });

  it('does not dispose the adapter on the normal success path', async () => {
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);

    // A signal is present (so the race wraps the load), but never aborts.
    const controller = new AbortController();
    await loadModel(MODEL_A, { signal: controller.signal });
    await flushUnload();

    expect(adapter.unloadCalls).toBe(0);
    expect(getActiveAdapter()).toBe(adapter);
  });

  it('does not dispose or leak an unhandled rejection when the orphaned load rejects after a forced timeout', async () => {
    const adapter = new FakeAdapter();
    let rejectLoad!: (err: unknown) => void;
    adapter.load = () => new Promise<void>((_resolve, reject) => { rejectLoad = reject; });
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });

    // The orphaned load rejects late — there's no engine to dispose, and the
    // rejection must be swallowed (an unhandled rejection would fail the run).
    rejectLoad(new AdapterError('too late', 'init-failed', true));
    await flushUnload();

    expect(adapter.unloadCalls).toBe(0);
  });

  it('adopts the engine and does not dispose when a fast load wins against an already-aborted signal', async () => {
    // The signal is already aborted when the load runs, but the load resolves
    // (a microtask) before the deferred forced-timeout macrotask fires — the
    // `settled` guard yields exactly one outcome: adoption, no disposal.
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    controller.abort();
    await loadModel(MODEL_A, { signal: controller.signal });
    await flushUnload();

    expect(adapter.unloadCalls).toBe(0);
    expect(getActiveAdapter()).toBe(adapter);
    expect(getActiveModel()).toEqual(MODEL_A);
  });
});

// ─── Load-failure cleanup (RT-1) ─────────────────────────────────────────────
//
// A load that rejects never reaches `state.activeAdapter = adapter`, so the
// lifecycle loses its only reference to the adapter. Its worker (potentially
// multi-GB) must be unloaded on the failure path or it is orphaned forever.

describe('load failure cleanup (RT-1)', () => {
  it('unloads the adapter when the load fails, so no worker is orphaned', async () => {
    const adapter = new FakeAdapter();
    adapter.failOnLoad = new AdapterError('init failed', 'init-failed', false);
    setAdapterFactory(() => adapter);

    // Current code: unloadCalls stays 0 (worker orphaned). After the fix: 1.
    await expect(loadModel(MODEL_A)).rejects.toBeInstanceOf(AdapterError);

    expect(adapter.unloadCalls).toBe(1);
    expect(getActiveAdapter()).toBeNull();
    expect(getActiveModel()).toBeNull();
  });

  it('unloads the adapter when a cooperating load is aborted (the RT-1 scenario)', async () => {
    const adapter = new FakeAdapter();
    let notifyListenerRegistered: () => void;
    const listenerRegistered = new Promise<void>((resolve) => {
      notifyListenerRegistered = resolve;
    });
    // Models TransformersAdapter: rejects with 'aborted' when the signal fires,
    // but does NOT terminate its own worker — the lifecycle must do the cleanup.
    adapter.load = (_model: ModelConfig, options?: import('../types').LoadOptions) =>
      new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new AdapterError('load aborted', 'aborted', true));
        }, { once: true });
        notifyListenerRegistered();
      });
    setAdapterFactory(() => adapter);

    const controller = new AbortController();
    const pending = loadModel(MODEL_A, { signal: controller.signal });
    await listenerRegistered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(adapter.unloadCalls).toBe(1);
    expect(getActiveAdapter()).toBeNull();
    expect(getActiveModel()).toBeNull();
  });
});

// ─── Lock ──────────────────────────────────────────────────────────────────

describe('lock serialization', () => {
  it('serializes concurrent loadModel calls', async () => {
    const adapter = new FakeAdapter();
    setAdapterFactory(() => adapter);
    const calls: number[] = [];
    let order = 0;

    const wrapped = new FakeAdapter();
    wrapped.load = async () => {
      const id = ++order;
      await new Promise((r) => setTimeout(r, 10));
      calls.push(id);
      wrapped.isLoaded = true;
      wrapped.activeModel = MODEL_A;
      wrapped.backend = 'webgpu';
    };
    setAdapterFactory(() => wrapped);

    await Promise.all([
      loadModel(MODEL_A),
      loadModel(MODEL_A),
      loadModel(MODEL_A),
    ]);

    // First call entered first; the other two saw the model already loaded
    // (no-op return) so wrapped.load only ran once.
    expect(calls.length).toBe(1);
  });
});
