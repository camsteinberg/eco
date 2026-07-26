// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Consent-driven upgrade state machine (instant-start slice 2b).
 *
 * Covers:
 *   - The pure transition table: idle→offered→accepted→downloading→staged→
 *     swapping→done, with declined/deferred side states, the swap-attempt
 *     cap, and invalid transitions being ignored.
 *   - Persistence: records survive write→read; corrupt rows read as idle.
 *   - Offer eligibility: convergence, already-upgraded, no-nagging after
 *     decline/done/deferral, new cycle when the recommendation moves.
 *   - The download driver: lease-guarded, fast-path when cached, transient
 *     retry, honest storage deferral, abort leaves the phase resumable.
 *   - The swap driver: calls prepareModelForSlot on eco-smart, busy does not
 *     burn an attempt, cap 2 defers, evicted cache reverts to re-download.
 *   - Boot reconcile: interrupted swapping resets to staged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceProfile, ModelConfig } from '../../types';
import {
  MAX_SWAP_ATTEMPTS,
  UPGRADE_STORAGE_KEY,
  _resetUpgradeForTesting,
  isUpgradeInFlight,
  planUpgradeOffer,
  readUpgradeRecord,
  reconcileUpgradeOnBoot,
  runUpgradeDownload,
  performUpgradeSwap,
  setUpgradeStorage,
  subscribeUpgrade,
  transitionUpgrade,
  writeUpgradeRecord,
  type UpgradeRecord,
} from '../upgrade';
import {
  InsufficientStorageError,
  downloadModel,
  isModelDownloaded,
} from '../../download/download';
import {
  bridgeDownloadWebLLMModel,
  webllmModelInCache,
} from '../../runtime/webllm-cache-bridge';
import { readAllEntries } from '../../evidence/ledger';

// The webllm runtime lane: `bridgeDownloadWebLLMModel` (upgrade's download seam
// for a webllm target) and `webllmModelInCache` (the terminal-store probe the
// runtime-aware `isModelDownloaded` defers to) are stubbed; every other export
// stays real. `downloadModel` is stubbed so the webllm-vs-plain routing is
// assertable. None of the pre-existing suites exercise these — they inject
// their own download/cache seams — so the stubs only bite the new cases below.
vi.mock('../../runtime/webllm-cache-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/webllm-cache-bridge')>();
  return {
    ...actual,
    bridgeDownloadWebLLMModel: vi.fn(async () => {}),
    webllmModelInCache: vi.fn(async () => false),
  };
});

vi.mock('../../download/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../download/download')>();
  return {
    ...actual,
    downloadModel: vi.fn(async () => {}),
  };
});

const PROFILE = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
} as DeviceProfile;

const model = (id: string) => ({ id, sizeGB: 1.4, friendlyName: id } as ModelConfig);
const webllmModel = (id: string) =>
  ({ id, runtime: 'webllm', sizeGB: 1.4, friendlyName: id } as ModelConfig);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    _map: map,
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  setUpgradeStorage(storage);
  // Clear the webllm-lane stubs (call history only — the factory defaults
  // stand: bridge/download resolve, cache-probe misses) so per-test overrides
  // and call-count assertions start clean.
  vi.mocked(bridgeDownloadWebLLMModel).mockClear();
  vi.mocked(webllmModelInCache).mockClear();
  vi.mocked(downloadModel).mockClear();
});

afterEach(() => {
  _resetUpgradeForTesting();
  vi.restoreAllMocks();
});

function record(over: Partial<UpgradeRecord> = {}): UpgradeRecord {
  return {
    version: 1,
    phase: 'offered',
    targetModelId: 'target',
    baseModelId: 'starter',
    deferral: null,
    swapAttempts: 0,
    updatedAt: 1000,
    ...over,
  };
}

// ─── Pure transitions ───────────────────────────────────────────────────────

describe('transitionUpgrade — the happy path', () => {
  it('walks idle → offered → accepted → downloading → staged → swapping → done', () => {
    let r = transitionUpgrade(null, { type: 'offer', targetModelId: 'target', baseModelId: 'starter' }, 1);
    expect(r?.phase).toBe('offered');
    r = transitionUpgrade(r, { type: 'accept' }, 2);
    expect(r?.phase).toBe('accepted');
    r = transitionUpgrade(r, { type: 'download-started' }, 3);
    expect(r?.phase).toBe('downloading');
    r = transitionUpgrade(r, { type: 'download-completed' }, 4);
    expect(r?.phase).toBe('staged');
    r = transitionUpgrade(r, { type: 'swap-started' }, 5);
    expect(r?.phase).toBe('swapping');
    expect(r?.swapAttempts).toBe(1);
    r = transitionUpgrade(r, { type: 'swap-succeeded' }, 6);
    expect(r?.phase).toBe('done');
    expect(r?.updatedAt).toBe(6);
  });
});

describe('transitionUpgrade — side states and guards', () => {
  it('offered + decline → declined', () => {
    const r = transitionUpgrade(record(), { type: 'decline' }, 2);
    expect(r?.phase).toBe('declined');
  });

  it('declined + accept → accepted (the quiet affordance re-entry)', () => {
    const r = transitionUpgrade(record({ phase: 'declined' }), { type: 'accept' }, 2);
    expect(r?.phase).toBe('accepted');
  });

  it('deferred + accept → accepted and clears the deferral', () => {
    const r = transitionUpgrade(
      record({ phase: 'deferred', deferral: { code: 'download-failed', message: 'x' } }),
      { type: 'accept' },
      2,
    );
    expect(r?.phase).toBe('accepted');
    expect(r?.deferral).toBeNull();
  });

  it('downloading + download-failed → deferred with the reason', () => {
    const r = transitionUpgrade(
      record({ phase: 'downloading' }),
      { type: 'download-failed', deferral: { code: 'insufficient-storage', message: 'no room' } },
      2,
    );
    expect(r?.phase).toBe('deferred');
    expect(r?.deferral).toEqual({ code: 'insufficient-storage', message: 'no room' });
  });

  it('swapping + swap-failed under the cap → staged (retry available)', () => {
    const r = transitionUpgrade(record({ phase: 'swapping', swapAttempts: 1 }), { type: 'swap-failed' }, 2);
    expect(r?.phase).toBe('staged');
  });

  it('swapping + swap-failed at the cap → deferred', () => {
    const r = transitionUpgrade(
      record({ phase: 'swapping', swapAttempts: MAX_SWAP_ATTEMPTS }),
      { type: 'swap-failed' },
      2,
    );
    expect(r?.phase).toBe('deferred');
    expect(r?.deferral?.code).toBe('swap-failed');
  });

  it('staged + swap-started at the cap → deferred instead of a third attempt', () => {
    const r = transitionUpgrade(
      record({ phase: 'staged', swapAttempts: MAX_SWAP_ATTEMPTS }),
      { type: 'swap-started' },
      2,
    );
    expect(r?.phase).toBe('deferred');
  });

  it('swapping + swap-busy → staged WITHOUT burning the attempt', () => {
    const r = transitionUpgrade(record({ phase: 'swapping', swapAttempts: 1 }), { type: 'swap-busy' }, 2);
    expect(r?.phase).toBe('staged');
    expect(r?.swapAttempts).toBe(0);
  });

  it('staged + cache-evicted → accepted (re-download path)', () => {
    const r = transitionUpgrade(record({ phase: 'staged' }), { type: 'cache-evicted' }, 2);
    expect(r?.phase).toBe('accepted');
  });

  it('ignores invalid transitions (done + accept stays done)', () => {
    const done = record({ phase: 'done' });
    expect(transitionUpgrade(done, { type: 'accept' }, 2)).toEqual(done);
    expect(transitionUpgrade(null, { type: 'accept' }, 2)).toBeNull();
    expect(transitionUpgrade(record({ phase: 'downloading' }), { type: 'swap-started' }, 2)?.phase).toBe('downloading');
  });

  it('a fresh offer for a DIFFERENT target replaces a settled record', () => {
    const r = transitionUpgrade(
      record({ phase: 'declined', targetModelId: 'old-target' }),
      { type: 'offer', targetModelId: 'new-target', baseModelId: 'starter' },
      2,
    );
    expect(r?.phase).toBe('offered');
    expect(r?.targetModelId).toBe('new-target');
    expect(r?.swapAttempts).toBe(0);
  });

  it('an offer never interrupts a mid-flight cycle (downloading keeps downloading)', () => {
    const r = transitionUpgrade(
      record({ phase: 'downloading' }),
      { type: 'offer', targetModelId: 'new-target', baseModelId: 'starter' },
      2,
    );
    expect(r?.phase).toBe('downloading');
    expect(r?.targetModelId).toBe('target');
  });

  it('reset returns to idle from any phase', () => {
    expect(transitionUpgrade(record({ phase: 'downloading' }), { type: 'reset' }, 2)).toBeNull();
  });
});

// ─── Persistence ────────────────────────────────────────────────────────────

describe('upgrade record persistence', () => {
  it('round-trips a record through storage under the v1 key', () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    expect(storage._map.has(UPGRADE_STORAGE_KEY)).toBe(true);
    expect(readUpgradeRecord()?.phase).toBe('staged');
  });

  it('writing null clears the row (idle)', () => {
    writeUpgradeRecord(record());
    writeUpgradeRecord(null);
    expect(readUpgradeRecord()).toBeNull();
    expect(storage._map.has(UPGRADE_STORAGE_KEY)).toBe(false);
  });

  it('reads corrupt or wrong-shaped rows as idle', () => {
    storage.setItem(UPGRADE_STORAGE_KEY, 'not json');
    expect(readUpgradeRecord()).toBeNull();
    storage.setItem(UPGRADE_STORAGE_KEY, JSON.stringify({ version: 99, phase: 'staged' }));
    expect(readUpgradeRecord()).toBeNull();
    storage.setItem(UPGRADE_STORAGE_KEY, JSON.stringify({ version: 1, phase: 'bogus', targetModelId: 'x' }));
    expect(readUpgradeRecord()).toBeNull();
  });

  it('notifies subscribers on every write', () => {
    const seen: Array<UpgradeRecord | null> = [];
    const unsubscribe = subscribeUpgrade((r) => seen.push(r));
    writeUpgradeRecord(record());
    writeUpgradeRecord(null);
    unsubscribe();
    writeUpgradeRecord(record());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.phase).toBe('offered');
    expect(seen[1]).toBeNull();
  });
});

// ─── Offer eligibility ──────────────────────────────────────────────────────

describe('planUpgradeOffer', () => {
  const base = {
    profile: PROFILE,
    currentModelId: 'starter',
    ecoSmartReadyModelId: null as string | null,
    record: null as UpgradeRecord | null,
    recommendSmart: () => model('target'),
    // Default the cache probe to "not cached" so the eligibility cases below are
    // deterministic and never touch the real Cache API. The cached-target guard
    // has its own dedicated case.
    isTargetCached: async () => false,
  };

  it('offers the eco-smart recommendation on a fresh record', async () => {
    expect((await planUpgradeOffer(base))?.id).toBe('target');
  });

  it('convergence: no offer when the device is already on the class-best', async () => {
    expect(await planUpgradeOffer({ ...base, currentModelId: 'target' })).toBeNull();
  });

  it('no offer when eco-smart already holds the target ready', async () => {
    expect(await planUpgradeOffer({ ...base, ecoSmartReadyModelId: 'target' })).toBeNull();
  });

  it('no offer when the target is already fully cached (no phantom download offer)', async () => {
    expect(await planUpgradeOffer({ ...base, isTargetCached: async () => true })).toBeNull();
  });

  it('a cache-probe error reads as not-cached and still offers', async () => {
    expect(
      (await planUpgradeOffer({ ...base, isTargetCached: async () => { throw new Error('storage'); } }))?.id,
    ).toBe('target');
  });

  it('no nagging: declined/done/deferred records for the same target suppress the offer', async () => {
    for (const phase of ['declined', 'done', 'deferred'] as const) {
      expect(await planUpgradeOffer({ ...base, record: record({ phase }) })).toBeNull();
    }
  });

  it('re-surfaces an undecided offered record (tab closed mid-popup)', async () => {
    expect((await planUpgradeOffer({ ...base, record: record({ phase: 'offered' }) }))?.id).toBe('target');
  });

  it('no offer while a cycle is mid-flight, even if the recommendation moved', async () => {
    for (const phase of ['accepted', 'downloading', 'staged', 'swapping'] as const) {
      expect(
        await planUpgradeOffer({ ...base, record: record({ phase, targetModelId: 'old-target' }) }),
      ).toBeNull();
    }
  });

  it('a settled record for a DIFFERENT target allows a new cycle', async () => {
    expect(
      (await planUpgradeOffer({ ...base, record: record({ phase: 'declined', targetModelId: 'old-target' }) }))?.id,
    ).toBe('target');
  });

  it('no offer when the recommendation cannot resolve', async () => {
    expect(await planUpgradeOffer({ ...base, recommendSmart: () => null })).toBeNull();
  });

  it('BEHAVIOR PIN — WebKit-mobile: the ladder activates the moment the recommendation moves; no mobile-aware policy gates it', async () => {
    // Today the upgrade ladder is dead on WebKit-mobile only because the
    // catalog carries a single WebKit model, so the eco-smart recommendation
    // always converges on the current model. Nothing in the offer path is
    // platform- or runtime-aware: the moment a second WebKit model exists,
    // this machinery goes live on phones — including consent popup, a
    // GB-scale download offer, and the swap driver — with no mobile-specific
    // policy (cellular data, thermal, storage pressure) in between.
    //
    // This test pins that truth. If it starts failing because an offer gate
    // was added, that gate is the deliberate outcome of the mobile-ladder
    // policy decision and this pin should be updated alongside it — not
    // silently deleted.
    const webkitMobile = {
      browserClass: 'safari',
      webgpuSupport: 'webgpu',
      deviceMemoryGB: 0,
      isMobile: true,
      override: 'auto',
    } as DeviceProfile;

    const offered = await planUpgradeOffer({
      ...base,
      profile: webkitMobile,
      currentModelId: 'webkit-starter',
      recommendSmart: () => webllmModel('webkit-rung-2'),
    });

    expect(offered?.id).toBe('webkit-rung-2');
    expect(offered?.runtime).toBe('webllm');
  });
});

// ─── Download driver ────────────────────────────────────────────────────────

function downloadSeams(over: Record<string, unknown> = {}) {
  return {
    getModel: vi.fn((id: string) => model(id)),
    acquireLease: vi.fn(() => ({ ok: true as const, lease: {} as never, release: vi.fn() })),
    describeBusy: vi.fn(() => 'busy copy'),
    download: vi.fn(async () => {}),
    isModelFullyCached: vi.fn(async () => false),
    ...over,
  };
}

describe('runUpgradeDownload', () => {
  it('downloads under the download lease and lands staged', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams();
    const outcome = await runUpgradeDownload({ seams });
    expect(outcome.kind).toBe('staged');
    expect(seams.acquireLease).toHaveBeenCalledWith('download');
    expect(seams.download).toHaveBeenCalledTimes(1);
    expect(readUpgradeRecord()?.phase).toBe('staged');
  });

  it('resumes a reload-interrupted downloading record', async () => {
    writeUpgradeRecord(record({ phase: 'downloading' }));
    const outcome = await runUpgradeDownload({ seams: downloadSeams() });
    expect(outcome.kind).toBe('staged');
  });

  it('fast-paths straight to staged when the target is already fully cached', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams({ isModelFullyCached: vi.fn(async () => true) });
    const outcome = await runUpgradeDownload({ seams });
    expect(outcome.kind).toBe('staged');
    expect(seams.download).not.toHaveBeenCalled();
  });

  it('returns busy without changing phase when another download holds the lease', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams({
      acquireLease: vi.fn(() => ({ ok: false as const, active: null, reason: 'busy' })),
    });
    const outcome = await runUpgradeDownload({ seams });
    expect(outcome.kind).toBe('busy');
    expect(readUpgradeRecord()?.phase).toBe('accepted');
  });

  it('retries a transient failure once, then defers honestly', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams({
      download: vi.fn(async () => {
        throw new Error('network blip');
      }),
    });
    const outcome = await runUpgradeDownload({ seams });
    expect(seams.download).toHaveBeenCalledTimes(2);
    expect(outcome.kind).toBe('deferred');
    expect(readUpgradeRecord()?.phase).toBe('deferred');
    expect(readUpgradeRecord()?.deferral?.code).toBe('download-failed');
  });

  it('does NOT itself write a download-fail ledger row — the download origin owns that single write (dedupe)', async () => {
    localStorage.clear();
    writeUpgradeRecord(record({ phase: 'accepted' }));
    // The injected download seam throws directly (bypassing the real
    // downloadModel origin), so the upgrade driver must add no ledger row of
    // its own — otherwise a real failure would be double-counted (origin + here).
    const seams = downloadSeams({
      download: vi.fn(async () => {
        throw new Error('network blip');
      }),
    });
    await runUpgradeDownload({ seams });
    expect(readAllEntries().filter((e) => e.outcome === 'download-fail')).toHaveLength(0);
    localStorage.clear();
  });

  it('defers with the storage code on InsufficientStorageError (no retry — space cannot appear)', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams({
      download: vi.fn(async () => {
        throw new InsufficientStorageError(1_000_000, 10);
      }),
    });
    const outcome = await runUpgradeDownload({ seams });
    expect(seams.download).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('deferred');
    expect(readUpgradeRecord()?.deferral?.code).toBe('insufficient-storage');
  });

  it('an abort leaves the record downloading so the next session resumes', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const controller = new AbortController();
    const seams = downloadSeams({
      download: vi.fn(async () => {
        controller.abort();
        throw new Error('aborted');
      }),
    });
    const outcome = await runUpgradeDownload({ seams, signal: controller.signal });
    expect(outcome.kind).toBe('aborted');
    expect(readUpgradeRecord()?.phase).toBe('downloading');
  });

  it('no-ops on records in non-download phases', async () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    const seams = downloadSeams();
    const outcome = await runUpgradeDownload({ seams });
    expect(outcome.kind).toBe('invalid-phase');
    expect(seams.download).not.toHaveBeenCalled();
  });

  it('releases the lease on every path', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const release = vi.fn();
    const seams = downloadSeams({
      acquireLease: vi.fn(() => ({ ok: true as const, lease: {} as never, release })),
      download: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    await runUpgradeDownload({ seams });
    expect(release).toHaveBeenCalledTimes(1);
  });
});

// ─── Swap driver ────────────────────────────────────────────────────────────

function swapSeams(over: Record<string, unknown> = {}) {
  return {
    getModel: vi.fn((id: string) => model(id)),
    isModelFullyCached: vi.fn(async () => true),
    getSlot: vi.fn(() => ({ slot: 'eco-smart' as const, modelId: null, model: null, status: 'empty' as const })),
    prepareModelForSlot: vi.fn(async () => ({ success: true as const })),
    recordEvidence: vi.fn(),
    getDeviceProfile: vi.fn(() => PROFILE),
    ...over,
  };
}

describe('performUpgradeSwap', () => {
  it('swaps a staged target into eco-smart and lands done', async () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    const seams = swapSeams();
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('swapped');
    expect(seams.prepareModelForSlot).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'eco-smart', modelId: 'target', previous: null }),
    );
    expect(readUpgradeRecord()?.phase).toBe('done');
    // slice 3: a successful swap lands a swap-pass ledger row.
    expect(seams.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'swap-pass', modelId: 'target' }),
    );
  });

  it('passes the current eco-smart model as the rollback target', async () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    const previous = model('old-smart');
    const seams = swapSeams({
      getSlot: vi.fn(() => ({ slot: 'eco-smart' as const, modelId: 'old-smart', model: previous, status: 'ready' as const })),
    });
    await performUpgradeSwap({ seams });
    expect(seams.prepareModelForSlot).toHaveBeenCalledWith(
      expect.objectContaining({ previous }),
    );
  });

  it('busy result reverts to staged without burning an attempt', async () => {
    writeUpgradeRecord(record({ phase: 'staged', swapAttempts: 0 }));
    const seams = swapSeams({
      prepareModelForSlot: vi.fn(async () => ({
        success: false as const,
        reason: 'busy' as const,
        failedModel: model('target'),
        suggestedNext: null,
        busyMessage: 'generating',
      })),
    });
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('busy');
    const after = readUpgradeRecord();
    expect(after?.phase).toBe('staged');
    expect(after?.swapAttempts).toBe(0);
    // slice 3: a busy swap attempts nothing, so it records no ledger row.
    expect(seams.recordEvidence).not.toHaveBeenCalled();
  });

  it('a smoke failure burns an attempt and stays staged for one retry', async () => {
    writeUpgradeRecord(record({ phase: 'staged', swapAttempts: 0 }));
    const seams = swapSeams({
      prepareModelForSlot: vi.fn(async () => ({
        success: false as const,
        reason: 'smoke-failed' as const,
        failedModel: model('target'),
        suggestedNext: null,
      })),
    });
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('failed');
    const after = readUpgradeRecord();
    expect(after?.phase).toBe('staged');
    expect(after?.swapAttempts).toBe(1);
    // slice 3: a real swap failure lands a swap-fail ledger row.
    expect(seams.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'swap-fail', modelId: 'target' }),
    );
  });

  it('defers at the attempt cap', async () => {
    writeUpgradeRecord(record({ phase: 'staged', swapAttempts: MAX_SWAP_ATTEMPTS - 1 }));
    const seams = swapSeams({
      prepareModelForSlot: vi.fn(async () => ({
        success: false as const,
        reason: 'smoke-failed' as const,
        failedModel: model('target'),
        suggestedNext: null,
      })),
    });
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('deferred');
    expect(readUpgradeRecord()?.phase).toBe('deferred');
    expect(readUpgradeRecord()?.deferral?.code).toBe('swap-failed');
  });

  it('an evicted cache reverts to accepted for re-download instead of a doomed load', async () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    const seams = swapSeams({ isModelFullyCached: vi.fn(async () => false) });
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('reverted-to-download');
    expect(seams.prepareModelForSlot).not.toHaveBeenCalled();
    expect(readUpgradeRecord()?.phase).toBe('accepted');
  });

  it('no-ops outside staged', async () => {
    writeUpgradeRecord(record({ phase: 'downloading' }));
    const seams = swapSeams();
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('invalid-phase');
    expect(seams.prepareModelForSlot).not.toHaveBeenCalled();
  });
});

// ─── Boot reconcile ─────────────────────────────────────────────────────────

describe('reconcileUpgradeOnBoot', () => {
  it('resets an interrupted swapping record to staged', () => {
    writeUpgradeRecord(record({ phase: 'swapping', swapAttempts: 1 }));
    const r = reconcileUpgradeOnBoot();
    expect(r?.phase).toBe('staged');
    expect(readUpgradeRecord()?.phase).toBe('staged');
    // The interrupted attempt stays counted — a swap that crashes the tab
    // must not retry forever.
    expect(r?.swapAttempts).toBe(1);
  });

  it('leaves every other phase untouched', () => {
    for (const phase of ['offered', 'accepted', 'downloading', 'staged', 'declined', 'deferred', 'done'] as const) {
      writeUpgradeRecord(record({ phase }));
      expect(reconcileUpgradeOnBoot()?.phase).toBe(phase);
    }
    writeUpgradeRecord(null);
    expect(reconcileUpgradeOnBoot()).toBeNull();
  });
});

describe('isUpgradeInFlight', () => {
  it('is true while the cycle is actively preparing the stronger model', () => {
    for (const phase of ['accepted', 'downloading', 'staged', 'swapping'] as const) {
      writeUpgradeRecord(record({ phase }));
      expect(isUpgradeInFlight()).toBe(true);
    }
  });

  it('is false when settled or absent, so genuine errors are never masked', () => {
    for (const phase of ['offered', 'declined', 'deferred', 'done'] as const) {
      writeUpgradeRecord(record({ phase }));
      expect(isUpgradeInFlight()).toBe(false);
    }
    writeUpgradeRecord(null);
    expect(isUpgradeInFlight()).toBe(false);
  });
});

// ─── Runtime-aware downloaded-ness (webllm staging vs terminal store) ─────────

describe('isModelDownloaded', () => {
  it('webllm target: true when WebLLM cache holds it', async () => {
    vi.mocked(webllmModelInCache).mockResolvedValue(true);
    expect(await isModelDownloaded(webllmModel('wm'))).toBe(true);
    expect(webllmModelInCache).toHaveBeenCalledTimes(1);
  });

  it('webllm target: false when WebLLM cache misses', async () => {
    vi.mocked(webllmModelInCache).mockResolvedValue(false);
    expect(await isModelDownloaded(webllmModel('wm'))).toBe(false);
  });

  it('webllm target: fails closed to false when the bridge probe throws', async () => {
    vi.mocked(webllmModelInCache).mockRejectedValue(new Error('bridge chunk failed to load'));
    expect(await isModelDownloaded(webllmModel('wm'))).toBe(false);
  });

  it('non-webllm target: delegates to the Eco terminal-store check, never the bridge', async () => {
    // The bridge would answer TRUE, but a transformers model must ignore WebLLM's
    // cache and read Eco's own store — false here (no plan resolver registered).
    vi.mocked(webllmModelInCache).mockResolvedValue(true);
    expect(await isModelDownloaded(model('t'))).toBe(false);
    expect(webllmModelInCache).not.toHaveBeenCalled();
  });
});

describe('upgrade drivers — webllm runtime lane', () => {
  it('performUpgradeSwap: a staged webllm target with an empty Eco cache but a WebLLM cache hit does NOT read as evicted', async () => {
    // The infinite-loop guard. A webllm target stages into WebLLM's own cache and
    // empties Eco storage, so a bare isModelFullyCached would see "evicted" and
    // send the machine back to re-download forever. The runtime-aware default
    // must consult WebLLM's cache instead.
    writeUpgradeRecord(record({ phase: 'staged', targetModelId: 'wm' }));
    vi.mocked(webllmModelInCache).mockResolvedValue(true);
    const seams = {
      // isModelFullyCached deliberately NOT injected — exercise the default.
      getModel: vi.fn(() => webllmModel('wm')),
      prepareModelForSlot: vi.fn(async () => ({ success: true as const })),
      getSlot: vi.fn(() => ({ slot: 'eco-smart' as const, modelId: null, model: null, status: 'empty' as const })),
      recordEvidence: vi.fn(),
      getDeviceProfile: vi.fn(() => PROFILE),
    };
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('swapped');
    expect(seams.prepareModelForSlot).toHaveBeenCalledTimes(1);
    expect(readUpgradeRecord()?.phase).toBe('done');
    expect(readUpgradeRecord()?.phase).not.toBe('accepted');
  });

  it('performUpgradeSwap: a genuine WebLLM cache miss still reverts to re-download (the probe is really consulted)', async () => {
    writeUpgradeRecord(record({ phase: 'staged', targetModelId: 'wm' }));
    vi.mocked(webllmModelInCache).mockResolvedValue(false);
    const seams = {
      getModel: vi.fn(() => webllmModel('wm')),
      prepareModelForSlot: vi.fn(async () => ({ success: true as const })),
      getSlot: vi.fn(() => ({ slot: 'eco-smart' as const, modelId: null, model: null, status: 'empty' as const })),
      recordEvidence: vi.fn(),
      getDeviceProfile: vi.fn(() => PROFILE),
    };
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('reverted-to-download');
    expect(seams.prepareModelForSlot).not.toHaveBeenCalled();
    expect(readUpgradeRecord()?.phase).toBe('accepted');
  });

  it('runUpgradeDownload: a webllm target routes through the cache bridge, not plain downloadModel', async () => {
    writeUpgradeRecord(record({ phase: 'accepted', targetModelId: 'wm' }));
    const seams = {
      // `download` deliberately NOT injected — exercise the runtime-aware default.
      getModel: vi.fn(() => webllmModel('wm')),
      acquireLease: vi.fn(() => ({ ok: true as const, lease: {} as never, release: vi.fn() })),
      describeBusy: vi.fn(() => 'busy copy'),
      isModelFullyCached: vi.fn(async () => false),
    };
    const outcome = await runUpgradeDownload({ seams });
    expect(outcome.kind).toBe('staged');
    expect(bridgeDownloadWebLLMModel).toHaveBeenCalledTimes(1);
    expect(bridgeDownloadWebLLMModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wm', runtime: 'webllm' }),
      expect.anything(),
    );
    expect(downloadModel).not.toHaveBeenCalled();
    expect(readUpgradeRecord()?.phase).toBe('staged');
  });
});
