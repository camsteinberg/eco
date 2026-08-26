// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Switch-model primitive — prepare a model for a slot, React-free.
 *
 * Extracted from LocalAiSettingsAdapter's inline onSwitchRequested so the
 * Settings "Switch AI" flow and the slice-2b consent-driven upgrade share
 * ONE audited path: downloadModel (headroom preflight + chunked/SHA
 * verification) → runtime load (stall-watchdogged) → smoke → bind, with
 * rollback to the previous model on any failure. The old Settings flow let
 * the transformers worker download implicitly, silently bypassing the
 * headroom preflight and the chunked/SHA download pipeline — that bypass
 * is closed by construction here.
 *
 * Concurrency: the whole operation holds the 'switch-model' runtime lease
 * (never swaps under an active generation/readiness check); the download
 * step additionally holds the 'download' lease (single heavy download
 * invariant). Busy is an honest first-class result, not an exception.
 *
 * All side effects go through injected seams (defaulting to the real
 * implementations) so the policy is unit-testable with plain fakes.
 */

import type { DeviceProfile, Intent, ModelConfig, Slot } from '../types';
import type { LoadOptions, LoadResult, RuntimeBackend } from '../runtime/types';
import type { SmokeResult } from './smoke';
import type { ProgressEvent } from '../download/progress';
import type {
  LocalHeavyWorkAcquireResult,
  LocalHeavyWorkKind,
  LocalHeavyWorkLease,
} from '../../lib/local-heavy-work-owner';
import type { SeedEvidenceSource } from '../evidence/seed';
import {
  acquireLocalHeavyWork,
  describeLocalHeavyWorkBusy,
} from '../../lib/local-heavy-work-owner';
import { getModel } from '../catalog/catalog';
import { getDeviceProfile } from '../device/profile';
import { DownloadFailedError, InsufficientStorageError, downloadModel } from '../download/download';
import { ProgressTracker } from '../download/progress';
import { hasRecentSuccess, recordEvidence } from '../evidence/ledger';
import { loadSeedEvidenceForModel } from '../evidence/seed';
import { loadModel } from '../runtime/lifecycle';
import { nextInCascade } from '../selection/cascade';
import { runSmoke } from './smoke';
import { setSlot, setSlotStatus, type SlotStatus } from './slots';

// ─── Result types ───────────────────────────────────────────────────────────

/**
 * Reason a switch failed.
 *
 *   - 'busy'           — another heavy task owns the runtime; nothing attempted.
 *   - 'network-failed' — the download couldn't complete (dropped connection,
 *     HTTP/transport error). Transient and about the network, NOT the device —
 *     the copy must not blame hardware or push a downgrade.
 *   - 'insufficient-storage' — the download's free-space preflight failed.
 *     About the DISK, not the device: a user with a fullish drive must be
 *     told to free space (with the real figures), not that their "hardware"
 *     can't run the model.
 *   - 'load-failed'    — bytes were fetched but the model wouldn't run here
 *     (genuine hardware/runtime incompatibility). THIS is the "try the next
 *     best fit" case.
 *   - 'smoke-failed'   — loaded but failed its readiness check.
 */
export type SwitchFailureReason =
  | 'busy'
  | 'network-failed'
  | 'insufficient-storage'
  | 'smoke-failed'
  | 'load-failed'
  | 'unknown';

/**
 * Confidence source of the failed model — lets failure copy acknowledge
 * whether this was a surprising failure (benchmark/ledger) or a missed
 * prediction (calculated).
 */
export type FailedConfidence = SeedEvidenceSource | 'ledger' | null;

export type SwitchModelResult =
  | { success: true }
  | {
      success: false;
      reason: SwitchFailureReason;
      /** The model the user tried to switch to. */
      failedModel: ModelConfig | null;
      /** Next best candidate — null when the cascade is exhausted here. */
      suggestedNext: ModelConfig | null;
      /** The model actually bound after rollback (typically the previous). */
      fallbackUsed?: ModelConfig;
      /** Confidence source of the failed model (softens surprise copy). */
      failedConfidence?: FailedConfidence;
      /** Honest copy for the 'busy' reason. */
      busyMessage?: string;
      /** Honest copy for 'insufficient-storage': the needed vs. free figures. */
      storageMessage?: string;
    };

// ─── Progress ───────────────────────────────────────────────────────────────

export type SwitchProgressEvent =
  | { kind: 'phase'; phase: string }
  | { kind: 'download'; fraction: number }
  | { kind: 'load'; fraction: number };

// ─── Seams ──────────────────────────────────────────────────────────────────

export type SwitchModelSeams = {
  getModel: (modelId: string) => ModelConfig | null;
  setSlot: (slot: Slot, model: ModelConfig | null) => void;
  setSlotStatus: (slot: Slot, status: SlotStatus) => void;
  acquireLease: (kind: LocalHeavyWorkKind) => LocalHeavyWorkAcquireResult;
  describeBusy: (active: LocalHeavyWorkLease | null) => string;
  download: (
    model: ModelConfig,
    options: { signal?: AbortSignal; onProgressEvent?: (event: ProgressEvent) => void },
  ) => Promise<void>;
  load: (model: ModelConfig, options?: LoadOptions) => Promise<LoadResult>;
  smoke: (slot: Slot, model: ModelConfig) => Promise<SmokeResult>;
  recordEvidence: typeof recordEvidence;
  getDeviceProfile: () => DeviceProfile;
  nextInCascade: (
    failed: ModelConfig,
    slot: Slot,
    profile: DeviceProfile,
    intent: Intent | undefined,
    opts: { excludeIds: string[] },
  ) => ModelConfig | null;
  deriveFailedConfidence: (modelId: string, profile: DeviceProfile) => FailedConfidence;
};

/**
 * Derive the confidence source for a model that just failed, so failure
 * copy can acknowledge whether this was a surprising failure
 * (benchmark/ledger) or a missed prediction (calculated).
 */
export function deriveFailedConfidence(
  modelId: string,
  profile: DeviceProfile,
): FailedConfidence {
  const seedProof = loadSeedEvidenceForModel(modelId, profile);
  if (seedProof) return seedProof.source;
  if (hasRecentSuccess(modelId, profile)) return 'ledger';
  return null;
}

/** Default download seam: real downloadModel behind a fresh ProgressTracker. */
async function defaultDownload(
  model: ModelConfig,
  options: { signal?: AbortSignal; onProgressEvent?: (event: ProgressEvent) => void },
): Promise<void> {
  const tracker = new ProgressTracker();
  const unsubscribe = options.onProgressEvent
    ? tracker.subscribe(options.onProgressEvent)
    : null;
  try {
    await downloadModel(model, { tracker, signal: options.signal });
  } finally {
    unsubscribe?.();
  }
}

const DEFAULT_SEAMS: SwitchModelSeams = {
  getModel,
  setSlot,
  setSlotStatus,
  acquireLease: acquireLocalHeavyWork,
  describeBusy: describeLocalHeavyWorkBusy,
  download: defaultDownload,
  load: async (model, options) => {
    const adapter = await loadModel(model, options);
    return { backend: adapter.backend };
  },
  smoke: runSmoke,
  recordEvidence,
  getDeviceProfile,
  nextInCascade,
  deriveFailedConfidence,
};

// ─── Options ────────────────────────────────────────────────────────────────

/** Seconds of zero progress (download or load) before the attempt aborts. */
export const SWITCH_STALL_TIMEOUT_MS = 60_000;
/** Poll interval for the stall watchdog. */
const STALL_CHECK_INTERVAL_MS = 5_000;

export type PrepareModelForSlotOptions = {
  slot: Slot;
  /** Catalog id of the model to prepare and bind. */
  modelId: string;
  /** Model currently bound to the slot — the rollback target. */
  previous: ModelConfig | null;
  /** External cancel (e.g. the dialog's Cancel button). */
  signal?: AbortSignal;
  onProgress?: (event: SwitchProgressEvent) => void;
  /** Override the stall window (tests). */
  stallTimeoutMs?: number;
  seams?: Partial<SwitchModelSeams>;
};

// ─── The primitive ──────────────────────────────────────────────────────────

/**
 * Prepare `modelId` for `slot`: download (verified) → load (watchdogged) →
 * smoke → bind ready. On failure the slot rolls back to `previous` and the
 * result carries honest copy inputs (reason, confidence, next suggestion).
 * Never throws — every path resolves to a SwitchModelResult.
 */
export async function prepareModelForSlot(
  options: PrepareModelForSlotOptions,
): Promise<SwitchModelResult> {
  const seams: SwitchModelSeams = { ...DEFAULT_SEAMS, ...options.seams };
  const { slot, previous } = options;
  const stallTimeoutMs = options.stallTimeoutMs ?? SWITCH_STALL_TIMEOUT_MS;

  const target = seams.getModel(options.modelId);
  if (!target) {
    return { success: false, reason: 'unknown', failedModel: null, suggestedNext: null };
  }

  const runtimeLease = seams.acquireLease('switch-model');
  if (!runtimeLease.ok) {
    return {
      success: false,
      reason: 'busy',
      failedModel: target,
      suggestedNext: null,
      busyMessage: seams.describeBusy(runtimeLease.active),
    };
  }

  const profile = seams.getDeviceProfile();
  const rollback = (): void => {
    if (previous) {
      seams.setSlot(slot, previous);
      // setSlot defaults a newly-bound slot to 'preparing'; the previous
      // model was already ready, so restore that explicitly.
      seams.setSlotStatus(slot, 'ready');
    } else {
      seams.setSlot(slot, null);
    }
  };
  const failure = (
    reason: Extract<SwitchFailureReason, 'load-failed' | 'smoke-failed'>,
  ): SwitchModelResult => ({
    success: false,
    reason,
    failedModel: target,
    suggestedNext: seams.nextInCascade(target, slot, profile, undefined, {
      excludeIds: [target.id],
    }),
    ...(previous ? { fallbackUsed: previous } : {}),
    failedConfidence: seams.deriveFailedConfidence(target.id, profile),
  });
  // A download that never completed is about the connection, not the device —
  // so it carries NO cascade suggestion (retrying the same model is the honest
  // next step) and NO confidence tag (this isn't a model-quality signal). The
  // caller renders "check your connection", never a hardware verdict.
  const networkFailure = (): SwitchModelResult => ({
    success: false,
    reason: 'network-failed',
    failedModel: target,
    suggestedNext: null,
    ...(previous ? { fallbackUsed: previous } : {}),
  });

  // Internal controller unifies the three abort sources: external cancel,
  // the stall watchdog, and (transitively) whatever the seams reject with.
  const internal = new AbortController();
  const onExternalAbort = (): void => {
    internal.abort();
  };
  // Read through a call so control-flow narrowing never assumes the signal
  // is still un-aborted after an await.
  const cancelled = (): boolean => internal.signal.aborted;
  if (options.signal) {
    if (options.signal.aborted) internal.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  // Stall watchdog: covers BOTH download and load — any progress event
  // (bytes or load fraction) resets the window. 60s of silence aborts.
  let lastProgressAt = Date.now();
  const touch = (): void => {
    lastProgressAt = Date.now();
  };
  const checkStall = (): void => {
    if (internal.signal.aborted) return;
    if (Date.now() - lastProgressAt >= stallTimeoutMs) {
      internal.abort();
      return;
    }
    stallTimer = setTimeout(checkStall, STALL_CHECK_INTERVAL_MS);
  };
  let stallTimer: ReturnType<typeof setTimeout> = setTimeout(checkStall, STALL_CHECK_INTERVAL_MS);

  try {
    seams.setSlot(slot, target);

    // ── Download (verified path: headroom preflight + chunked/SHA) ─────────
    const downloadLease = seams.acquireLease('download');
    if (!downloadLease.ok) {
      rollback();
      return {
        success: false,
        reason: 'busy',
        failedModel: target,
        suggestedNext: null,
        busyMessage: seams.describeBusy(downloadLease.active),
      };
    }
    options.onProgress?.({ kind: 'phase', phase: 'downloading' });
    try {
      await seams.download(target, {
        signal: internal.signal,
        onProgressEvent: (event) => {
          touch();
          if (event.kind === 'progress' && event.phase === 'downloading') {
            options.onProgress?.({ kind: 'download', fraction: event.percent });
          }
        },
      });
    } catch (err) {
      rollback();
      // A download-transport failure (dropped connection, HTTP/transport error,
      // SHA mismatch) is NOT a hardware verdict — classify it honestly so the
      // user is told to check their connection, not steered to a downgrade.
      // Genuine load/runtime incompatibility is caught below at the load step.
      if (err instanceof InsufficientStorageError) {
        return {
          success: false,
          reason: 'insufficient-storage',
          failedModel: target,
          suggestedNext: null,
          storageMessage: err.message,
          ...(previous ? { fallbackUsed: previous } : {}),
        };
      }
      if (err instanceof DownloadFailedError) {
        return networkFailure();
      }
      return failure('load-failed');
    } finally {
      downloadLease.release();
    }

    // A cancel that lands BETWEEN phases must not start the next phase —
    // an already-aborted signal fires no 'abort' event, so a seam that only
    // listens for the event would hang instead of unwinding.
    if (cancelled()) {
      rollback();
      return failure('load-failed');
    }

    // ── Load (runtime lifecycle, watchdogged) ───────────────────────────────
    // The resolved execution provider — a `webgpu` request can silently fall
    // back to `wasm`, and that's exactly what evidence + diagnostics need.
    let resolvedBackend: RuntimeBackend | null = null;
    try {
      const loadResult = await seams.load(target, {
        onLoadProgress: (fraction) => {
          touch();
          options.onProgress?.({ kind: 'load', fraction });
        },
        onLifecycleEvent: (event) => {
          touch();
          options.onProgress?.({ kind: 'phase', phase: event.phase });
        },
        signal: internal.signal,
      });
      resolvedBackend = loadResult.backend;
    } catch {
      // The exact row Cam's Gemma incident was missing: a runtime load that
      // fails after a clean download left ZERO durable evidence, so the
      // recommender kept re-offering it. Record it before rolling back.
      seams.recordEvidence({ modelId: target.id, profile, outcome: 'load-fail' });
      rollback();
      return failure('load-failed');
    }

    if (cancelled()) {
      rollback();
      return failure('load-failed');
    }

    // ── Smoke → bind ────────────────────────────────────────────────────────
    let result: SmokeResult;
    try {
      result = await seams.smoke(slot, target);
    } catch {
      rollback();
      return failure('load-failed');
    }
    if (!result.passed) {
      seams.recordEvidence({
        modelId: target.id,
        profile,
        outcome: 'smoke-fail',
        backend: resolvedBackend ?? undefined,
      });
      rollback();
      return failure('smoke-failed');
    }

    seams.recordEvidence({
      modelId: target.id,
      profile,
      outcome: 'smoke-pass',
      firstTokenMs: result.firstTokenMs,
      backend: resolvedBackend ?? undefined,
    });
    seams.setSlotStatus(slot, 'ready');
    return { success: true };
  } finally {
    clearTimeout(stallTimer);
    options.signal?.removeEventListener('abort', onExternalAbort);
    runtimeLease.release();
  }
}
