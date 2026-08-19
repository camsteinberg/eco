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

/**
 * A structured cause the error surface can act on, when the failure origin knew
 * one. This is the ONLY channel that survives exhaustion: once the ladder is
 * spent the cascade replaces the last failure's raw text with its own copy (raw
 * internal strings are not error copy), so a code is the only way a real cause
 * reaches the user's screen.
 *
 *   - 'insufficient-storage' — deterministic for this device; retrying cannot
 *     free space, so the ladder demotes immediately instead of retrying.
 *   - 'network-or-host' — the host or the connection, not this device. Naming
 *     the device for a hosting failure is the dishonesty this code prevents.
 *
 * Deliberately partial: a cache/OPFS write error arrives as a plain `Error` and
 * gets NO code, because it cannot be told apart from any other unexpected throw.
 * Guessing there would be the same dishonesty in the other direction.
 */
export type AttemptFailureReasonCode = 'insufficient-storage' | 'network-or-host';

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
  | {
      kind: 'exhausted';
      reason: string;
      /** The last failure's structured cause, when it had one. Undefined means
       *  we genuinely do not know — the surface must not invent a cause. */
      reasonCode?: AttemptFailureReasonCode;
      triedModelIds: string[];
    };

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
    // The storage reason is already plain language WITH the numbers, so it is
    // the one failure text worth showing verbatim. Everything else is an
    // internal string and gets replaced by written copy — the `reasonCode`
    // below is how the real cause still reaches the error surface.
    reason: lastFailure?.reasonCode === 'insufficient-storage'
      ? lastFailure.reason
      : SETUP_EXHAUSTED_REASON,
    reasonCode: lastFailure?.reasonCode,
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
