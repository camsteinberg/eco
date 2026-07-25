// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Consent-driven upgrade — the Stage B state machine (instant-start slice 2b).
 *
 * Stage A (setup-runner) gets a fresh device chatting on the smallest
 * trustworthy model in about a minute. This module carries the device from
 * that starter to the class-best pick — with the user's consent at every
 * heavy step, honoring the locked product decisions: nothing heavy downloads
 * without a yes, the swap asks first and never happens mid-generation, and a
 * decline is remembered instead of nagged.
 *
 *   idle → offered → accepted → downloading → staged → swapping → done
 *                  ↘ declined                ↘ deferred(reason)
 *
 * The phase record persists under `eco-local-ai-upgrade-v1` so the machine
 * resumes across reloads: an interrupted download resumes via the download
 * pipeline's per-file verify-skip; an interrupted swap resets to `staged`
 * (the next boot starts on the staged model). `declined` and `deferred` are
 * settled states — the popup never returns for the same target; a quiet
 * affordance (Settings) can re-enter via `accept`.
 *
 * Layering mirrors the rest of lifecycle/: a PURE transition table
 * (`transitionUpgrade`) that tests enumerate exhaustively, thin persistence
 * with an injectable storage, and two effectful drivers with injected seams —
 * `runUpgradeDownload` (holds the 'download' lease; coexists with chat by
 * design after the 2a lease split) and `performUpgradeSwap` (delegates to
 * `prepareModelForSlot`, which owns the 'switch-model' runtime lease, the
 * watchdog, smoke, evidence, and rollback).
 */

import type { DeviceProfile, ModelConfig, Slot } from '../types';
import type { ProgressEvent } from '../download/progress';
import type {
  LocalHeavyWorkAcquireResult,
  LocalHeavyWorkKind,
  LocalHeavyWorkLease,
} from '../../lib/local-heavy-work-owner';
import {
  acquireLocalHeavyWork,
  describeLocalHeavyWorkBusy,
} from '../../lib/local-heavy-work-owner';
import { getModel } from '../catalog/catalog';
import {
  DownloadAbortedError,
  InsufficientStorageError,
  downloadModel,
  isModelDownloaded,
} from '../download/download';
import { bridgeDownloadWebLLMModel } from '../runtime/webllm-cache-bridge';
import { ProgressTracker } from '../download/progress';
import { getDeviceProfile } from '../device/profile';
import { recordEvidence } from '../evidence/ledger';
import { recommend } from '../selection/recommend';
import {
  prepareModelForSlot,
  type SwitchModelResult,
  type SwitchProgressEvent,
} from './switch-model';
import { getSlot, type SlotState } from './slots';

// ─── Record ─────────────────────────────────────────────────────────────────

export const UPGRADE_STORAGE_KEY = 'eco-local-ai-upgrade-v1';

/** Swap (load + smoke) attempts per target before the machine defers. */
export const MAX_SWAP_ATTEMPTS = 2;

export type UpgradePhase =
  | 'offered'
  | 'accepted'
  | 'downloading'
  | 'staged'
  | 'swapping'
  | 'done'
  | 'declined'
  | 'deferred';

export type UpgradeDeferralCode = 'insufficient-storage' | 'download-failed' | 'swap-failed';

export type UpgradeDeferral = {
  code: UpgradeDeferralCode;
  /** Honest, user-facing sentence for the quiet note. */
  message: string;
};

export type UpgradeRecord = {
  version: 1;
  phase: UpgradePhase;
  /** Catalog id of the class-best model this cycle is carrying the device to. */
  targetModelId: string;
  /** The eco-fast model at offer time (the starter) — context for copy. */
  baseModelId: string | null;
  deferral: UpgradeDeferral | null;
  swapAttempts: number;
  updatedAt: number;
};

// ─── Storage (mirrors lifecycle/slots.ts) ───────────────────────────────────

type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let injectedStorage: KeyValueStorage | null = null;

/** Override the storage backend. Tests pass an in-memory map. */
export function setUpgradeStorage(storage: KeyValueStorage | null): void {
  injectedStorage = storage;
}

function resolveStorage(): KeyValueStorage | null {
  if (injectedStorage) return injectedStorage;
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as { localStorage?: KeyValueStorage };
  return g.localStorage ?? null;
}

type UpgradeChangeHandler = (record: UpgradeRecord | null) => void;
const subscribers = new Set<UpgradeChangeHandler>();

export function subscribeUpgrade(handler: UpgradeChangeHandler): () => void {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

function notify(record: UpgradeRecord | null): void {
  for (const handler of subscribers) handler(record);
}

const PHASES: ReadonlyArray<UpgradePhase> = [
  'offered', 'accepted', 'downloading', 'staged', 'swapping', 'done', 'declined', 'deferred',
];

export function readUpgradeRecord(): UpgradeRecord | null {
  const storage = resolveStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(UPGRADE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UpgradeRecord>;
    if (
      parsed.version !== 1
      || typeof parsed.targetModelId !== 'string'
      || !PHASES.includes(parsed.phase as UpgradePhase)
    ) {
      return null;
    }
    return {
      version: 1,
      phase: parsed.phase as UpgradePhase,
      targetModelId: parsed.targetModelId,
      baseModelId: typeof parsed.baseModelId === 'string' ? parsed.baseModelId : null,
      deferral: isDeferral(parsed.deferral) ? parsed.deferral : null,
      swapAttempts: typeof parsed.swapAttempts === 'number' ? parsed.swapAttempts : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function isDeferral(value: unknown): value is UpgradeDeferral {
  if (value == null || typeof value !== 'object') return false;
  const v = value as Partial<UpgradeDeferral>;
  return (
    (v.code === 'insufficient-storage' || v.code === 'download-failed' || v.code === 'swap-failed')
    && typeof v.message === 'string'
  );
}

export function writeUpgradeRecord(record: UpgradeRecord | null): void {
  const storage = resolveStorage();
  if (!storage) return;
  try {
    if (record) storage.setItem(UPGRADE_STORAGE_KEY, JSON.stringify(record));
    else storage.removeItem(UPGRADE_STORAGE_KEY);
  } catch {
    // Persistence is best-effort — the in-session flow keeps working.
  }
  notify(record);
}

/** Test-only: clear injected storage and subscribers. */
export function _resetUpgradeForTesting(): void {
  injectedStorage = null;
  subscribers.clear();
}

// ─── Pure transition table ──────────────────────────────────────────────────

export type UpgradeEvent =
  | { type: 'offer'; targetModelId: string; baseModelId: string | null }
  | { type: 'accept' }
  | { type: 'decline' }
  | { type: 'download-started' }
  | { type: 'download-completed' }
  | { type: 'download-failed'; deferral: UpgradeDeferral }
  | { type: 'swap-started' }
  | { type: 'swap-succeeded' }
  | { type: 'swap-failed' }
  /** The runtime was busy — nothing was attempted, no attempt is burned. */
  | { type: 'swap-busy' }
  /** Staged bytes vanished (eviction) — go back and re-download. */
  | { type: 'cache-evicted' }
  | { type: 'reset' };

/**
 * The pure state machine. Returns the next record (null = idle). Invalid
 * transitions return the input unchanged — the machine is deliberately
 * tolerant of racing events (two tabs, stale UI) rather than throwing.
 */
export function transitionUpgrade(
  record: UpgradeRecord | null,
  event: UpgradeEvent,
  now: number,
): UpgradeRecord | null {
  if (event.type === 'reset') return null;

  if (event.type === 'offer') {
    // A settled cycle for a DIFFERENT target starts fresh (the recommendation
    // moved); the same target stays settled (no nagging), and a mid-flight
    // cycle is never interrupted.
    if (record && record.targetModelId === event.targetModelId) return record;
    if (record && !isSettledPhase(record.phase)) return record;
    return {
      version: 1,
      phase: 'offered',
      targetModelId: event.targetModelId,
      baseModelId: event.baseModelId,
      deferral: null,
      swapAttempts: 0,
      updatedAt: now,
    };
  }

  if (!record) return null;
  const to = (phase: UpgradePhase, patch: Partial<UpgradeRecord> = {}): UpgradeRecord => ({
    ...record,
    ...patch,
    phase,
    updatedAt: now,
  });

  switch (event.type) {
    case 'accept':
      return record.phase === 'offered' || record.phase === 'declined' || record.phase === 'deferred'
        ? to('accepted', { deferral: null })
        : record;
    case 'decline':
      return record.phase === 'offered' ? to('declined') : record;
    case 'download-started':
      return record.phase === 'accepted' || record.phase === 'downloading'
        ? to('downloading')
        : record;
    case 'download-completed':
      return record.phase === 'downloading' || record.phase === 'accepted'
        ? to('staged')
        : record;
    case 'download-failed':
      return record.phase === 'downloading' || record.phase === 'accepted'
        ? to('deferred', { deferral: event.deferral })
        : record;
    case 'swap-started':
      if (record.phase !== 'staged') return record;
      if (record.swapAttempts >= MAX_SWAP_ATTEMPTS) {
        return to('deferred', { deferral: SWAP_FAILED_DEFERRAL });
      }
      return to('swapping', { swapAttempts: record.swapAttempts + 1 });
    case 'swap-succeeded':
      return record.phase === 'swapping' ? to('done') : record;
    case 'swap-failed':
      if (record.phase !== 'swapping') return record;
      return record.swapAttempts >= MAX_SWAP_ATTEMPTS
        ? to('deferred', { deferral: SWAP_FAILED_DEFERRAL })
        : to('staged');
    case 'swap-busy':
      // Nothing was attempted — return the attempt the optimistic
      // swap-started charged.
      return record.phase === 'swapping'
        ? to('staged', { swapAttempts: Math.max(0, record.swapAttempts - 1) })
        : record;
    case 'cache-evicted':
      return record.phase === 'staged' ? to('accepted') : record;
    default:
      return record;
  }
}

const SWAP_FAILED_DEFERRAL: UpgradeDeferral = {
  code: 'swap-failed',
  message: "The stronger model didn't run well on this device — you're all set with the current one.",
};

function isSettledPhase(phase: UpgradePhase): boolean {
  return phase === 'declined' || phase === 'deferred' || phase === 'done';
}

/** Apply an event to the persisted record and return the new record. */
export function applyUpgradeEvent(event: UpgradeEvent, now = Date.now()): UpgradeRecord | null {
  const next = transitionUpgrade(readUpgradeRecord(), event, now);
  writeUpgradeRecord(next);
  return next;
}

// ─── Offer eligibility ──────────────────────────────────────────────────────

export type PlanUpgradeOfferOptions = {
  profile: DeviceProfile;
  /** The eco-fast bound model id (the starter the device is chatting on). */
  currentModelId: string | null;
  /** The eco-smart model id when that slot is already ready, else null. */
  ecoSmartReadyModelId: string | null;
  record: UpgradeRecord | null;
  /** Seam — defaults to recommend('eco-smart', profile) with a null-on-throw guard. */
  recommendSmart?: (profile: DeviceProfile) => ModelConfig | null;
  /** Seam — defaults to isModelFullyCached. Never offer a DOWNLOAD for a model
   *  already fully on disk (a phantom "upgrade" offer for cached weights). */
  isTargetCached?: (model: ModelConfig) => Promise<boolean>;
};

/**
 * The model the popup should offer, or null when there is nothing to offer:
 * no resolvable recommendation, the device already runs it (convergence /
 * already upgraded), a cycle for it is settled (no nagging), or a cycle is
 * mid-flight. A settled cycle for a DIFFERENT target allows a fresh offer —
 * the recommendation legitimately moves when evidence or the profile changes.
 */
export async function planUpgradeOffer(options: PlanUpgradeOfferOptions): Promise<ModelConfig | null> {
  const recommendSmart = options.recommendSmart ?? defaultRecommendSmart;
  const isTargetCached = options.isTargetCached ?? isModelDownloaded;
  const target = recommendSmart(options.profile);
  if (!target) return null;
  if (target.id === options.currentModelId) return null;
  if (target.id === options.ecoSmartReadyModelId) return null;

  const record = options.record;
  if (record) {
    if (record.targetModelId === target.id && record.phase !== 'offered') return null;
    if (record.targetModelId !== target.id && !isSettledPhase(record.phase)) return null;
  }
  // Never offer a DOWNLOAD for a model already fully on disk. Field-observed:
  // an interrupted download left the slot inconsistent, and a stale offer
  // surfaced for weights that were in fact already cached. The probe runs last
  // so the cheap sync checks above can short-circuit it. A probe error reads as
  // "not cached" (fail toward offering) so a storage blip never suppresses a
  // genuine upgrade.
  if (await isTargetCached(target).catch(() => false)) return null;
  return target;
}

function defaultRecommendSmart(profile: DeviceProfile): ModelConfig | null {
  try {
    return recommend('eco-smart', profile);
  } catch {
    return null;
  }
}

// ─── Download driver ────────────────────────────────────────────────────────

export type UpgradeDownloadSeams = {
  getModel: (modelId: string) => ModelConfig | null;
  acquireLease: (kind: LocalHeavyWorkKind) => LocalHeavyWorkAcquireResult;
  describeBusy: (active: LocalHeavyWorkLease | null) => string;
  download: (
    model: ModelConfig,
    options: { signal?: AbortSignal; onProgressEvent?: (event: ProgressEvent) => void },
  ) => Promise<void>;
  isModelFullyCached: (model: ModelConfig) => Promise<boolean>;
};

const DEFAULT_DOWNLOAD_SEAMS: UpgradeDownloadSeams = {
  getModel,
  acquireLease: acquireLocalHeavyWork,
  describeBusy: describeLocalHeavyWorkBusy,
  download: async (model, options) => {
    const tracker = new ProgressTracker();
    const unsubscribe = options.onProgressEvent
      ? tracker.subscribe(options.onProgressEvent)
      : null;
    try {
      // A `webllm` model routes through the cache bridge (Eco download → stage
      // into WebLLM's own cache); staging bytes without bridging them would
      // leave the target "downloaded" yet unservable. Every other runtime is
      // unchanged. Mirrors setup-runner's attempt path.
      if (model.runtime === 'webllm') {
        await bridgeDownloadWebLLMModel(model, { tracker, signal: options.signal });
      } else {
        await downloadModel(model, { tracker, signal: options.signal });
      }
    } finally {
      unsubscribe?.();
    }
  },
  isModelFullyCached: isModelDownloaded,
};

export type UpgradeDownloadOutcome =
  | { kind: 'staged' }
  | { kind: 'busy'; message: string }
  | { kind: 'aborted' }
  | { kind: 'deferred'; deferral: UpgradeDeferral }
  | { kind: 'invalid-phase' };

export type RunUpgradeDownloadOptions = {
  signal?: AbortSignal;
  onProgressEvent?: (event: ProgressEvent) => void;
  seams?: Partial<UpgradeDownloadSeams>;
};

/**
 * Drive an accepted (or reload-interrupted downloading) record to `staged`.
 *
 * Holds the 'download' lease for the transfer — one background download at a
 * time across tabs, while chat keeps running (the 2a lease split). Storage
 * headroom is the download pipeline's own preflight; its honest error becomes
 * an 'insufficient-storage' deferral. One transient retry mirrors the setup
 * cascade's blip tolerance. An abort (tab closing, explicit stop) leaves the
 * record in 'downloading' — the next session resumes via per-file verify-skip.
 */
export async function runUpgradeDownload(
  options: RunUpgradeDownloadOptions = {},
): Promise<UpgradeDownloadOutcome> {
  const seams: UpgradeDownloadSeams = { ...DEFAULT_DOWNLOAD_SEAMS, ...options.seams };
  const record = readUpgradeRecord();
  if (!record || (record.phase !== 'accepted' && record.phase !== 'downloading')) {
    return { kind: 'invalid-phase' };
  }
  const target = seams.getModel(record.targetModelId);
  if (!target) {
    // The catalog no longer carries this model — settle the cycle quietly.
    applyUpgradeEvent({ type: 'reset' });
    return { kind: 'invalid-phase' };
  }

  // Already fully on disk (a prior session finished the bytes, or the user
  // downloaded it via Settings) — nothing to transfer.
  if (await seams.isModelFullyCached(target).catch(() => false)) {
    applyUpgradeEvent({ type: 'download-completed' });
    return { kind: 'staged' };
  }

  const lease = seams.acquireLease('download');
  if (!lease.ok) {
    return { kind: 'busy', message: seams.describeBusy(lease.active) };
  }

  applyUpgradeEvent({ type: 'download-started' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await seams.download(target, {
          signal: options.signal,
          onProgressEvent: options.onProgressEvent,
        });
        applyUpgradeEvent({ type: 'download-completed' });
        return { kind: 'staged' };
      } catch (err) {
        if (options.signal?.aborted || err instanceof DownloadAbortedError) {
          // Leave the record 'downloading' — resumable next session.
          return { kind: 'aborted' };
        }
        if (err instanceof InsufficientStorageError) {
          // Deterministic — retrying can't free space. Defer with the
          // pipeline's honest byte-count message.
          const deferral: UpgradeDeferral = { code: 'insufficient-storage', message: err.message };
          applyUpgradeEvent({ type: 'download-failed', deferral });
          return { kind: 'deferred', deferral };
        }
        // Transient — fall through to the retry (or the deferral below).
      }
    }
    const deferral: UpgradeDeferral = {
      code: 'download-failed',
      message: "We couldn't fetch the stronger model — you're all set with the current one.",
    };
    applyUpgradeEvent({ type: 'download-failed', deferral });
    return { kind: 'deferred', deferral };
  } finally {
    lease.release();
  }
}

// ─── Swap driver ────────────────────────────────────────────────────────────

export type UpgradeSwapSeams = {
  getModel: (modelId: string) => ModelConfig | null;
  isModelFullyCached: (model: ModelConfig) => Promise<boolean>;
  getSlot: (slot: Slot) => SlotState;
  prepareModelForSlot: (options: {
    slot: Slot;
    modelId: string;
    previous: ModelConfig | null;
    signal?: AbortSignal;
    onProgress?: (event: SwitchProgressEvent) => void;
  }) => Promise<SwitchModelResult>;
  recordEvidence: typeof recordEvidence;
  getDeviceProfile: () => DeviceProfile;
};

const DEFAULT_SWAP_SEAMS: UpgradeSwapSeams = {
  getModel,
  isModelFullyCached: isModelDownloaded,
  getSlot,
  prepareModelForSlot,
  recordEvidence,
  getDeviceProfile,
};

export type UpgradeSwapOutcome =
  | { kind: 'swapped'; model: ModelConfig }
  | { kind: 'busy'; message: string }
  | { kind: 'reverted-to-download' }
  | { kind: 'failed'; result: SwitchModelResult }
  | { kind: 'deferred'; deferral: UpgradeDeferral }
  | { kind: 'invalid-phase' };

export type PerformUpgradeSwapOptions = {
  signal?: AbortSignal;
  onProgress?: (event: SwitchProgressEvent) => void;
  seams?: Partial<UpgradeSwapSeams>;
};

/**
 * Swap a staged target into the eco-smart slot via the audited switch
 * primitive. The primitive owns the 'switch-model' runtime lease (never under
 * an active generation), the stall watchdog, smoke, evidence, and rollback —
 * on failure the eco-smart slot rolls back and the starter stays bound and
 * cached on eco-fast, so recovery is a pointer move, not a re-download.
 * Busy is honest and free (no attempt burned); real failures burn one of
 * MAX_SWAP_ATTEMPTS before the machine defers for good.
 */
export async function performUpgradeSwap(
  options: PerformUpgradeSwapOptions = {},
): Promise<UpgradeSwapOutcome> {
  const seams: UpgradeSwapSeams = { ...DEFAULT_SWAP_SEAMS, ...options.seams };
  const record = readUpgradeRecord();
  if (!record || record.phase !== 'staged') return { kind: 'invalid-phase' };

  const target = seams.getModel(record.targetModelId);
  if (!target) {
    applyUpgradeEvent({ type: 'reset' });
    return { kind: 'invalid-phase' };
  }

  // Staged means "bytes verified on disk". If the browser evicted them since,
  // loading would fail after a long stall — go back to the download phase and
  // let the resume path (verify-skip) fetch only what's missing.
  if (!(await seams.isModelFullyCached(target).catch(() => false))) {
    applyUpgradeEvent({ type: 'cache-evicted' });
    return { kind: 'reverted-to-download' };
  }

  const started = applyUpgradeEvent({ type: 'swap-started' });
  if (started?.phase !== 'swapping') {
    // The cap fired inside the transition — the record is now deferred.
    return started?.phase === 'deferred' && started.deferral
      ? { kind: 'deferred', deferral: started.deferral }
      : { kind: 'invalid-phase' };
  }

  // Mirror the swap outcome into the ledger (slice 3). swap-pass/swap-fail are
  // distinct from the load-fail/smoke-fail rows prepareModelForSlot already
  // writes — they record the UPGRADE cycle's result, the single source the
  // recommender and diagnostics read. A busy swap attempts nothing, so it emits
  // no row. Best-effort — a ledger write must never break the swap.
  const recordSwap = (outcome: 'swap-pass' | 'swap-fail'): void => {
    try {
      seams.recordEvidence({ modelId: target.id, profile: seams.getDeviceProfile(), outcome });
    } catch {
      // Swallow.
    }
  };

  const previous = seams.getSlot('eco-smart').model;
  const result = await seams.prepareModelForSlot({
    slot: 'eco-smart',
    modelId: record.targetModelId,
    previous,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  if (result.success) {
    recordSwap('swap-pass');
    applyUpgradeEvent({ type: 'swap-succeeded' });
    return { kind: 'swapped', model: target };
  }

  if (result.reason === 'busy') {
    applyUpgradeEvent({ type: 'swap-busy' });
    return { kind: 'busy', message: result.busyMessage ?? 'The model runtime is busy right now.' };
  }

  recordSwap('swap-fail');
  const after = applyUpgradeEvent({ type: 'swap-failed' });
  return after?.phase === 'deferred' && after.deferral
    ? { kind: 'deferred', deferral: after.deferral }
    : { kind: 'failed', result };
}

// ─── Boot reconcile ─────────────────────────────────────────────────────────

/**
 * Boot-time repair: an interrupted swap (tab closed / crashed mid-load) reads
 * as 'swapping' but nothing is running — reset it to 'staged' so the boot
 * path can start on the staged model. The interrupted attempt stays counted:
 * a swap that crashes the tab must not retry forever.
 */
export function reconcileUpgradeOnBoot(): UpgradeRecord | null {
  const record = readUpgradeRecord();
  if (!record) return null;
  if (record.phase !== 'swapping') return record;
  const repaired: UpgradeRecord = { ...record, phase: 'staged', updatedAt: Date.now() };
  writeUpgradeRecord(repaired);
  return repaired;
}

/**
 * True when a verified upgrade is staged and waiting (or was interrupted
 * mid-swap — boot reconcile turns that back into staged). The chat-mount
 * warmup consults this: warming the starter right before the boot swap
 * replaces it would waste the most expensive step (load + shader compile)
 * on a model about to be unloaded.
 */
export function hasStagedUpgrade(): boolean {
  const phase = readUpgradeRecord()?.phase;
  return phase === 'staged' || phase === 'swapping';
}

/**
 * True while an upgrade cycle is actively carrying the device to the stronger
 * model — accepted → downloading → staged → swapping (the whole "still
 * preparing" window, including an interrupted-and-persisted download after a
 * reload). The chat error surface consults this so a send that lands in this
 * window resolves to the honest "preparing, please wait" guard instead of a
 * generic error card: the failure is "not ready yet," not a fault. Settled
 * phases (done / declined / deferred) and no record return false, so genuine
 * errors on a ready model still surface normally.
 */
export function isUpgradeInFlight(): boolean {
  const phase = readUpgradeRecord()?.phase;
  return (
    phase === 'accepted'
    || phase === 'downloading'
    || phase === 'staged'
    || phase === 'swapping'
  );
}
