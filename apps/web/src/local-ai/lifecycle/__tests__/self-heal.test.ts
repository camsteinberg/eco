// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheApiStorage, modelCacheName, type CacheLike, type CacheStorageLike } from '../../download/storage';
import { _resetSlotsForTesting, setSlotStorage } from '../slots';
import {
  _resetLifecycleForTesting,
  configureLifecycle,
  type KeyValueStorage as CooldownStorage,
} from '../../runtime/lifecycle';
import {
  reconcilePreparingSlots,
  reconcileReadySlots,
  repairModelCache,
  runSelfHeal,
  type SelfHealOptions,
} from '../self-heal';
import { setSlot, setSlotStatus, getSlot } from '../slots';
import { getModel } from '../../catalog/catalog';
import { WEBKIT_MOBILE_VALIDATED_MODEL_IDS } from '../../device/compatibility';
import type { DeviceProfile, ModelConfig, Slot } from '../../types';

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

// ─── WebKit-mobile re-gate (D1 designed tier) ──────────────────────────────
//
// A device primed BEFORE the WebKit-mobile gate shipped (the founder's iPhone,
// bound during the pre-gate crash-loop spike; prod still serves that population)
// holds a slot bound to a model that crash-loops the tab on load. Boot must
// demote it so the next setup run re-enters recommend → below-floor, instead of
// resuming the doomed load off cached partial bytes.

describe('runSelfHeal — WebKit-mobile re-gate', () => {
  const QWEN_FLOOR = 'local/qwen3-0.6b';
  const SMART = 'candidate/qwen3.5-2b-onnx';

  const iosWebKit: DeviceProfile = {
    browserClass: 'safari',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 4,
    isMobile: true,
    override: 'auto',
  };
  const safariDesktop: DeviceProfile = {
    browserClass: 'safari',
    webgpuSupport: 'wasm-only',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  };
  const chromiumDesktop: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  };

  it('clears both bound slots on iOS WebKit so the next setup re-enters below-floor', async () => {
    setSlot('eco-fast', QWEN_FLOOR);
    setSlotStatus('eco-fast', 'ready');
    setSlot('eco-smart', SMART);
    setSlotStatus('eco-smart', 'preparing');

    const report = await runSelfHeal({
      storage,
      resolveDeviceProfile: () => iosWebKit,
    });

    expect(report.errors).toEqual([]);
    expect(report.webkitMobileSlotsRegated).toEqual(['eco-fast', 'eco-smart']);
    // Both slots are now empty → the setup runner re-runs recommend, which
    // throws NoAssignableModelError on iOS WebKit → the designed mobile surface.
    expect(getSlot('eco-fast').modelId).toBeNull();
    expect(getSlot('eco-fast').status).toBe('empty');
    expect(getSlot('eco-smart').modelId).toBeNull();
    expect(getSlot('eco-smart').status).toBe('empty');
  });

  it('leaves a desktop Safari slot untouched (not WebKit-mobile)', async () => {
    setSlot('eco-fast', QWEN_FLOOR);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({
      storage,
      resolveDeviceProfile: () => safariDesktop,
    });

    expect(report.webkitMobileSlotsRegated).toEqual([]);
    expect(getSlot('eco-fast').modelId).toBe(QWEN_FLOOR);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('is a no-op on a non-WebKit-mobile profile (Chromium desktop)', async () => {
    setSlot('eco-fast', SMART);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({
      storage,
      resolveDeviceProfile: () => chromiumDesktop,
    });

    expect(report.webkitMobileSlotsRegated).toEqual([]);
    expect(getSlot('eco-fast').modelId).toBe(SMART);
  });

  it('respects the validated-list override — a listed model keeps its slot', async () => {
    (WEBKIT_MOBILE_VALIDATED_MODEL_IDS as string[]).push(QWEN_FLOOR);
    try {
      setSlot('eco-fast', QWEN_FLOOR);
      setSlotStatus('eco-fast', 'ready');

      const report = await runSelfHeal({
          storage,
        resolveDeviceProfile: () => iosWebKit,
      });

      expect(report.webkitMobileSlotsRegated).toEqual([]);
      expect(getSlot('eco-fast').modelId).toBe(QWEN_FLOOR);
      expect(getSlot('eco-fast').status).toBe('ready');
    } finally {
      // Remove only what this test pushed — `length = 0` would also wipe the
      // real catalog entries and poison every later test in this module.
      const list = WEBKIT_MOBILE_VALIDATED_MODEL_IDS as string[];
      const pushed = list.indexOf(QWEN_FLOOR);
      if (pushed >= 0) list.splice(pushed, 1);
    }
  });

  it('does nothing (no crash) when both slots are empty on iOS WebKit', async () => {
    const report = await runSelfHeal({
      storage,
      resolveDeviceProfile: () => iosWebKit,
    });

    expect(report.errors).toEqual([]);
    expect(report.webkitMobileSlotsRegated).toEqual([]);
  });
});

describe('runSelfHeal — expired-lease sweep', () => {
  it('invokes the lease sweep at boot (best-effort, via the seam)', async () => {
    const sweepExpiredLeases = vi.fn();
    await runSelfHeal({ storage, sweepExpiredLeases });
    expect(sweepExpiredLeases).toHaveBeenCalledTimes(1);
  });

  it('records a lease-sweep error without crashing boot', async () => {
    const sweepExpiredLeases = vi.fn(() => { throw new Error('lease boom'); });
    const report = await runSelfHeal({ storage, sweepExpiredLeases });
    expect(report.errors.some((e) => e.includes('lease-sweep') && e.includes('lease boom'))).toBe(true);
  });
});

// ─── repairModelCache ──────────────────────────────────────────────────────

describe('repairModelCache', () => {
  it('removes files that fail verify and leaves valid ones alone', async () => {
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    const modelId = 'local/qwen3-0.6b';

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
      'local/qwen3-0.6b',
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
  const MODEL_ID = 'local/qwen3-0.6b';
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

  it('leaves a ready slot alone when its weights are stored parts-native — manifest + parts survive reconcile', async () => {
    // The large weight is stored parts-native: a manifest at the identity key
    // plus its chunk-parts as separate entries. Reconcile inspects only the
    // known plan-file keys (never enumerates part keys), and the identity's
    // part-aware verify passes, so the slot stays ready and NOTHING is purged —
    // the permanent parts must not be mistaken for orphans.
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // config.json: plain whole-file entry.
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[0]!.url },
      new Response(new Uint8Array(PLAN[0]!.sizeBytes)),
    );
    // weights.bin: two chunk-parts (500 + 500) finalized as a parts-native manifest.
    const weightsUrl = PLAN[1]!.url;
    const partKeys = [`${weightsUrl}.ecopart.s1000.0`, `${weightsUrl}.ecopart.s1000.500`];
    for (const key of partKeys) {
      await cacheStorage.put({ modelId: MODEL_ID, url: key }, new Response(new Uint8Array(500)));
    }
    await cacheStorage.finalizeParts({ modelId: MODEL_ID, url: weightsUrl }, partKeys, 1_000);

    const removeSpy = vi.spyOn(cacheStorage, 'remove');
    const report = await reconcileReadySlots(async () => PLAN, { cacheStorage });

    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('ready');
    expect(removeSpy).not.toHaveBeenCalled();
    // The manifest and both parts are still present.
    expect(await cacheStorage.isPartsNative({ modelId: MODEL_ID, url: weightsUrl })).toBe(true);
    for (const key of partKeys) {
      expect(await cacheStorage.has({ modelId: MODEL_ID, url: key })).toBe(true);
    }
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
    const smartId = 'candidate/qwen3.5-2b-onnx';
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

// ─── reconcileReadySlots — webllm runtime branch ───────────────────────────
//
// WebLLM models live in WebLLM's own cache namespaces; Eco's staging cache is
// empty BY DESIGN once the bridge drains it. The per-file Eco-storage repair
// therefore counted every file "missing" and demoted a healthy iOS ready slot
// on EVERY page load (third instance of the staging-cache runtime-blindness
// pattern). These tests pin the runtime-aware branch: presence is answered by
// the engine cache, absence must be PROVEN before any demotion, and the Eco
// path (plan resolution included) is never touched for a webllm model.

describe('reconcileReadySlots — webllm models verify against the engine cache', () => {
  const MLC_ID = 'candidate/qwen2.5-0.5b-mlc';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('catalog fixture guard: the MLC entry exists and is runtime webllm', () => {
    // The suite below leans on the REAL catalog via the default resolveModel.
    // If this entry is ever renamed/retired, fail loudly here instead of
    // letting the branch tests silently test nothing.
    expect(getModel(MLC_ID)?.runtime).toBe('webllm');
  });

  it('leaves a ready webllm slot alone when the engine cache holds the model — Eco storage and manifest never consulted', async () => {
    setSlot('eco-fast', MLC_ID);
    setSlotStatus('eco-fast', 'ready');
    const planResolver = vi.fn(async () => {
      throw new Error('plan resolver must not run for a webllm model');
    });
    const webllmInCache = vi.fn(async () => true);

    const report = await reconcileReadySlots(planResolver, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      webllmInCache,
    });

    expect(webllmInCache).toHaveBeenCalledTimes(1);
    expect(planResolver).not.toHaveBeenCalled();
    expect(getSlot('eco-fast').status).toBe('ready');
    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.modelsRepaired).toEqual([]);
    expect(report.errors).toEqual([]);
  });

  it('flips a ready webllm slot to preparing when the engine cache definitively lacks the model — without the cleanup hint', async () => {
    setSlot('eco-fast', MLC_ID);
    setSlotStatus('eco-fast', 'ready');
    const repaired: unknown[] = [];

    const report = await reconcileReadySlots(async () => null, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      webllmInCache: async () => false,
      onCacheRepaired: (info) => { repaired.push(info); },
    });

    expect(getSlot('eco-fast').status).toBe('preparing');
    expect(report.slotsFlippedToPreparing).toEqual(['eco-fast']);
    expect(report.modelsRepaired).toEqual([
      { modelId: MLC_ID, removed: 0, missing: 1 },
    ]);
    // Nothing was removed, so the "we cleaned up your cache" copy would be
    // untruthful — same silent re-download semantics as wholly-missing files.
    expect(repaired).toEqual([]);
  });

  it('never demotes on a probe failure — absence unproven', async () => {
    setSlot('eco-fast', MLC_ID);
    setSlotStatus('eco-fast', 'ready');

    const report = await reconcileReadySlots(async () => null, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      webllmInCache: async () => { throw new Error('bridge chunk failed to load'); },
    });

    expect(getSlot('eco-fast').status).toBe('ready');
    expect(report.slotsFlippedToPreparing).toEqual([]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain(`webllm-probe(${MLC_ID})`);
  });

  it('skips an artifact-less webllm model — the probe would answer a fails-closed false and demote it every boot', async () => {
    const base = getModel(MLC_ID);
    if (!base) throw new Error(`catalog fixture ${MLC_ID} is missing`);
    const artifactless: ModelConfig = { ...base, artifact: undefined };
    setSlot('eco-fast', MLC_ID);
    setSlotStatus('eco-fast', 'ready');
    const webllmInCache = vi.fn(async () => false);

    const report = await reconcileReadySlots(async () => null, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      resolveModel: () => artifactless,
      webllmInCache,
    });

    expect(webllmInCache).not.toHaveBeenCalled();
    expect(getSlot('eco-fast').status).toBe('ready');
    expect(report.slotsFlippedToPreparing).toEqual([]);
  });

  it('skips the probe entirely while definitely offline — a preparing flip would drive a download that cannot succeed', async () => {
    setSlot('eco-fast', MLC_ID);
    setSlotStatus('eco-fast', 'ready');
    vi.stubGlobal('navigator', { onLine: false });
    const webllmInCache = vi.fn(async () => false);

    const report = await reconcileReadySlots(async () => null, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      webllmInCache,
    });

    expect(webllmInCache).not.toHaveBeenCalled();
    expect(getSlot('eco-fast').status).toBe('ready');
    expect(report.slotsFlippedToPreparing).toEqual([]);
  });

  it('non-webllm slots still take the Eco-storage path in the same pass', async () => {
    setSlot('eco-fast', MLC_ID);
    setSlotStatus('eco-fast', 'ready');
    const tjsId = 'candidate/qwen3.5-2b-onnx';
    setSlot('eco-smart', tjsId);
    setSlotStatus('eco-smart', 'ready');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // The TJS model's single planned file is wholly missing from Eco storage.
    const report = await reconcileReadySlots(async (modelId) => {
      if (modelId === tjsId) return [{ url: 'https://hf/smart.bin', sizeBytes: 999 }];
      throw new Error(`unexpected plan resolution for ${modelId}`);
    }, {
      cacheStorage,
      webllmInCache: async () => true,
    });

    expect(getSlot('eco-fast').status).toBe('ready');
    expect(getSlot('eco-smart').status).toBe('preparing');
    expect(report.slotsFlippedToPreparing).toEqual(['eco-smart']);
  });
});

// ─── reconcilePreparingSlots (the promote direction) ───────────────────────
//
// The ready-state wedge (verified live 2026-08-05): a slot stuck 'preparing'
// while its model's bytes sit fully cached makes every send fail with a setup
// card whose button is disabled — a permanent dead end no user can escape.
// This pass is the boot-time repair: 'preparing' + bytes verified complete +
// recent proof the model ran on this device ⇒ 'ready'. It never demotes,
// never deletes, and skips anything it cannot verify.

describe('reconcilePreparingSlots', () => {
  const MODEL_ID = 'local/qwen3-0.6b';
  const PLAN = [
    { url: 'https://hf/config.json', sizeBytes: 100 },
    { url: 'https://hf/weights.bin', sizeBytes: 1_000 },
  ];

  async function populateCache(cacheStorage: CacheApiStorage, modelId = MODEL_ID) {
    for (const file of PLAN) {
      await cacheStorage.put(
        { modelId, url: file.url },
        new Response(new Uint8Array(file.sizeBytes)),
      );
    }
  }

  it('promotes a preparing slot to ready when bytes verify complete and device proof exists', async () => {
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'preparing');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    await populateCache(cacheStorage);

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage,
      hasDeviceProof: () => true,
    });

    expect(report.slotsPromotedToReady).toEqual(['eco-smart']);
    expect(getSlot('eco-smart').status).toBe('ready');
  });

  it('leaves the slot preparing when a plan file is wholly missing, and deletes nothing', async () => {
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'preparing');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    // Only the first file present.
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[0]!.url },
      new Response(new Uint8Array(PLAN[0]!.sizeBytes)),
    );
    const removeSpy = vi.spyOn(cacheStorage, 'remove');

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage,
      hasDeviceProof: () => true,
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-smart').status).toBe('preparing');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('leaves the slot preparing on a size mismatch (interrupted partial file), and deletes nothing', async () => {
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'preparing');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[0]!.url },
      new Response(new Uint8Array(PLAN[0]!.sizeBytes)),
    );
    await cacheStorage.put(
      { modelId: MODEL_ID, url: PLAN[1]!.url },
      new Response(new Uint8Array(7)), // truncated
    );
    const removeSpy = vi.spyOn(cacheStorage, 'remove');

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage,
      hasDeviceProof: () => true,
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-smart').status).toBe('preparing');
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('does not promote without device proof, even with a complete cache', async () => {
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'preparing');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    await populateCache(cacheStorage);

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage,
      hasDeviceProof: () => false,
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-smart').status).toBe('preparing');
  });

  it('does not promote when the manifest plan is unavailable (null resolver)', async () => {
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'preparing');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    await populateCache(cacheStorage);

    const report = await reconcilePreparingSlots(async () => null, {
      cacheStorage,
      hasDeviceProof: () => true,
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-smart').status).toBe('preparing');
  });

  it('never touches ready, error, or empty slots', async () => {
    setSlot('eco-fast', MODEL_ID);
    setSlotStatus('eco-fast', 'ready');
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'error');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    await populateCache(cacheStorage);

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage,
      hasDeviceProof: () => true,
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('ready');
    expect(getSlot('eco-smart').status).toBe('error');
  });

  it('is a no-op when the validation harness forces cache verification (e2e fixtures)', async () => {
    setSlot('eco-smart', MODEL_ID);
    setSlotStatus('eco-smart', 'preparing');
    const cacheStorage = new CacheApiStorage(new MemoryCacheStorage());
    await populateCache(cacheStorage);

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage,
      hasDeviceProof: () => true,
      isCacheVerificationForced: () => true,
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-smart').status).toBe('preparing');
  });

  it('promotes a webllm model via the engine-cache presence probe', async () => {
    const WEBLLM_ID = 'candidate/qwen2.5-0.5b-mlc';
    setSlot('eco-fast', WEBLLM_ID);
    setSlotStatus('eco-fast', 'preparing');

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      hasDeviceProof: () => true,
      webllmInCache: async () => true,
    });

    expect(report.slotsPromotedToReady).toEqual(['eco-fast']);
    expect(getSlot('eco-fast').status).toBe('ready');
  });

  it('leaves a webllm slot alone when the presence probe throws (absence unproven)', async () => {
    const WEBLLM_ID = 'candidate/qwen2.5-0.5b-mlc';
    setSlot('eco-fast', WEBLLM_ID);
    setSlotStatus('eco-fast', 'preparing');

    const report = await reconcilePreparingSlots(async () => PLAN, {
      cacheStorage: new CacheApiStorage(new MemoryCacheStorage()),
      hasDeviceProof: () => true,
      webllmInCache: async () => { throw new Error('cache API unavailable'); },
    });

    expect(report.slotsPromotedToReady).toEqual([]);
    expect(getSlot('eco-fast').status).toBe('preparing');
    expect(report.errors.length).toBeGreaterThan(0);
  });
});

// The desktop mirror of the WebKit-mobile re-gate. A slot can hold a binding to
// the iOS-only WebLLM model on a desktop profile (seen live 2026-08-05: Settings
// confidently announced "Eco Mobile (Qwen)" — "Made for iPhone" — on a Chromium
// desktop). Selection would never pick it here (isCompatible → 'unsupported'),
// but nothing re-checked a binding that already existed. Boot must clear it so
// every surface reading the slots tells the truth.

describe('runSelfHeal — iOS-only binding on a non-WebKit-mobile device', () => {
  const MLC = 'candidate/qwen2.5-0.5b-mlc';
  const SMART = 'candidate/qwen3.5-2b-onnx';

  const chromiumDesktop: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  };
  const iosWebKit: DeviceProfile = {
    browserClass: 'safari',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 4,
    isMobile: true,
    override: 'auto',
  };

  it('clears a desktop slot bound to the iOS-only model, leaving the other slot alone', async () => {
    setSlot('eco-fast', MLC);
    setSlotStatus('eco-fast', 'ready');
    setSlot('eco-smart', SMART);
    setSlotStatus('eco-smart', 'ready');

    const report = await runSelfHeal({
      storage,
      resolveDeviceProfile: () => chromiumDesktop,
    });

    expect(report.errors).toEqual([]);
    expect(report.incompatibleSlotsRegated).toEqual(['eco-fast']);
    expect(getSlot('eco-fast').modelId).toBeNull();
    expect(getSlot('eco-fast').status).toBe('empty');
    expect(getSlot('eco-smart').modelId).toBe(SMART);
    expect(getSlot('eco-smart').status).toBe('ready');
  });

  it('leaves the iOS-only model bound on iOS WebKit itself (validated there)', async () => {
    setSlot('eco-fast', MLC);
    setSlotStatus('eco-fast', 'ready');

    const report = await runSelfHeal({
      storage,
      resolveDeviceProfile: () => iosWebKit,
    });

    expect(report.incompatibleSlotsRegated).toEqual([]);
    expect(report.webkitMobileSlotsRegated).toEqual([]);
    expect(getSlot('eco-fast').modelId).toBe(MLC);
    expect(getSlot('eco-fast').status).toBe('ready');
  });
});

// ─── Dead-bytes sweep (non-catalog namespaces + orphaned chunk-parts) ────────
//
// A conservative boot-time sweep of unambiguously-dead cached bytes:
//   (a) whole `eco-local-ai-*` namespaces the CURRENT catalog can no longer
//       offer, bound to no slot and owned by no in-flight download; and
//   (b) orphaned chunk-parts of an unbound, not-mid-download catalog model —
//       resume bytes no parts-native manifest claims.
// It must NEVER delete a slot-bound model, a current-catalog model's finalized
// weights, terminal parts-native bytes, or a model with a live download.

describe('runSelfHeal — dead-bytes sweep', () => {
  // A synthetic id the injected catalog keeps, and one it has dropped.
  const CATALOG_ID = 'candidate/catalog-keep-onnx';
  const DEAD_ID = 'local/dropped-model-q4';
  // A real catalog id used to prove the slot-binding guard independent of the
  // injected catalog set (getSlot only resolves a binding for a real model).
  const BOUND_ID = 'candidate/lfm2-2.6b-onnx';

  function sweepOptions(
    backend: MemoryCacheStorage,
    over?: Partial<SelfHealOptions>,
  ): SelfHealOptions {
    return {
      storage,
      cacheStorage: new CacheApiStorage(backend),
      deleteCacheByName: (name: string) => backend.delete(name).then(() => undefined),
      resolveCatalogIds: () => [CATALOG_ID],
      hasActiveDownloadLease: () => false,
      ...over,
    };
  }

  it('sweeps a namespace the catalog can no longer offer when no slot is bound', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    await cs.put(
      { modelId: DEAD_ID, url: 'https://m.test/dead/weights.bin' },
      new Response(new Uint8Array(500)),
    );
    const deadCache = modelCacheName(DEAD_ID);
    expect(backend.caches.has(deadCache)).toBe(true);

    const report = await runSelfHeal(sweepOptions(backend, { cacheStorage: cs }));

    expect(report.deadModelCachesSwept).toContain(deadCache);
    expect(backend.caches.has(deadCache)).toBe(false);
  });

  it('keeps a current-catalog namespace that is unbound (still reachable)', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    await cs.put(
      { modelId: CATALOG_ID, url: 'https://m.test/keep/weights.bin' },
      new Response(new Uint8Array(500)),
    );

    const report = await runSelfHeal(sweepOptions(backend, { cacheStorage: cs }));

    expect(report.deadModelCachesSwept).not.toContain(modelCacheName(CATALOG_ID));
    expect(backend.caches.has(modelCacheName(CATALOG_ID))).toBe(true);
  });

  it('keeps a slot-bound namespace even when the injected catalog omits it', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    setSlot('eco-smart', BOUND_ID);
    await cs.put(
      { modelId: BOUND_ID, url: 'https://m.test/bound/weights.bin' },
      new Response(new Uint8Array(500)),
    );

    // resolveCatalogIds excludes BOUND_ID — only the binding keeps it.
    const report = await runSelfHeal(sweepOptions(backend, { cacheStorage: cs }));

    expect(report.deadModelCachesSwept).not.toContain(modelCacheName(BOUND_ID));
    expect(backend.caches.has(modelCacheName(BOUND_ID))).toBe(true);
    expect(getSlot('eco-smart').modelId).toBe(BOUND_ID);
  });

  it('sweeps orphaned chunk-parts of an unbound catalog model, keeping the namespace', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    const orphan = 'https://m.test/keep/weights.bin.ecopart.s1000.0';
    // A part with NO parts-native manifest at its base — an abandoned resume.
    await cs.put({ modelId: CATALOG_ID, url: orphan }, new Response(new Uint8Array(500)));

    const report = await runSelfHeal(sweepOptions(backend, { cacheStorage: cs }));

    expect(report.orphanedPartsSwept).toBe(1);
    expect(await cs.has({ modelId: CATALOG_ID, url: orphan })).toBe(false);
    // The namespace itself is a catalog model — kept.
    expect(backend.caches.has(modelCacheName(CATALOG_ID))).toBe(true);
  });

  it('keeps terminal parts-native parts of an unbound catalog model (they ARE the weights)', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    const weights = 'https://m.test/keep/weights.bin';
    const partKeys = [`${weights}.ecopart.s1000.0`, `${weights}.ecopart.s1000.500`];
    for (const key of partKeys) {
      await cs.put({ modelId: CATALOG_ID, url: key }, new Response(new Uint8Array(500)));
    }
    // Finalize the parts as the file's terminal storage (a manifest at the
    // identity referencing the parts) — the WebKit-mobile / large-file shape.
    await cs.finalizeParts({ modelId: CATALOG_ID, url: weights }, partKeys, 1_000);

    const report = await runSelfHeal(sweepOptions(backend, { cacheStorage: cs }));

    expect(report.orphanedPartsSwept).toBe(0);
    for (const key of partKeys) {
      expect(await cs.has({ modelId: CATALOG_ID, url: key })).toBe(true);
    }
    expect(await cs.isPartsNative({ modelId: CATALOG_ID, url: weights })).toBe(true);
  });

  it('never sweeps parts of a slot-bound model, even orphaned-looking ones', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    setSlot('eco-smart', BOUND_ID);
    const orphan = 'https://m.test/bound/weights.bin.ecopart.s1000.0';
    await cs.put({ modelId: BOUND_ID, url: orphan }, new Response(new Uint8Array(500)));

    const report = await runSelfHeal(
      sweepOptions(backend, {
        cacheStorage: cs,
        resolveCatalogIds: () => [CATALOG_ID, BOUND_ID],
      }),
    );

    // Bound ⇒ the parts sweep skips the model entirely (the part is untouched
    // despite having no manifest).
    expect(report.orphanedPartsSwept).toBe(0);
    expect(await cs.has({ modelId: BOUND_ID, url: orphan })).toBe(true);
  });

  it('skips the orphaned-parts sweep while a heavy download is active', async () => {
    const backend = new MemoryCacheStorage();
    const cs = new CacheApiStorage(backend);
    const orphan = 'https://m.test/keep/weights.bin.ecopart.s1000.0';
    await cs.put({ modelId: CATALOG_ID, url: orphan }, new Response(new Uint8Array(500)));

    const report = await runSelfHeal(
      sweepOptions(backend, { cacheStorage: cs, hasActiveDownloadLease: () => true }),
    );

    expect(report.orphanedPartsSwept).toBe(0);
    expect(await cs.has({ modelId: CATALOG_ID, url: orphan })).toBe(true);
  });

  it('records a non-fatal error and boot continues when namespace enumeration fails', async () => {
    const backend = new MemoryCacheStorage();
    const report = await runSelfHeal(
      sweepOptions(backend, {
        listModelCacheNames: () => Promise.reject(new Error('enum boom')),
      }),
    );

    // The sweep swallowed the failure into report.errors; runSelfHeal resolved.
    expect(report.errors.some((e) => e.includes('dead-cache-enum'))).toBe(true);
    expect(report.deadModelCachesSwept).toEqual([]);
    expect(report.orphanedPartsSwept).toBe(0);
  });
});
