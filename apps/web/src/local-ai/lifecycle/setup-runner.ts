// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Setup runner — the outer first-run flow, pure of React.
 *
 * bootstrap → adapter-probed profile → below-floor → resume → cascade ladder
 * → ready / honest-exhausted error. All side effects go through injected seams
 * (default to the real implementations) so the flow is unit-testable with
 * plain fakes. `useLocalAiSetup` is a thin wrapper that calls this.
 */

import type { DeviceProfile, ModelConfig, Slot } from '../types';
import type { ProgressEvent } from '../download/progress';
import { ProgressTracker } from '../download/progress';
import { bootstrapLocalAi } from '../bootstrap';
import { downloadModel, InsufficientStorageError, isModelFullyCached } from '../download/download';
import { runSmoke } from './smoke';
import { setSlot, setSlotStatus, getSlot, type SlotState, type SlotStatus } from './slots';
import { isBelowFloor } from '../device/below-floor';
import { recommend } from '../index';
import { nextInCascade } from '../selection/cascade';
import { NoAssignableModelError, starterModelForSlot } from '../selection/recommend';
import { recordEvidence } from '../evidence/ledger';
import { resolveSetupProfile } from '../device/profile';
import { runSetupCascade, type AttemptResult } from './setup-cascade';
import { logSetupAttemptFailure } from './setup-diagnostics';

/** Subset of EcoSetupActions the runner drives (structural — no React import). */
export type SetupRunnerActions = {
  onProgressEvent(event: ProgressEvent): void;
  setBelowFloor(reason: string): void;
  setReady(model: ModelConfig): void;
  setError(reason: string, opts?: { exhausted?: boolean }): void;
  markPriorAttemptFailed(): void;
  markFindingFit(): void;
};

export type SetupSeams = {
  bootstrap: () => Promise<void>;
  resolveProfile: () => Promise<DeviceProfile>;
  isBelowFloor: (profile: DeviceProfile) => boolean;
  getSlot: (slot: Slot) => SlotState;
  setSlot: (slot: Slot, model: ModelConfig) => void;
  setSlotStatus: (slot: Slot, status: SlotStatus) => void;
  recommend: (slot: Slot, profile: DeviceProfile) => ModelConfig;
  nextInCascade: typeof nextInCascade;
  recordEvidence: typeof recordEvidence;
  runAttempt: (slot: Slot, model: ModelConfig, onProgressEvent: (e: ProgressEvent) => void) => Promise<AttemptResult>;
  /** Stage A starter pick — smallest offerable model for the slot (null = none). */
  starterModelForSlot: (slot: Slot, profile: DeviceProfile) => ModelConfig | null;
  /** True when every file of the model's plan verifies in storage. */
  isModelCached: (model: ModelConfig) => Promise<boolean>;
};

export type SetupRunnerOptions = {
  slot?: Slot;
  skipBootstrap?: boolean;
  /**
   * Stage A starter-first pipeline (instant-start slice 2b). Default on;
   * `false` restores the class-best-first pipeline — the rollback lever.
   * Overridable per-session via `?eco-starter-first=off|on` for field
   * triage and real-browser journeys.
   */
  starterFirst?: boolean;
  seams?: Partial<SetupSeams>;
};

/** Flip to false to roll back Stage A globally (instant-start slice 2b). */
export const STARTER_FIRST_SETUP_DEFAULT = true;

const URL_PARAM_STARTER_FIRST = 'eco-starter-first';

function readStarterFirstOverride(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = new URLSearchParams(window.location.search).get(URL_PARAM_STARTER_FIRST);
    if (value === 'off' || value === '0') return false;
    // '' = bare `?eco-starter-first` (URLSearchParams returns '' for a
    // valueless param) — treat presence as "on", mirroring ?eco-force-wasm.
    if (value === 'on' || value === '1' || value === '') return true;
    return null;
  } catch {
    return null;
  }
}

function resolveStarterFirst(options: SetupRunnerOptions): boolean {
  return options.starterFirst ?? readStarterFirstOverride() ?? STARTER_FIRST_SETUP_DEFAULT;
}

/**
 * Stage A first pick. The class-best recommendation stays the anchor (and
 * still throws NoAssignableModelError for the below-floor routing above);
 * starter-first only changes which rung the ladder STARTS on:
 *
 *   - class-best fully cached → class-best (returning-user fast path — a
 *     user who already holds the good model is never downgraded)
 *   - otherwise → the starter (smallest offerable), converging to the
 *     class-best trivially when they are the same model
 *
 * The cascade ladder after the first pick is unchanged: a starter failure
 * demotes into the natural ranking via nextInCascade.
 */
async function chooseFirstPick(
  slot: Slot,
  profile: DeviceProfile,
  seams: SetupSeams,
  starterFirst: boolean,
): Promise<ModelConfig> {
  const classBest = seams.recommend(slot, profile);
  if (!starterFirst) return classBest;
  // A probe error reads as "not cached" — failing toward the starter keeps
  // first-run fast, and the download's own verify-skip pass makes a false
  // negative cost only the probe.
  const cached = await seams.isModelCached(classBest).catch(() => false);
  if (cached) return classBest;
  return seams.starterModelForSlot(slot, profile) ?? classBest;
}

/** Default real attempt: download → smoke, wired to the progress tracker. */
async function defaultRunAttempt(
  slot: Slot,
  model: ModelConfig,
  onProgressEvent: (e: ProgressEvent) => void,
): Promise<AttemptResult> {
  const tracker = new ProgressTracker();
  const unsubscribe = tracker.subscribe(onProgressEvent);
  try {
    try {
      await downloadModel(model, { tracker });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Download failed.';
      logSetupAttemptFailure({ modelId: model.id, runtime: model.runtime, phase: 'download', reason, error: err });
      tracker.error(reason);
      return err instanceof InsufficientStorageError
        ? { ok: false, phase: 'download', reason, reasonCode: 'insufficient-storage' }
        : { ok: false, phase: 'download', reason };
    }
    tracker.startSmoke();
    let result;
    try {
      result = await runSmoke(slot, model);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Smoke check failed.';
      logSetupAttemptFailure({ modelId: model.id, runtime: model.runtime, phase: 'load-or-smoke', reason, error: err });
      tracker.error(reason);
      return { ok: false, phase: 'load-or-smoke', reason };
    }
    if (result.passed) {
      tracker.complete();
      return { ok: true };
    }
    logSetupAttemptFailure({ modelId: model.id, runtime: model.runtime, phase: 'load-or-smoke', reason: result.reason });
    tracker.error(result.reason);
    return { ok: false, phase: 'load-or-smoke', reason: result.reason };
  } finally {
    unsubscribe();
  }
}

export const DEFAULT_SEAMS: SetupSeams = {
  bootstrap: bootstrapLocalAi,
  resolveProfile: resolveSetupProfile,
  isBelowFloor,
  getSlot,
  setSlot,
  setSlotStatus,
  recommend,
  nextInCascade,
  recordEvidence,
  runAttempt: defaultRunAttempt,
  starterModelForSlot: (slot, profile) => starterModelForSlot(slot, profile),
  isModelCached: (model) => isModelFullyCached(model),
};

export async function executeSetup(
  actions: SetupRunnerActions,
  options: SetupRunnerOptions = {},
): Promise<void> {
  const slot: Slot = options.slot ?? 'eco-fast';
  const seams: SetupSeams = { ...DEFAULT_SEAMS, ...options.seams };

  if (!options.skipBootstrap) {
    try {
      await seams.bootstrap();
    } catch (err) {
      actions.setError(err instanceof Error ? err.message : String(err));
      return;
    }
  }

  let profile: DeviceProfile;
  try {
    profile = await seams.resolveProfile();
  } catch (err) {
    actions.setError(err instanceof Error ? err.message : 'Could not read this device.');
    return;
  }

  if (seams.isBelowFloor(profile)) {
    actions.setBelowFloor('genuine-below-floor');
    return;
  }

  const current = seams.getSlot(slot);
  if (current.modelId && current.status === 'ready' && current.model) {
    actions.setReady(current.model);
    return;
  }
  if (current.modelId && current.status === 'error') {
    actions.markPriorAttemptFailed();
  }

  let result;
  try {
    // Stage A: resolve the ladder's first rung up front (starter unless the
    // class-best is already fully cached). The cascade's recommend seam then
    // returns that precomputed pick — cache probing is async and the cascade's
    // recommend contract is sync, so the choice has to happen out here.
    const firstPick = await chooseFirstPick(slot, profile, seams, resolveStarterFirst(options));
    result = await runSetupCascade({
      slot,
      profile,
      recommend: () => firstPick,
      nextInCascade: seams.nextInCascade,
      runAttempt: (model) => seams.runAttempt(slot, model, actions.onProgressEvent),
      recordFailure: (model) => seams.recordEvidence({ modelId: model.id, profile, outcome: 'smoke-fail' }),
      recordSuccess: (model) => seams.recordEvidence({ modelId: model.id, profile, outcome: 'smoke-pass' }),
      onSelect: (model, info) => {
        seams.setSlot(slot, model);
        if (info.kind === 'demote') actions.markFindingFit();
      },
    });
  } catch (err) {
    // No model can run on this device at all — recommend() throws
    // NoAssignableModelError (e.g. WebGPU adapter unavailable AND no viable
    // WASM tier). isBelowFloor only catches the low-memory subset, so route
    // the rest to the honest "coming to your device" surface instead of a
    // retry-promising error the user can never get past.
    if (err instanceof NoAssignableModelError) {
      actions.setBelowFloor('no-assignable-model');
      return;
    }
    seams.setSlotStatus(slot, 'error');
    actions.setError(err instanceof Error ? err.message : 'Could not pick a model.');
    return;
  }

  if (result.kind === 'ready') {
    seams.setSlotStatus(slot, 'ready');
    actions.setReady(result.model);
  } else {
    seams.setSlotStatus(slot, 'error');
    actions.setError(result.reason, { exhausted: true });
  }
}
