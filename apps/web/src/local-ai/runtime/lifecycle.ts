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
 * vs webllm-adapter via `runtime-router`.
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

// ─── Cooldown ───────────────────────────────────────────────────────────────

const COOLDOWN_STORAGE_KEY = 'eco-local-ai-cooldowns-v1';
const COOLDOWN_DEFAULT_MS = 5 * 60 * 1000; // 5 minutes
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
    try {
      await adapter.load(model, options);
    } catch (err) {
      const code = errorCode(err);
      if (COOLDOWN_TRIGGER_CODES.has(code)) {
        recordCooldown(model.id, code);
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
      recordCooldown(state.activeModel.id, crashedCode);
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

function loadCooldowns(): Record<string, CooldownRecord> {
  const storage = state.options.storage;
  if (!storage) return {};
  try {
    const raw = storage.getItem(COOLDOWN_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CooldownRecord>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveCooldowns(records: Record<string, CooldownRecord>): void {
  const storage = state.options.storage;
  if (!storage) return;
  try {
    if (Object.keys(records).length === 0) {
      storage.removeItem(COOLDOWN_STORAGE_KEY);
      return;
    }
    storage.setItem(COOLDOWN_STORAGE_KEY, JSON.stringify(records));
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
