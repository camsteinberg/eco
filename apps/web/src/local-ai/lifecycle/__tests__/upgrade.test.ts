// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * In-place model pull — the state machine behind the composer's model tiles.
 *
 * Covers:
 *   - The pure transition table: idle→accepted→downloading→staged→swapping→
 *     done, with the deferred side state, the swap-attempt cap, and invalid
 *     transitions being ignored.
 *   - `request`: the user's own ask, from idle and over any settled record,
 *     refused only while a cycle is mid-flight.
 *   - Persistence: records survive write→read; corrupt rows read as idle; a
 *     record written before the pair selector reads as an eco-smart target.
 *   - The download driver: lease-guarded, fast-path when cached, transient
 *     retry, honest storage deferral, abort leaves the phase resumable.
 *   - The swap driver: calls prepareModelForSlot on the slot the record NAMES,
 *     busy does not burn an attempt, cap 2 defers, evicted cache re-downloads.
 *   - Boot reconcile: interrupted swapping resets to staged; a legacy `offered`
 *     record clears.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceProfile, ModelConfig } from '../../types';
import {
  MAX_SWAP_ATTEMPTS,
  UPGRADE_STORAGE_KEY,
  _resetUpgradeForTesting,
  isUpgradeInFlightForSlot,
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
    phase: 'accepted',
    targetModelId: 'target',
    targetSlot: 'eco-smart',
    baseModelId: 'starter',
    deferral: null,
    swapAttempts: 0,
    updatedAt: 1000,
    ...over,
  };
}

// ─── Pure transitions ───────────────────────────────────────────────────────

describe('transitionUpgrade — the happy path', () => {
  it('walks idle → accepted → downloading → staged → swapping → done', () => {
    let r = transitionUpgrade(
      null,
      { type: 'request', targetModelId: 'target', targetSlot: 'eco-smart' },
      1,
    );
    // The tile's confirm IS the consent, so a request lands on accepted with no
    // offered step in between.
    expect(r?.phase).toBe('accepted');
    expect(r?.targetSlot).toBe('eco-smart');
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

  it('ignores invalid transitions on an idle or wrong-phase record', () => {
    expect(transitionUpgrade(null, { type: 'swap-started' }, 2)).toBeNull();
    expect(transitionUpgrade(record({ phase: 'downloading' }), { type: 'swap-started' }, 2)?.phase).toBe('downloading');
    const done = record({ phase: 'done' });
    expect(transitionUpgrade(done, { type: 'download-started' }, 2)).toEqual(done);
  });

  it('reset returns to idle from any phase', () => {
    expect(transitionUpgrade(record({ phase: 'downloading' }), { type: 'reset' }, 2)).toBeNull();
  });
});

describe('transitionUpgrade — request (the user asked for this model)', () => {
  const request = { type: 'request' as const, targetModelId: 'new-target', targetSlot: 'eco-fast' as const };

  it('starts a cycle from idle, already accepted, on the slot it names', () => {
    const r = transitionUpgrade(null, request, 2);
    expect(r?.phase).toBe('accepted');
    expect(r?.targetModelId).toBe('new-target');
    expect(r?.targetSlot).toBe('eco-fast');
    expect(r?.swapAttempts).toBe(0);
    expect(r?.deferral).toBeNull();
  });

  it('a settled cycle never blocks a fresh ask, for the same target or another', () => {
    for (const phase of ['done', 'declined', 'deferred'] as const) {
      const settled = record({
        phase,
        targetModelId: 'old-target',
        swapAttempts: 2,
        deferral: { code: 'swap-failed', message: 'x' },
      });
      const other = transitionUpgrade(settled, request, 2);
      expect(other?.phase).toBe('accepted');
      expect(other?.targetModelId).toBe('new-target');
      expect(other?.targetSlot).toBe('eco-fast');
      // A fresh cycle starts clean: the old failures are not this one's.
      expect(other?.swapAttempts).toBe(0);
      expect(other?.deferral).toBeNull();

      const again = transitionUpgrade(
        record({ phase, targetModelId: 'new-target' }),
        request,
        2,
      );
      expect(again?.phase).toBe('accepted');
    }
  });

  it('is refused while a cycle is mid-flight, whatever it asks for', () => {
    for (const phase of ['accepted', 'downloading', 'staged', 'swapping'] as const) {
      const inFlight = record({ phase, targetModelId: 'target' });
      expect(transitionUpgrade(inFlight, request, 2)).toEqual(inFlight);
      expect(
        transitionUpgrade(inFlight, { ...request, targetModelId: 'target' }, 2),
      ).toEqual(inFlight);
    }
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
    expect(seen[0]?.phase).toBe('accepted');
    expect(seen[1]).toBeNull();
  });

  it('reads a record written before the pair selector as an eco-smart target', () => {
    // Every cycle the old popup could write bound eco-smart, so that is what a
    // slotless row means — not a reason to drop the row and lose staged bytes.
    storage.setItem(UPGRADE_STORAGE_KEY, JSON.stringify({
      version: 1,
      phase: 'staged',
      targetModelId: 'target',
      baseModelId: 'starter',
      deferral: null,
      swapAttempts: 0,
      updatedAt: 0,
    }));
    expect(readUpgradeRecord()?.targetSlot).toBe('eco-smart');
  });

  it('reads a garbage slot as eco-smart rather than trusting it', () => {
    storage.setItem(UPGRADE_STORAGE_KEY, JSON.stringify({
      version: 1,
      phase: 'staged',
      targetModelId: 'target',
      targetSlot: 'eco-nonsense',
      deferral: null,
      swapAttempts: 0,
      updatedAt: 0,
    }));
    expect(readUpgradeRecord()?.targetSlot).toBe('eco-smart');
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

  it('carries the byte figures into the deferral, and back out of storage', async () => {
    // The tile lays the numbers out itself; flattening the error to a code and
    // a sentence left it with nothing to say beyond "that did not work".
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams({
      download: vi.fn(async () => {
        throw new InsufficientStorageError(1_700_000_000, 400_000_000);
      }),
    });

    const outcome = await runUpgradeDownload({ seams });

    expect(outcome).toMatchObject({
      kind: 'deferred',
      deferral: { requiredBytes: 1_700_000_000, availableBytes: 400_000_000 },
    });
    // Survives the persisted round trip, so a reload still explains itself.
    expect(readUpgradeRecord()?.deferral).toMatchObject({
      code: 'insufficient-storage',
      requiredBytes: 1_700_000_000,
      availableBytes: 400_000_000,
    });
  });

  it('omits the available figure when the failure origin never had one', async () => {
    writeUpgradeRecord(record({ phase: 'accepted' }));
    const seams = downloadSeams({
      download: vi.fn(async () => {
        // A mid-write quota error: it knows only what was still to write.
        throw new InsufficientStorageError(1_700_000_000);
      }),
    });

    await runUpgradeDownload({ seams });

    const deferral = readUpgradeRecord()?.deferral;
    expect(deferral?.requiredBytes).toBe(1_700_000_000);
    expect(deferral?.availableBytes).toBeUndefined();
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
  it('swaps a staged target into the slot its record names, and lands done', async () => {
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

  it('binds eco-fast when that is the slot the user pulled into', async () => {
    // The pair's everyday tile owns eco-fast. Before the pair selector this
    // driver hardcoded eco-smart, which would have bound the wrong slot and
    // left the tapped tile still reading "Not downloaded".
    writeUpgradeRecord(record({ phase: 'staged', targetSlot: 'eco-fast' }));
    const seams = swapSeams();
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('swapped');
    expect(seams.prepareModelForSlot).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'eco-fast', modelId: 'target' }),
    );
    // The rollback target is read from the SAME slot it binds.
    expect(seams.getSlot).toHaveBeenCalledWith('eco-fast');
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

  it('the harness hold seam parks in swapping without touching the cache or the runtime', async () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    const progress = vi.fn();
    const seams = swapSeams({
      getSwapMode: vi.fn(() => 'hold' as const),
      // A device that never really downloaded the target — the exact case that
      // makes the mid-swap tile unreachable for a validator.
      isModelFullyCached: vi.fn(async () => false),
    });
    let settled = false;
    void performUpgradeSwap({ seams, onProgress: progress }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(readUpgradeRecord()?.phase).toBe('swapping');
    expect(seams.isModelFullyCached).not.toHaveBeenCalled();
    expect(seams.prepareModelForSlot).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith({ kind: 'load', fraction: 0.6 });
    // The whole point: it never resolves, so the UI stays on the swapping
    // surface for as long as the page lives.
    expect(settled).toBe(false);
  });

  it('the hold seam is off by default, so the shipping swap path is untouched', async () => {
    writeUpgradeRecord(record({ phase: 'staged' }));
    const seams = swapSeams();
    const outcome = await performUpgradeSwap({ seams });
    expect(outcome.kind).toBe('swapped');
    expect(seams.prepareModelForSlot).toHaveBeenCalled();
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

  it('clears a legacy offered record — the popup that could answer it is gone', () => {
    writeUpgradeRecord(record({ phase: 'offered' }));
    expect(reconcileUpgradeOnBoot()).toBeNull();
    expect(readUpgradeRecord()).toBeNull();
  });

  it('leaves every other phase untouched', () => {
    for (const phase of ['accepted', 'downloading', 'staged', 'declined', 'deferred', 'done'] as const) {
      writeUpgradeRecord(record({ phase }));
      expect(reconcileUpgradeOnBoot()?.phase).toBe(phase);
    }
    writeUpgradeRecord(null);
    expect(reconcileUpgradeOnBoot()).toBeNull();
  });
});

describe('isUpgradeInFlightForSlot', () => {
  it('is true for the slot being prepared, while it is being prepared', () => {
    for (const phase of ['accepted', 'downloading', 'staged', 'swapping'] as const) {
      writeUpgradeRecord(record({ phase, targetSlot: 'eco-smart' }));
      expect(isUpgradeInFlightForSlot('eco-smart')).toBe(true);
    }
  });

  it('is false for the OTHER slot, so a background pull never masks its errors', () => {
    for (const phase of ['accepted', 'downloading', 'staged', 'swapping'] as const) {
      writeUpgradeRecord(record({ phase, targetSlot: 'eco-smart' }));
      expect(isUpgradeInFlightForSlot('eco-fast')).toBe(false);
    }
  });

  it('is false when settled or absent, so genuine errors are never masked', () => {
    for (const phase of ['offered', 'declined', 'deferred', 'done'] as const) {
      writeUpgradeRecord(record({ phase }));
      expect(isUpgradeInFlightForSlot('eco-smart')).toBe(false);
    }
    writeUpgradeRecord(null);
    expect(isUpgradeInFlightForSlot('eco-smart')).toBe(false);
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
