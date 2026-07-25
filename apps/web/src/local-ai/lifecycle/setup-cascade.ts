// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Setup cascade — the bounded fallback ladder for first-run model setup.
 *
 * The first-run path used to commit to one model and dead-end on failure.
 * This pure policy walks the ranked candidate list (via an injected
 * `nextInCascade`), recovering to the next compatible model on failure and
 * only reporting `exhausted` when the whole ladder is spent.
 *
 * Pure + fully injected so it is unit-testable without React, the download
 * pipeline, or real model loads. The hook wires the real seams.
 *
 * Traversal policy:
 *   - download failure  → retry the SAME model once (transient network), then
 *     demote. The cascade records nothing itself: `downloadModel` already wrote
 *     a `download-fail` row at the failure origin, and a second write here
 *     would double-count the same failure.
 *   - load/smoke failure → demote immediately (deterministic for this
 *     model×device), recorded to the ledger so it is excluded on retry and in
 *     future sessions.
 *   - success → recorded as a ledger pass (builds device-local confidence).
 */

import type { DeviceProfile, Intent, ModelConfig, Slot } from '../types';

export const SETUP_EXHAUSTED_REASON =
  "We tried a few options and couldn't get one running on this device just yet.";

/** Caps total attempts (including download retries) to bound bandwidth/time. */
export const SETUP_LADDER_MAX_STEPS = 4;

/** Marks a failure that is deterministic for this device, not a transient blip. */
export type AttemptFailureReasonCode = 'insufficient-storage';

export type AttemptResult =
  | { ok: true }
  | {
      ok: false;
      phase: 'download' | 'load-or-smoke';
      reason: string;
      reasonCode?: AttemptFailureReasonCode;
    };

export type SelectKind = 'initial' | 'retry' | 'demote';

export type SetupCascadeResult =
  | { kind: 'ready'; model: ModelConfig }
  | { kind: 'exhausted'; reason: string; triedModelIds: string[] };

export type RunSetupCascadeOptions = {
  slot: Slot;
  profile: DeviceProfile;
  recommend: (slot: Slot, profile: DeviceProfile) => ModelConfig;
  nextInCascade: (
    failed: ModelConfig,
    slot: Slot,
    profile: DeviceProfile,
    intent: Intent | undefined,
    opts: { excludeIds: string[] },
  ) => ModelConfig | null;
  /** Runs download + smoke for one model. Injected by the hook. */
  runAttempt: (model: ModelConfig) => Promise<AttemptResult>;
  /** Record a load/smoke failure to the evidence ledger. */
  recordFailure: (model: ModelConfig) => void;
  /** Record a smoke pass to the evidence ledger. */
  recordSuccess: (model: ModelConfig) => void;
  /** Fired before each attempt so the hook can setSlot + drive demotion copy. */
  onSelect?: (model: ModelConfig, info: { attemptIndex: number; kind: SelectKind }) => void;
  maxSteps?: number;
};

export async function runSetupCascade(opts: RunSetupCascadeOptions): Promise<SetupCascadeResult> {
  const maxSteps = opts.maxSteps ?? SETUP_LADDER_MAX_STEPS;
  const tried: string[] = [];
  let attemptIndex = 0;
  let model = opts.recommend(opts.slot, opts.profile);
  let kind: SelectKind = 'initial';
  let downloadRetriedFor: string | null = null;
  // The most recent failure — lets exhaustion surface an honest storage
  // message when the last thing that blocked us was a lack of space (retrying
  // or demoting to a smaller model may still have fit; only when nothing did
  // do we show it), instead of the generic "couldn't get one running".
  let lastFailure: { reason: string; reasonCode?: AttemptFailureReasonCode } | null = null;

  const exhausted = (): SetupCascadeResult => ({
    kind: 'exhausted',
    reason: lastFailure?.reasonCode === 'insufficient-storage'
      ? lastFailure.reason
      : SETUP_EXHAUSTED_REASON,
    triedModelIds: tried,
  });

  while (attemptIndex < maxSteps) {
    opts.onSelect?.(model, { attemptIndex, kind });
    const result = await opts.runAttempt(model);

    if (result.ok) {
      opts.recordSuccess(model);
      return { kind: 'ready', model };
    }

    lastFailure = { reason: result.reason, reasonCode: result.reasonCode };

    // Transient download failure → retry the same model once before demoting.
    // A storage shortage is deterministic (retrying can't free space), so skip
    // the retry and demote straight to a smaller model that might still fit.
    if (
      result.phase === 'download'
      && result.reasonCode !== 'insufficient-storage'
      && downloadRetriedFor !== model.id
    ) {
      downloadRetriedFor = model.id;
      attemptIndex++;
      kind = 'retry';
      continue;
    }

    // Deterministic model×device failure → record + demote. A download failure
    // that already exhausted its retry demotes too, but is not recorded HERE:
    // `downloadModel` wrote its row at the failure origin.
    if (result.phase === 'load-or-smoke') {
      opts.recordFailure(model);
    }
    tried.push(model.id);
    attemptIndex++;

    const next = opts.nextInCascade(model, opts.slot, opts.profile, undefined, { excludeIds: tried });
    if (!next) {
      return exhausted();
    }
    model = next;
    kind = 'demote';
  }

  return exhausted();
}
