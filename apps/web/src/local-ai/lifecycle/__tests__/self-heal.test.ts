// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheApiStorage, type CacheLike, type CacheStorageLike } from '../../download/storage';
import { _resetSlotsForTesting, setSlotStorage } from '../slots';
import {
  _resetLifecycleForTesting,
  configureLifecycle,
  type KeyValueStorage as CooldownStorage,
} from '../../runtime/lifecycle';
import { CURRENT_LEDGER_VERSION } from '../../evidence/ledger';
import {
  reconcileReadySlots,
  repairModelCache,
  runSelfHeal,
  type RetiredModelMigration,
} from '../self-heal';
import { setSlot, setSlotStatus, getSlot, readRawSlotIdForMigration } from '../slots';
import type { Slot } from '../../types';

class FakeStorage implements CooldownStorage {
  map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return Array.from(this.map.keys())[i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

class MemoryCache implements CacheLike {
  store = new Map<string, Response>();
  async put(r: RequestInfo | URL, res: Response): Promise<void> { this.store.set(k(r), res.clone()); }
  async match(r: RequestInfo | URL): Promise<Response | undefined> { const v = this.store.get(k(r)); return v ? v.clone() : undefined; }
  async keys(): Promise<readonly Request[]> { return Array.from(this.store.keys()).map((u) => new Request(u)); }
  async delete(r: RequestInfo | URL): Promise<boolean> { return this.store.delete(k(r)); }
}
class MemoryCacheStorage implements CacheStorageLike {
  caches = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> { let c = this.caches.get(name); if (!c) { c = new MemoryCache(); this.caches.set(name, c); } return c; }
  async has(name: string): Promise<boolean> { return this.caches.has(name); }
  async keys(): Promise<string[]> { return Array.from(this.caches.keys()); }
  async delete(name: string): Promise<boolean> { return this.caches.delete(name); }
}
function k(r: RequestInfo | URL): string { if (typeof r === 'string') return r; if (r instanceof URL) return r.toString(); return r.url; }

let storage: FakeStorage;
let nowMs: number;

beforeEach(() => {
  storage = new FakeStorage();
  setSlotStorage(storage);
  configureLifecycle({ storage, now: () => nowMs });
  nowMs = 1_000_000;
});

afterEach(() => {
  _resetSlotsForTesting();
  _resetLifecycleForTesting();
});

// ─── Artifact-swap evidence migration (350m q4f16 → q4, 2026-07-01) ─────────
//
// When a catalog model's artifact is replaced in place (same id, new weight
// files), stale ledger rows from the OLD build would keep the confidence floor
// excluding the fixed build, and the old weights would linger as dead cache
// bytes. The migration clears both exactly once per device (marker-guarded)
// and must never crash boot.

describe('runSelfHeal — artifact-swap evidence migration', () => {
  const LFM350 = 'candidate/lfm2.5-350m-onnx';
  const MARKER = 'eco-local-ai-mig-350m-q4-v1';
  const LEDGER_KEY = 'eco-local-ai-ledger-v1';
  // cacheNameFor(): 'eco-local-ai-' + modelId with [^a-zA-Z0-9._-] → '_'.
  const LFM350_CACHE = 'eco-local-ai-candidate_lfm2.5-350m-onnx';
  const BONSAI_CACHE = 'eco-local-ai-local_bonsai-1.7b-q4';

  const ledgerRow = (modelId: string) => ({
    modelId,
    profileKey: 'chromium|high-memory-laptop|webgpu',
    outcome: 'smoke-fail',
    recordedAt: new Date().toISOString(),
    ledgerVersion: CURRENT_LEDGER_VERSION,
  });

  beforeEach(() => {
    localStorage.removeItem(LEDGER_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(LEDGER_KEY);
  });

  it('clears the model ledger rows + cache namespace once and writes the marker', async () => {
    localStorage.setItem(
      LEDGER_KEY,
      JSON.stringify([ledgerRow(LFM350), ledgerRow('local/bonsai-1.7b-q4')]),
    );
    const cacheBackend = new MemoryCacheStorage();
    await cacheBackend.open(LFM350_CACHE);
    await cacheBackend.open(BONSAI_CACHE);

    const report = await runSelfHeal({
      now: () => nowMs,
      storage,
      cacheStorage: new CacheApiStorage(cacheBackend),
      resolveEcoFastDefault: () => null,
    });

    expect(report.errors).toEqual([]);
    expect(report.artifactMigrationsRun).toEqual([LFM350]);
    expect(storage.getItem(MARKER)).not.toBeNull();
    // Only the migrated model's evidence is touched.
    const entries = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as Array<{ modelId: string }>;
    expect(entries.map((e) => e.modelId)).toEqual(['local/bonsai-1.7b-q4']);
    // Only the migrated model's cache namespace is dropped.
    expect(cacheBackend.caches.has(LFM350_CACHE)).toBe(false);
    expect(cacheBackend.caches.has(BONSAI_CACHE)).toBe(true);
  });

  it("flips a ready slot bound to the migrated model to 'preparing' (its cache was just wiped)", async () => {
    setSlot('eco-fast', LFM350);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({
      now: () => nowMs,
      storage,
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      resolveEcoFastDefault: () => null,
    });

    expect(report.artifactMigrationsRun).toEqual([LFM350]);
    // Binding unchanged, status flipped: the setup pipeline re-downloads the
    // new artifact through the full download path instead of leaving a ready
    // slot pointing at an empty cache.
    expect(getSlot('eco-fast').modelId).toBe(LFM350);
    expect(getSlot('eco-fast').status).toBe('preparing');
  });

  it('leaves ready slots bound to OTHER models untouched', async () => {
    setSlot('eco-fast', 'candidate/qwen3.5-2b-onnx');
    setSlotStatus('eco-fast', 'ready');

    await runSelfHeal({
      now: () => nowMs,
      storage,
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      resolveEcoFastDefault: () => null,
    });

    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('no-ops when the marker is already present', async () => {
    storage.setItem(MARKER, '123');
    localStorage.setItem(LEDGER_KEY, JSON.stringify([ledgerRow(LFM350)]));
    const cacheBackend = new MemoryCacheStorage();
    await cacheBackend.open(LFM350_CACHE);

    const report = await runSelfHeal({
      now: () => nowMs,
      storage,
      cacheStorage: new CacheApiStorage(cacheBackend),
      resolveEcoFastDefault: () => null,
    });

    expect(report.artifactMigrationsRun).toEqual([]);
    const entries = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as Array<{ modelId: string }>;
    expect(entries).toHaveLength(1);
    expect(cacheBackend.caches.has(LFM350_CACHE)).toBe(true);
  });

  it('records the error and leaves the marker unset when the cache clear throws (retries next boot)', async () => {
    class ExplodingStorage extends CacheApiStorage {
      override async clearModel(): Promise<void> {
        throw new Error('cache down');
      }
    }

    const report = await runSelfHeal({
      now: () => nowMs,
      storage,
      cacheStorage: new ExplodingStorage(new MemoryCacheStorage()),
      resolveEcoFastDefault: () => null,
    });

    expect(report.artifactMigrationsRun).toEqual([]);
    expect(report.errors.some((e) => e.includes('artifact-migration'))).toBe(true);
    expect(storage.getItem(MARKER)).toBeNull();
  });
});

// ─── Retired-model migration (generic mechanism; C1 SmolLM2 is the first user) ─
//
// Retiring a model from the catalog leaves orphaned per-device state a live id
// would own: weight bytes, evidence rows, a slot binding, a persisted
// selection, a pending upgrade record, and (for a retired runtime) its own
// private caches. This once-per-device migration purges all of it, rebinds/
// clears the affected slots, and — only when the user was actually on the
// model — leaves a one-time notice hint. Exercised here via a synthetic entry
// through the `retiredMigrations` seam so the mechanism is covered without a
// real catalog removal.

describe('runSelfHeal — retired-model migration', () => {
  const RETIRED_ID = 'local/retired-model-q4';
  const MARKER = 'eco-local-ai-mig-retire-test-v1';
  const NOTICE_HINT_KEY = 'eco-local-ai-retired-notice-v1';
  const LEDGER_KEY = 'eco-local-ai-ledger-v1';
  const UPGRADE_KEY = 'eco-local-ai-upgrade-v1';
  const QWEN = 'candidate/qwen3.5-2b-onnx';
  // cacheNameFor(): 'eco-local-ai-' + modelId with [^a-zA-Z0-9._-] → '_'.
  const RETIRED_CACHE = 'eco-local-ai-local_retired-model-q4';
  const SENTINEL_CACHE = 'eco-local-ai-candidate_gemma-4-e2b-litert';

  const migration: RetiredModelMigration = {
    modelId: RETIRED_ID,
    friendlyLabel: 'Retired Test Model',
    markerKey: MARKER,
    extraCacheNames: ['ext/cache-a', 'ext/cache-b'],
  };

  const ledgerRow = (modelId: string) => ({
    modelId,
    profileKey: 'chromium|high-memory-laptop|webgpu',
    outcome: 'smoke-fail',
    recordedAt: new Date().toISOString(),
    ledgerVersion: CURRENT_LEDGER_VERSION,
  });

  function seamOptions(cacheBackend?: MemoryCacheStorage) {
    const backend = cacheBackend ?? new MemoryCacheStorage();
    return {
      now: () => nowMs,
      storage,
      cacheStorage: new CacheApiStorage(backend),
      deleteCacheByName: (name: string) => backend.delete(name).then(() => undefined),
      retiredMigrations: [migration],
      resolveEcoFastDefault: () => QWEN,
    };
  }

  beforeEach(() => {
    localStorage.removeItem(LEDGER_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(LEDGER_KEY);
  });

  it('purges evidence + the model cache + the retired runtime caches and writes the marker last', async () => {
    localStorage.setItem(
      LEDGER_KEY,
      JSON.stringify([ledgerRow(RETIRED_ID), ledgerRow(QWEN)]),
    );
    const backend = new MemoryCacheStorage();
    await backend.open(RETIRED_CACHE);
    await backend.open('ext/cache-a');
    await backend.open('ext/cache-b');

    const report = await runSelfHeal(seamOptions(backend));

    expect(report.errors).toEqual([]);
    expect(report.retiredModelMigrationsRun).toEqual([RETIRED_ID]);
    expect(storage.getItem(MARKER)).not.toBeNull();
    // Only the retired model's evidence is dropped.
    const entries = JSON.parse(localStorage.getItem(LEDGER_KEY) ?? '[]') as Array<{ modelId: string }>;
    expect(entries.map((e) => e.modelId)).toEqual([QWEN]);
    // The model namespace and both extra runtime caches are gone.
    expect(backend.caches.has(RETIRED_CACHE)).toBe(false);
    expect(backend.caches.has('ext/cache-a')).toBe(false);
    expect(backend.caches.has('ext/cache-b')).toBe(false);
  });

  it('NEVER deletes any eco-local-ai-* cache other than the retired model namespace (scoping sentinel)', async () => {
    const backend = new MemoryCacheStorage();
    await backend.open(RETIRED_CACHE);
    await backend.open(SENTINEL_CACHE); // a DIFFERENT model's cache — must survive
    await backend.open('ext/cache-a');

    await runSelfHeal(seamOptions(backend));

    expect(backend.caches.has(RETIRED_CACHE)).toBe(false);
    expect(backend.caches.has('ext/cache-a')).toBe(false);
    // The sentinel — a surviving model's own namespace — is untouched.
    expect(backend.caches.has(SENTINEL_CACHE)).toBe(true);
  });

  it('rebinds an eco-fast slot on the retired id to the device default and fires the notice', async () => {
    setSlot('eco-fast', RETIRED_ID);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal(seamOptions());

    expect(report.retiredModelMigrationsRun).toEqual([RETIRED_ID]);
    // Rebound to the recommendation, 'preparing' so the pipeline downloads it.
    expect(readRawSlotIdForMigration('eco-fast')).toBe(QWEN);
    expect(getSlot('eco-fast').status).toBe('preparing');
    // Rode the default while the slot held the id → notice warranted.
    const hint = JSON.parse(storage.getItem(NOTICE_HINT_KEY) ?? 'null') as { label?: string } | null;
    expect(hint?.label).toBe('Retired Test Model');
  });

  it('detects the retired id from a LEGACY slot key and rebinds', async () => {
    storage.setItem('eco-model-slot-eco-fast', RETIRED_ID);

    await runSelfHeal(seamOptions());

    // Canonical key now holds the rebind target (setSlot writes it).
    expect(readRawSlotIdForMigration('eco-fast')).toBe(QWEN);
    expect(storage.getItem(NOTICE_HINT_KEY)).not.toBeNull();
  });

  it('clears (does not rebind) an eco-smart slot on the retired id', async () => {
    setSlot('eco-smart', RETIRED_ID);
    setSlotStatus('eco-smart', 'ready');

    await runSelfHeal(seamOptions());

    // Cleared — nothing drives an undriven 'preparing' smart slot.
    expect(readRawSlotIdForMigration('eco-smart')).toBeNull();
    expect(getSlot('eco-smart').status).toBe('empty');
  });

  it('drops the eco-fast binding when the device is below the assignable floor (resolver null)', async () => {
    setSlot('eco-fast', RETIRED_ID);
    const report = await runSelfHeal({ ...seamOptions(), resolveEcoFastDefault: () => null });
    expect(report.errors).toEqual([]);
    expect(readRawSlotIdForMigration('eco-fast')).toBeNull();
  });

  it('rewrites an explicit selection of the retired id to eco-fast, demotes the flag, and fires the notice', async () => {
    storage.setItem('eco-selected-model', RETIRED_ID);
    storage.setItem('eco-selected-model-explicit', 'true');

    await runSelfHeal(seamOptions());

    expect(storage.getItem('eco-selected-model')).toBe('eco-fast');
    // Retirement is the sanctioned exception to explicit-choice exemption — a
    // retired pick cannot be honored, so the flag is demoted.
    expect(storage.getItem('eco-selected-model-explicit')).toBe('false');
    expect(storage.getItem(NOTICE_HINT_KEY)).not.toBeNull();
  });

  it('does NOT fire the notice for a user who was on a different model', async () => {
    setSlot('eco-fast', QWEN);
    setSlotStatus('eco-fast', 'ready');
    storage.setItem('eco-selected-model', QWEN);

    const report = await runSelfHeal(seamOptions());

    expect(report.retiredModelMigrationsRun).toEqual([RETIRED_ID]);
    expect(storage.getItem(MARKER)).not.toBeNull();
    // Never on the retired model → no toast, and their slot/selection are left alone.
    expect(storage.getItem(NOTICE_HINT_KEY)).toBeNull();
    expect(readRawSlotIdForMigration('eco-fast')).toBe(QWEN);
    expect(storage.getItem('eco-selected-model')).toBe(QWEN);
  });

  it('clears a pending upgrade record that targets or is based on the retired id', async () => {
    storage.setItem(
      UPGRADE_KEY,
      JSON.stringify({ version: 1, phase: 'offered', targetModelId: RETIRED_ID, baseModelId: null }),
    );
    await runSelfHeal(seamOptions());
    expect(storage.getItem(UPGRADE_KEY)).toBeNull();
  });

  it('leaves a pending upgrade record for a different model untouched', async () => {
    const record = JSON.stringify({ version: 1, phase: 'offered', targetModelId: QWEN, baseModelId: null });
    storage.setItem(UPGRADE_KEY, record);
    await runSelfHeal(seamOptions());
    expect(storage.getItem(UPGRADE_KEY)).toBe(record);
  });

  it('is idempotent — the marker guard skips the migration on the second boot', async () => {
    setSlot('eco-fast', RETIRED_ID);
    const first = await runSelfHeal(seamOptions());
    expect(first.retiredModelMigrationsRun).toEqual([RETIRED_ID]);

    // Second boot: marker present → skipped, no re-work.
    const second = await runSelfHeal(seamOptions());
    expect(second.retiredModelMigrationsRun).toEqual([]);
    expect(readRawSlotIdForMigration('eco-fast')).toBe(QWEN);
  });

  it('records the error and leaves the marker unset when a purge step throws (retries next boot)', async () => {
    class ExplodingStorage extends CacheApiStorage {
      override async clearModel(): Promise<void> {
        throw new Error('cache down');
      }
    }
    setSlot('eco-fast', RETIRED_ID);

    const report = await runSelfHeal({
      now: () => nowMs,
      storage,
      cacheStorage: new ExplodingStorage(new MemoryCacheStorage()),
      retiredMigrations: [migration],
      resolveEcoFastDefault: () => QWEN,
    });

    expect(report.retiredModelMigrationsRun).toEqual([]);
    expect(report.errors.some((e) => e.includes('retired-migration'))).toBe(true);
    expect(storage.getItem(MARKER)).toBeNull();
    // Threw before the notice step — no half-applied hint.
    expect(storage.getItem(NOTICE_HINT_KEY)).toBeNull();
  });

  it('runs BEFORE the former-default rebind: a retired eco-fast slot is rebound by THIS migration', async () => {
    // The retired id is not a former everyday default, so if the retirement
    // migration did not run first, the former-default block would leave it (and
    // getSlot would read empty). Instead it rebinds to the recommendation and
    // the former-default block then sees a current-default binding → no-op.
    setSlot('eco-fast', RETIRED_ID);

    const report = await runSelfHeal(seamOptions());

    expect(report.retiredModelMigrationsRun).toEqual([RETIRED_ID]);
    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(readRawSlotIdForMigration('eco-fast')).toBe(QWEN);
  });

  it('is a no-op with no migrations configured (default empty module const)', async () => {
    setSlot('eco-fast', RETIRED_ID);
    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });
    expect(report.retiredModelMigrationsRun).toEqual([]);
    // Untouched: the raw retired binding survives (getSlot still nulls it).
    expect(readRawSlotIdForMigration('eco-fast')).toBe(RETIRED_ID);
  });
});

// ─── Former-default slot migration (device-aware; everyday-swap 2026-06-13) ──
//
// An eco-fast slot bound to a model that was once the everyday default (Bonsai,
// or LFM2.5 after the swap) migrates to the CURRENT device-appropriate default
// — resolved via an injectable seam (production: recommend('eco-fast', profile)).
// The migration is device-aware (low-memory devices stay on LFM2.5) and
// explicit-choice exempt (deliberate pickers are never auto-migrated).

describe('runSelfHeal — former-default slot migration', () => {
  const QWEN = 'candidate/qwen3.5-2b-onnx';
  const LFM = 'candidate/lfm2.5-1.2b-instruct-onnx';
  const BONSAI = 'local/bonsai-1.7b-q4';

  it('rebinds an eco-fast slot stuck on Bonsai (fully demoted) to the device-appropriate default', async () => {
    setSlot('eco-fast', BONSAI);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });

    expect(report.staleDefaultSlotMigrated).toBe(true);
    const fast = getSlot('eco-fast');
    expect(fast.modelId).toBe(QWEN);
    // 'preparing' so the readiness pipeline verifies/downloads before first use.
    expect(fast.status).toBe('preparing');
  });

  it('rebinds an eco-fast slot stuck on the superseded LFM2.5 default to Qwen3.5 on capable devices', async () => {
    setSlot('eco-fast', LFM);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });

    expect(report.staleDefaultSlotMigrated).toBe(true);
    expect(getSlot('eco-fast').modelId).toBe(QWEN);
    expect(getSlot('eco-fast').status).toBe('preparing');
  });

  it('leaves LFM2.5 bound where it is STILL the device-appropriate default (low-memory no-op)', async () => {
    // On a device where Qwen3.5 isn't assignable, recommend('eco-fast') returns
    // LFM2.5 itself → target === bound → the migration no-ops. This is why LFM2.5
    // can sit in FORMER_EVERYDAY_DEFAULT_IDS without stranding low-end devices.
    setSlot('eco-fast', LFM);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => LFM });

    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(getSlot('eco-fast').modelId).toBe(LFM);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('leaves an eco-fast binding to the current default (Qwen) untouched', async () => {
    setSlot('eco-fast', QWEN);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });

    // Qwen isn't in FORMER_EVERYDAY_DEFAULT_IDS → the block is skipped entirely.
    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(getSlot('eco-fast').modelId).toBe(QWEN);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('does NOT migrate when the user explicitly chose their model (explicit-choice exempt)', async () => {
    // A deliberate LFM2.5 picker keeps it — and never gets a surprise 1.4GB
    // Qwen re-download.
    setSlot('eco-fast', LFM);
    setSlotStatus('eco-fast', 'ready');
    storage.setItem('eco-selected-model-explicit', 'true');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });

    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(getSlot('eco-fast').modelId).toBe(LFM);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('does nothing (no crash) when the device is below the assignable floor (resolver returns null)', async () => {
    setSlot('eco-fast', BONSAI);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => null });

    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(report.errors).toEqual([]);
    expect(getSlot('eco-fast').modelId).toBe(BONSAI);
  });

  it('does nothing when eco-fast is empty', async () => {
    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });
    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(getSlot('eco-fast').modelId).toBeNull();
  });

  it('does not touch the eco-smart slot', async () => {
    setSlot('eco-smart', BONSAI);
    setSlotStatus('eco-smart', 'ready');

    const report = await runSelfHeal({ now: () => nowMs, storage, resolveEcoFastDefault: () => QWEN });

    expect(report.staleDefaultSlotMigrated).toBe(false);
    expect(getSlot('eco-smart').modelId).toBe(BONSAI);
  });
});

// ─── Stale download markers ───────────────────────────────────────────────

describe('runSelfHeal — download markers', () => {
  it('clears markers older than 5 minutes', async () => {
    const oldTs = nowMs - 6 * 60 * 1000;
    storage.setItem('eco-local-ai-download-in-progress-local/a', String(oldTs));
    storage.setItem('eco-model-download-in-progress:local/b', String(oldTs));

    const report = await runSelfHeal({ now: () => nowMs, storage });
    expect(report.staleDownloadMarkersCleared).toBe(2);
    expect(storage.getItem('eco-local-ai-download-in-progress-local/a')).toBeNull();
    expect(storage.getItem('eco-model-download-in-progress:local/b')).toBeNull();
  });

  it('keeps markers younger than 5 minutes', async () => {
    storage.setItem('eco-local-ai-download-in-progress-local/a', String(nowMs - 60_000));
    const report = await runSelfHeal({ now: () => nowMs, storage });
    expect(report.staleDownloadMarkersCleared).toBe(0);
    expect(storage.getItem('eco-local-ai-download-in-progress-local/a')).not.toBeNull();
  });

  it('removes markers with malformed values immediately', async () => {
    storage.setItem('eco-local-ai-download-in-progress-local/a', 'not-a-number');
    const report = await runSelfHeal({ now: () => nowMs, storage });
    expect(report.staleDownloadMarkersCleared).toBe(1);
  });

  it('reads JSON-shaped markers with startedAt', async () => {
    storage.setItem('eco-local-ai-download-in-progress-local/a', JSON.stringify({ startedAt: nowMs - 10_000 }));
    const report = await runSelfHeal({ now: () => nowMs, storage });
    expect(report.staleDownloadMarkersCleared).toBe(0);
  });
});

// ─── Stale smoke markers ───────────────────────────────────────────────────

describe('runSelfHeal — smoke markers', () => {
  it('removes smoke markers for models not assigned to any slot', async () => {
    storage.setItem('eco-local-model-smoke-ready-v1:local/orphan-model', '1');
    const report = await runSelfHeal({ now: () => nowMs, storage });
    expect(report.staleSmokeMarkersCleared).toBe(1);
    expect(storage.getItem('eco-local-model-smoke-ready-v1:local/orphan-model')).toBeNull();
  });

  it('keeps smoke markers for models assigned to a slot', async () => {
    storage.setItem('eco-local-ai-slot-eco-fast', 'local/phi3-mini-4k-q4f16');
    storage.setItem('eco-local-model-smoke-ready-v1:local/phi3-mini-4k-q4f16', '1');
    const report = await runSelfHeal({ now: () => nowMs, storage });
    expect(report.staleSmokeMarkersCleared).toBe(0);
    expect(storage.getItem('eco-local-model-smoke-ready-v1:local/phi3-mini-4k-q4f16')).not.toBeNull();
  });
});

// Cooldown expiry is lazy: runtime/lifecycle.getCooldown auto-clears
// expired records on every read. There is nothing for self-heal to do
// at boot, and no metric to assert here. See self-heal.ts §SelfHealReport.

// ─── Legacy slot migration ─────────────────────────────────────────────────

describe('runSelfHeal — legacy migration', () => {
  it('counts the legacy → new slot key migrations triggered during heal', async () => {
    storage.setItem('eco-model-slot-eco-fast', 'local/phi3-mini-4k-q4f16');
    storage.setItem('eco-slot-eco-smart', 'local/qwen3-0.6b');
    const report = await runSelfHeal({ now: () => nowMs, storage });
    // Both legacy keys triggered a migration via the slots.ts read path
    // (getAllSlots inside runSelfHeal).
    expect(report.legacySlotKeysMigrated).toBeGreaterThanOrEqual(2);
  });
});

describe('runSelfHeal — expired-lease sweep', () => {
  it('invokes the lease sweep at boot (best-effort, via the seam)', async () => {
    const sweepExpiredLeases = vi.fn();
    await runSelfHeal({ now: () => nowMs, storage, sweepExpiredLeases });
    expect(sweepExpiredLeases).toHaveBeenCalledTimes(1);
  });

  it('records a lease-sweep error without crashing boot', async () => {
    const sweepExpiredLeases = vi.fn(() => { throw new Error('lease boom'); });
    const report = await runSelfHeal({ now: () => nowMs, storage, sweepExpiredLeases });
    expect(report.errors.some((e) => e.includes('lease-sweep') && e.includes('lease boom'))).toBe(true);
  });
});

// ─── repairModelCache ──────────────────────────────────────────────────────

describe('repairModelCache', () => {
  it('removes files that fail verify and leaves valid ones alone', async () => {
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    const modelId = 'local/phi3-mini-4k-q4f16';

    await cacheStorage.put({ modelId, url: 'https://hf/good.bin' }, new Response(new Uint8Array(10)));
    await cacheStorage.put({ modelId, url: 'https://hf/bad.bin' }, new Response(new Uint8Array(7)));

    const result = await repairModelCache(
      modelId,
      [
        { url: 'https://hf/good.bin', sizeBytes: 10 }, // size matches
        { url: 'https://hf/bad.bin', sizeBytes: 99 },  // size mismatch
      ],
      { storage: cacheStorage },
    );

    expect(result.removed).toBe(1);
    expect(await cacheStorage.has({ modelId, url: 'https://hf/good.bin' })).toBe(true);
    expect(await cacheStorage.has({ modelId, url: 'https://hf/bad.bin' })).toBe(false);
  });

  it('counts wholly-missing files as missing and deletes nothing', async () => {
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    const removeSpy = vi.spyOn(cacheStorage, 'remove');
    const result = await repairModelCache(
      'local/phi3-mini-4k-q4f16',
      [{ url: 'https://hf/missing.bin', sizeBytes: 5 }],
      { storage: cacheStorage },
    );
    expect(result.removed).toBe(0);
    expect(result.missing).toBe(1);
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

// ─── reconcileReadySlots (boot wiring) ────────────────────────────────────

describe('reconcileReadySlots', () => {
  const MODEL_ID = 'local/phi3-mini-4k-q4f16';
  const PLAN = [
    { url: 'https://hf/config.json', sizeBytes: 100 },
    { url: 'https://hf/weights.bin', sizeBytes: 1_000 },
  ];

  it('skips slots that are not in ready status', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'preparing');

    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    const report = await reconcileReadySlots(async () => PLAN, { cacheStorage });

    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('preparing');
  });

  it('leaves a ready slot alone when its cache verifies', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Populate cache with correctly-sized entries.
    for (const file of PLAN) {
      await cacheStorage.put(
        { modelId: MODEL_ID, url: file.url },
        new Response(new Uint8Array(file.sizeBytes)),
      );
    }

    const report = await reconcileReadySlots(async () => PLAN, { cacheStorage });

    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('flips slot to preparing when cache files fail verify, and reports the repair', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Wrong size for one entry, correct for the other.
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[0]!.url },
      new Response(new Uint8Array(PLAN[0]!.sizeBytes)),
    );
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[1]!.url },
      new Response(new Uint8Array(7)), // wrong byte count
    );

    const repaired: Array<{ modelId: string; slot: Slot; removed: number }> = [];
    const report = await reconcileReadySlots(async () => PLAN, {
      cacheStorage,
      onCacheRepaired: (info) => { repaired.push(info); },
    });

    expect(report.slotsFlippedToPreparing).toEqual(['eco-fast']);
    expect(report.modelsRepaired).toHaveLength(1);
    expect(report.modelsRepaired[0]!.modelId).toBe(MODEL_ID);
    expect(report.modelsRepaired[0]!.removed).toBe(1);
    expect(report.modelsRepaired[0]!.missing).toBe(0);
    expect(getSlot('eco-fast').status).toBe('preparing');
    expect(repaired).toEqual([{ modelId: MODEL_ID, slot: 'eco-fast', removed: 1 }]);
  });

  it('flips a ready slot to preparing on a wholly-missing file, deletes nothing, and does NOT fire onCacheRepaired', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Cache is empty: every planned file is wholly missing (the interrupted
    // download the reload left the slot falsely 'ready' on).
    const removeSpy = vi.spyOn(cacheStorage, 'remove');

    const repaired: Array<{ modelId: string; slot: Slot; removed: number }> = [];
    const report = await reconcileReadySlots(async () => PLAN, {
      cacheStorage,
      onCacheRepaired: (info) => { repaired.push(info); },
    });

    expect(report.slotsFlippedToPreparing).toEqual(['eco-fast']);
    expect(report.modelsRepaired).toEqual([{ modelId: MODEL_ID, removed: 0, missing: PLAN.length }]);
    expect(getSlot('eco-fast').status).toBe('preparing');
    expect(removeSpy).not.toHaveBeenCalled();
    // "We cleaned up your cache" would be untruthful — nothing was there to clean.
    expect(repaired).toEqual([]);
  });

  it('skips a slot whose plan resolver returns null (unknown model)', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());

    const report = await reconcileReadySlots(async () => null, { cacheStorage });
    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('collects per-slot resolver errors without crashing', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());

    const report = await reconcileReadySlots(
      async () => { throw new Error('boom'); },
      { cacheStorage },
    );
    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(MODEL_ID);
    expect(report.errors[0]).toContain('boom');
  });

  it('is idempotent — calling twice on a now-preparing slot is a no-op', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Plant a mismatch
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[0]!.url },
      new Response(new Uint8Array(7)),
    );

    const first = await reconcileReadySlots(async () => PLAN, { cacheStorage });
    expect(first.slotsFlippedToPreparing).toEqual(['eco-fast']);

    // Second call sees status='preparing', skips.
    const second = await reconcileReadySlots(async () => PLAN, { cacheStorage });
    expect(second.slotsFlippedToPreparing).toEqual([]);
  });

  it('skips reconciliation entirely when cache verification is forced (harness fixtures)', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Empty cache: without the seam this ready slot would flip on missing files.
    const planResolver = vi.fn(async () => PLAN);
    const onCacheRepaired = vi.fn();

    const report = await reconcileReadySlots(planResolver, {
      cacheStorage,
      onCacheRepaired,
      isCacheVerificationForced: () => true,
    });

    // No plan resolved, no repair, no flip, empty report — the slot stays ready.
    expect(planResolver).not.toHaveBeenCalled();
    expect(onCacheRepaired).not.toHaveBeenCalled();
    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('still reconciles when the seam returns false (default missing-file flip preserved)', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    const report = await reconcileReadySlots(async () => PLAN, {
      cacheStorage,
      isCacheVerificationForced: () => false,
    });
    expect(report.slotsFlippedToPreparing).toEqual(['eco-fast']);
    expect(getSlot('eco-fast').status).toBe('preparing');
  });

  it('handles multiple ready slots in one pass', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const smartId = 'local/smollm2-1.7b-webllm-q4f16';
    setSlot('eco-smart', smartId);
    setSlotStatus('eco-smart', 'ready');

    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Fast slot ok; smart slot has a bad entry.
    for (const file of PLAN) {
      await cacheStorage.put(
        { modelId: MODEL_ID, url: file.url },
        new Response(new Uint8Array(file.sizeBytes)),
      );
    }
    await cacheStorage.put(
      { modelId: smartId, url: 'https://hf/smart.bin' },
      new Response(new Uint8Array(11)),
    );

    const report = await reconcileReadySlots(async (modelId) => {
      if (modelId === MODEL_ID) return PLAN;
      return [{ url: 'https://hf/smart.bin', sizeBytes: 999 }];
    }, { cacheStorage });

    expect(report.slotsFlippedToPreparing).toEqual(['eco-smart']);
    expect(getSlot('eco-fast').status).toBe('ready');
    expect(getSlot('eco-smart').status).toBe('preparing');
  });
});
