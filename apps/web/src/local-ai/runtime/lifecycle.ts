// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runtime lifecycle — singleton, lock, cooldown.
 *
 * Owns three responsibilities:
 *
 *   1. Singleton — exactly one adapter has a model loaded at any time.
 *      Switching models means unload-then-load with the lock held.
 *
 *   2. Lock — `acquire(operation)` returns a release function. Concurrent
 *      callers wait. Implemented over the Web Locks API where available,
 *      falling back to a promise queue when not (test environments).
 *
 *   3. Cooldown — when a model crashes (OOM, device-lost, init-failed),
 *      record a 5-minute cooldown so we don't immediately reload the same
 *      model and reproduce the crash. Cooldown is per-model, persisted
 *      to localStorage so it survives page reloads.
 *
 * Smoke testing lives in `lifecycle/smoke.ts`. Cross-tab BroadcastChannel
 * coordination is deferred post-v1.0 — single-tab correctness via Web
 * Locks is the v1.0 floor.
 *
 * Adapter creation is injected via `setAdapterFactory` so tests can
 * substitute mocks. The production factory selects transformers-adapter
 * vs litert-adapter via `runtime-router`.
 */

import type { ModelConfig } from '../types';
import type {
  AdapterErrorCode,
  ChatMessage,
  GenerateOptions,
  LoadOptions,
  RuntimeAdapter,
  TokenEvent,
} from './types';
import { AdapterError } from './types';
import { acquireGpuOwnership, releaseGpuOwnership } from './gpu-ownership';

// ─── Cooldown ───────────────────────────────────────────────────────────────

const COOLDOWN_STORAGE_KEY = 'eco-local-ai-cooldowns-v1';
// A generation-time fault (mid-decode OOM / device-lost) is usually the
// PROMPT's fault — a long chat overflowing the KV cache — not the model's:
// the same weights reload cleanly in seconds. Cooling the model down for five
// minutes on the first such fault leaves the user staring at a dead chat.
// So the first generation fault only unloads the wedged adapter (a clean
// reload happens on the next send) and records a strike; a SECOND fault while
// the strike is live records the real cooldown. Load-time faults still cool
// down immediately — weights that didn't fit won't fit on retry.
const FAULT_STRIKE_STORAGE_KEY = 'eco-local-ai-fault-strikes-v1';
const COOLDOWN_DEFAULT_MS = 5 * 60 * 1000; // 5 minutes
// 'timeout' is deliberately absent, same reasoning as 'aborted' below: a
// forced-timeout (see raceLoadAgainstSignal) means we gave up waiting, not
// that the device/adapter is confirmed dead — cooling down a model on every
// slow-but-eventually-fine load would be a worse regression than the hang
// it replaces.
const COOLDOWN_TRIGGER_CODES: ReadonlySet<AdapterErrorCode> = new Set([
  'oom',
  'device-lost',
  'init-failed',
]);

// Codes that mean the loaded adapter/GPU device is likely dead — a mid-decode
// OOM or device-lost leaves the WebGPU adapter unusable, and a bare
// generation-failed is safest treated the same way (retrying against a wedged
// adapter just burns ~110ms per failed attempt forever). When generate() ends
// on one of these, we unload the active adapter so the next loadModel does a
// clean re-init instead of reusing the corpse. 'aborted' is deliberately absent
// — a user stop must never unload or cooldown (PR #128 regression territory).
const FAULT_UNLOAD_CODES: ReadonlySet<AdapterErrorCode> = new Set([
  'oom',
  'device-lost',
  'generation-failed',
  // A watchdog timeout means the worker stopped answering; an abort was sent,
  // but a wedged worker may never process it. Unloading guarantees the next
  // send gets a fresh worker instead of a single-flight rejection.
  'timeout',
]);

export type CooldownRecord = {
  modelId: string;
  code: AdapterErrorCode;
  recordedAt: number;
  expiresAt: number;
};

export type LifecycleOptions = {
  /** Override the cooldown duration. Tests pass a small value. */
  cooldownMs?: number;
  /** Override the clock. Tests pass a controllable now(). */
  now?: () => number;
  /**
   * Storage API for cooldown persistence. Default uses globalThis.localStorage
   * when available; tests inject a Map-backed fake.
   */
  storage?: KeyValueStorage;
};

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

type ResolvedLifecycleOptions = {
  cooldownMs: number;
  now: () => number;
  storage: KeyValueStorage | null;
};

// ─── Adapter factory DI seam ───────────────────────────────────────────────

export type AdapterFactory = (model: ModelConfig) => RuntimeAdapter;

let adapterFactory: AdapterFactory | null = null;

export function setAdapterFactory(factory: AdapterFactory | null): void {
  adapterFactory = factory;
}

export function hasAdapterFactory(): boolean {
  return adapterFactory != null;
}

// ─── Lifecycle state ────────────────────────────────────────────────────────

type LifecycleState = {
  options: ResolvedLifecycleOptions;
  activeAdapter: RuntimeAdapter | null;
  activeModel: ModelConfig | null;
  lockQueue: Promise<unknown>;
};

const defaultOptions: ResolvedLifecycleOptions = {
  cooldownMs: COOLDOWN_DEFAULT_MS,
  now: () => Date.now(),
  storage: defaultStorage(),
};

const state: LifecycleState = {
  options: defaultOptions,
  activeAdapter: null,
  activeModel: null,
  lockQueue: Promise.resolve(),
};

function defaultStorage(): KeyValueStorage | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as { localStorage?: KeyValueStorage };
  return g.localStorage ?? null;
}

/**
 * Replace lifecycle options (cooldownMs, clock, storage). Test-only seam.
 * Pass undefined to reset to defaults.
 */
export function configureLifecycle(options?: LifecycleOptions): void {
  state.options = {
    cooldownMs: options?.cooldownMs ?? COOLDOWN_DEFAULT_MS,
    now: options?.now ?? (() => Date.now()),
    storage: options?.storage ?? defaultStorage(),
  };
}

// ─── Public API ────────────────────────────────────────────────────────────

export function getActiveModel(): ModelConfig | null {
  return state.activeModel;
}

export function getActiveAdapter(): RuntimeAdapter | null {
  return state.activeAdapter;
}

/**
 * Load `model` and make it active. If a different model is loaded, unload
 * it first. If the requested model is already loaded, no-op.
 *
 * Throws `AdapterError('cooldown-active', ...)` when the model is on a
 * cooldown from a recent crash. Throws other AdapterErrors when load
 * itself fails — failures matching `COOLDOWN_TRIGGER_CODES` record a
 * cooldown automatically.
 */
export async function loadModel(
  model: ModelConfig,
  options?: LoadOptions,
): Promise<RuntimeAdapter> {
  return runUnderLock(async () => {
    const cooldown = getCooldown(model.id);
    if (cooldown) {
      const remainingSec = Math.ceil((cooldown.expiresAt - state.options.now()) / 1000);
      // Surface as 'cooldown-active' so the shim can route to the dedicated
      // LOCAL_MODEL_COOLDOWN UI branch (preserving the "Ns left" countdown).
      // Using cooldown.code here would collapse to generic OOM/DEVICE_LOST/
      // WORKER_CRASHED messages and lose that timing info.
      throw new AdapterError(
        `${model.friendlyName} is cooling down after a recent crash (${remainingSec}s left).`,
        'cooldown-active',
        true,
      );
    }

    if (state.activeAdapter && state.activeModel?.id === model.id) {
      return state.activeAdapter;
    }

    // Cross-tab GPU ownership: refuse to spin up a second WebGPU device while
    // another tab owns one — that concurrent device init is what crashes the
    // other tab's device. A model already resident here means this tab already
    // owns the GPU, so `acquireGpuOwnership` resolves 'owner' immediately and a
    // mid-session model switch is never blocked; only a cold load with no
    // resident model and another tab active resolves 'blocked'.
    const ownership = await acquireGpuOwnership();
    if (ownership === 'blocked') {
      throw new AdapterError(
        'Eco’s on-device AI is active in another tab. Continue there, or close it to use Eco in this tab.',
        'gpu-busy-other-tab',
        true,
      );
    }

    if (state.activeAdapter) {
      await state.activeAdapter.unload().catch(() => undefined);
      state.activeAdapter = null;
      state.activeModel = null;
    }

    if (!adapterFactory) {
      throw new AdapterError(
        'No adapter factory registered. Call setAdapterFactory at app boot.',
        'init-failed',
        false,
      );
    }

    const adapter = adapterFactory(model);
    const loadPromise = adapter.load(model, options);
    // Set only on the forced-timeout path, where cleanup is DEFERRED to late
    // fulfillment (the non-cooperating load is still in flight). RT-1's eager
    // unload below must not fire there — unloading now can't dispose an engine
    // that materializes afterward, and doing so would race the deferred handler.
    let deferredCleanupRegistered = false;
    try {
      await raceLoadAgainstSignal(loadPromise, options?.signal, () => {
        deferredCleanupRegistered = true;
        // The forced timeout won: this loadModel has already rejected and is
        // about to drop its reference to `adapter`. A non-cooperating load
        // (LiteRT's Engine.create, which cannot be cancelled) can still
        // complete afterwards and adopt a fully-loaded engine — potentially
        // GBs of WASM/WebGPU heap — that the lifecycle state machine will
        // never see or unload. Dispose it best-effort on late fulfillment.
        // Pure resource cleanup: no lifecycle state is touched (the orphan is
        // dead to the state machine). Rejections are swallowed on both the
        // orphaned load and the unload so no interleaving leaks an unhandled
        // rejection, and this only ever runs on the forced-timeout path — the
        // normal success path resolves the race first and never calls back.
        void loadPromise.then(
          () => adapter.unload().catch(() => undefined),
          () => undefined,
        );
      });
    } catch (err) {
      const code = errorCode(err);
      if (COOLDOWN_TRIGGER_CODES.has(code)) {
        recordCooldown(model.id, code);
      }
      // RT-1: a failed or aborted load never reaches `state.activeAdapter =
      // adapter` below, so the lifecycle drops its only reference to this
      // adapter. Terminate its worker here (best-effort) so a multi-GB partial
      // load is not orphaned. Skipped on the forced-timeout path, which owns its
      // own deferred cleanup (see above).
      if (!deferredCleanupRegistered) {
        await adapter.unload().catch(() => undefined);
      }
      throw err;
    }

    state.activeAdapter = adapter;
    state.activeModel = model;
    return adapter;
  });
}

/**
 * Generate through the currently-active adapter. Throws if no adapter is
 * loaded — callers must call `loadModel` first.
 */
export async function* generate(
  messages: ChatMessage[],
  options?: GenerateOptions,
): AsyncIterable<TokenEvent> {
  const adapter = state.activeAdapter;
  if (!adapter) {
    throw new AdapterError(
      'No model loaded. Call loadModel(model) before generate().',
      'init-failed',
      false,
    );
  }
  let crashedCode: AdapterErrorCode | null = null;
  let faultCode: AdapterErrorCode | null = null;
  try {
    for await (const event of adapter.generate(messages, options)) {
      if (event.kind === 'error' && event.code && COOLDOWN_TRIGGER_CODES.has(event.code)) {
        crashedCode = event.code;
      }
      if (event.kind === 'error' && event.code && FAULT_UNLOAD_CODES.has(event.code)) {
        faultCode = event.code;
      }
      yield event;
    }
  } catch (err) {
    crashedCode = errorCode(err);
    const code = errorCode(err);
    if (FAULT_UNLOAD_CODES.has(code)) {
      faultCode = code;
    }
    throw err;
  } finally {
    if (crashedCode && state.activeModel) {
      const modelId = state.activeModel.id;
      if (hasFaultStrike(modelId)) {
        clearFaultStrike(modelId);
        recordCooldown(modelId, crashedCode);
      } else {
        recordFaultStrike(modelId);
      }
    }
    // Drop the dead adapter after a fault so the next loadModel re-inits a
    // fresh WebGPU device instead of retrying against the wedged one. Skip on
    // abort: a user stop leaves the adapter healthy. Fire-and-forget — it runs
    // under the lifecycle lock, so the next loadModel serializes behind it.
    if (faultCode && !options?.signal?.aborted) {
      void unloadActive();
    }
  }
}

/**
 * Unload the active adapter (if any). Always succeeds — best-effort.
 */
export async function unloadActive(): Promise<void> {
  return runUnderLock(async () => {
    const adapter = state.activeAdapter;
    state.activeAdapter = null;
    state.activeModel = null;
    if (adapter) {
      await adapter.unload().catch(() => undefined);
    }
    // This tab no longer holds a model resident, so free the cross-tab GPU
    // lock and let a blocked tab (if any) be promoted to owner.
    releaseGpuOwnership();
  });
}

// ─── Cooldown helpers ──────────────────────────────────────────────────────

export function getCooldown(modelId: string): CooldownRecord | null {
  const records = loadCooldowns();
  const record = records[modelId];
  if (!record) return null;
  if (record.expiresAt <= state.options.now()) {
    delete records[modelId];
    saveCooldowns(records);
    return null;
  }
  return record;
}

export function recordCooldown(modelId: string, code: AdapterErrorCode): CooldownRecord {
  const record: CooldownRecord = {
    modelId,
    code,
    recordedAt: state.options.now(),
    expiresAt: state.options.now() + state.options.cooldownMs,
  };
  const records = loadCooldowns();
  records[modelId] = record;
  saveCooldowns(records);
  return record;
}

export function clearCooldown(modelId?: string): void {
  if (!modelId) {
    saveCooldowns({});
    return;
  }
  const records = loadCooldowns();
  delete records[modelId];
  saveCooldowns(records);
}

// ─── Generation-fault strikes ─────────────────────────────────────────────

type FaultStrikeRecord = { expiresAt: number };

export function hasFaultStrike(modelId: string): boolean {
  const records = loadJson<FaultStrikeRecord>(FAULT_STRIKE_STORAGE_KEY);
  const record = records[modelId];
  if (!record) return false;
  if (record.expiresAt <= state.options.now()) {
    delete records[modelId];
    saveJson(FAULT_STRIKE_STORAGE_KEY, records);
    return false;
  }
  return true;
}

function recordFaultStrike(modelId: string): void {
  const records = loadJson<FaultStrikeRecord>(FAULT_STRIKE_STORAGE_KEY);
  records[modelId] = { expiresAt: state.options.now() + state.options.cooldownMs };
  saveJson(FAULT_STRIKE_STORAGE_KEY, records);
}

export function clearFaultStrike(modelId?: string): void {
  if (!modelId) {
    saveJson(FAULT_STRIKE_STORAGE_KEY, {});
    return;
  }
  const records = loadJson<FaultStrikeRecord>(FAULT_STRIKE_STORAGE_KEY);
  delete records[modelId];
  saveJson(FAULT_STRIKE_STORAGE_KEY, records);
}

function loadCooldowns(): Record<string, CooldownRecord> {
  return loadJson<CooldownRecord>(COOLDOWN_STORAGE_KEY);
}

function saveCooldowns(records: Record<string, CooldownRecord>): void {
  saveJson(COOLDOWN_STORAGE_KEY, records);
}

function loadJson<T>(key: string): Record<string, T> {
  const storage = state.options.storage;
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveJson<T>(key: string, records: Record<string, T>): void {
  const storage = state.options.storage;
  if (!storage) return;
  try {
    if (Object.keys(records).length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(records));
  } catch {
    // Storage write failures are non-fatal — cooldowns degrade to
    // session-scoped silently.
  }
}

// ─── Lock ───────────────────────────────────────────────────────────────────

async function runUnderLock<T>(handler: () => Promise<T>): Promise<T> {
  // Promise-queue lock: each caller awaits the prior, then schedules its
  // own continuation. We don't use the Web Locks API at this layer
  // because lifecycle runs in the main thread + worker boot ordering
  // matters; the simpler queue is testable and deterministic.
  const previous = state.lockQueue;
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  state.lockQueue = previous.then(() => slot);
  try {
    await previous;
    return await handler();
  } finally {
    release();
  }
}

// ─── Test seam ──────────────────────────────────────────────────────────────

/**
 * Reset lifecycle state to defaults — for tests only. Clears active
 * adapter, cooldowns in storage, lock queue, factory registration, and
 * resets options to defaults.
 */
export function _resetLifecycleForTesting(): void {
  state.activeAdapter = null;
  state.activeModel = null;
  state.lockQueue = Promise.resolve();
  state.options = {
    cooldownMs: COOLDOWN_DEFAULT_MS,
    now: () => Date.now(),
    storage: defaultStorage(),
  };
  adapterFactory = null;
  const storage = state.options.storage;
  if (storage) {
    try {
      storage.removeItem(COOLDOWN_STORAGE_KEY);
      storage.removeItem(FAULT_STRIKE_STORAGE_KEY);
    } catch {
      // Best-effort.
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function errorCode(err: unknown): AdapterErrorCode {
  if (err instanceof AdapterError) return err.code;
  return 'generation-failed';
}

/**
 * Force `promise` to settle when `signal` aborts, even when the underlying
 * adapter ignores the signal entirely — confirmed true for LiteRT's
 * `Engine.create()`, which has no cancellation parameter at all, and every
 * caller of `loadModel` (the sustained probe, the smoke gate, switch-model's
 * stall watchdog) already tries to abort a stuck load but has no way to force
 * an unwilling adapter to actually stop waiting.
 *
 * A cooperating adapter (TransformersAdapter) is never second-guessed: its
 * own abort handling rejects `promise` itself, and promise settlement is
 * always a microtask, while our own fallback below is deliberately deferred
 * one macrotask past the abort event (`setTimeout(..., 0)`) — so the
 * adapter's own classification (e.g. 'aborted') always reaches the caller
 * first. Our fallback only ever fires when `promise` never settles on its
 * own, which is exactly the non-cooperating case this exists for.
 *
 * Classified 'timeout', not 'aborted': we gave up waiting, we did not
 * confirm the adapter actually stopped. The abandoned call (if the adapter
 * never settles) keeps running unreferenced in the background — this can't
 * cancel work a library gives no way to cancel, only stop waiting for it.
 *
 * `onForcedTimeout` fires exactly once, and only when the forced-timeout
 * branch wins (never on normal settlement). The caller uses it to dispose an
 * orphaned load that completes after we stopped waiting — see loadModel.
 */
function raceLoadAgainstSignal(
  promise: Promise<void>,
  signal: AbortSignal | undefined,
  onForcedTimeout?: () => void,
): Promise<void> {
  if (!signal) return promise;

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        onForcedTimeout?.();
        reject(new AdapterError(
          'Load did not respond to cancellation in time — treating it as timed out.',
          'timeout',
          true,
        ));
      }, 0);
    };

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );

    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}
