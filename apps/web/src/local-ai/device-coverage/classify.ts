// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Outcome classifier for the coverage audit. Drives each MatrixCell through the
 * REAL first-run flow — `executeSetup` (setup-runner.ts) — with injected seams
 * (profile, download/smoke result, cache miss) and a fake actions-recorder, then
 * classifies by which terminal action the shipped runner fires:
 *
 *   setReady      → served
 *   setBelowFloor → declined (below-floor / "coming to your device")
 *   setError      → declined (recoverable setup-error surface)
 *   nothing / throw → silent-broken (the class the guarantee must keep empty)
 *
 * Driving the real runner (not a hand-rolled trace) is deliberate: it captures
 * the runner's own routing — including the `NoAssignableModelError` catch at
 * setup-runner.ts:261 that converts "not below-floor yet nothing assignable"
 * into a below-floor decline. A lower-fidelity trace that stopped at the
 * selection layer would mislabel those cells silent-broken; end-to-end through
 * `executeSetup` reflects what the user actually gets. If that catch is ever
 * removed, this classifier reports the regression instead of hiding it.
 *
 * Honest limitation: the `ledger` dimension is not simulated (getSlot is a fresh
 * empty stub and recordEvidence is a no-op), so non-fresh ledger cells collapse
 * onto their fresh equivalent — recorded in the audit findings, not papered over.
 */

import type { Slot } from '../types';
import type { MatrixCell } from './device-matrix';
import type { AttemptResult } from '../lifecycle/setup-cascade';
import {
  executeSetup,
  type SetupRunnerActions,
  type SetupSeams,
} from '../lifecycle/setup-runner';
import type { SlotState } from '../lifecycle/slots';

export type CoverageOutcome =
  | { kind: 'served'; modelId: string; via: 'setup-ladder' }
  | { kind: 'declined'; surface: 'below-floor' | 'setup-error' }
  | { kind: 'silent-broken'; reason: string };

/** Injected attempt outcome for the setup ladder, derived from the cell. */
function injectedAttempt(cell: MatrixCell): SetupSeams['runAttempt'] {
  return (): Promise<AttemptResult> => {
    if (cell.download === 'storage-fail') {
      return Promise.resolve({
        ok: false,
        phase: 'download',
        reason: 'Not enough storage',
        reasonCode: 'insufficient-storage',
      });
    }
    if (cell.download === 'transient-fail') {
      return Promise.resolve({ ok: false, phase: 'download', reason: 'Network interrupted' });
    }
    if (cell.smoke === 'fail') {
      return Promise.resolve({ ok: false, phase: 'load-or-smoke', reason: 'Smoke test failed' });
    }
    return Promise.resolve({ ok: true });
  };
}

const noop = (): void => {
  /* intentional no-op: classification observes routing, not side effects */
};

export async function classifyCell(cell: MatrixCell): Promise<CoverageOutcome> {
  const slot: Slot = 'eco-fast';
  const emptySlot: SlotState = { slot, modelId: null, model: null, status: 'empty' };

  // Boxed so the terminal outcome is read at its declared type — a bare `let`
  // assigned only inside the action callbacks reads (to TS/eslint's flow
  // analysis) as never-reassigned, making the later null-check look "always
  // true". The box keeps the null-check honest.
  const result: { outcome: CoverageOutcome | null } = { outcome: null };
  const actions: SetupRunnerActions = {
    onProgressEvent: noop,
    setBelowFloor: () => {
      result.outcome = { kind: 'declined', surface: 'below-floor' };
    },
    setReady: (model) => {
      result.outcome = { kind: 'served', modelId: model.id, via: 'setup-ladder' };
    },
    setError: () => {
      result.outcome = { kind: 'declined', surface: 'setup-error' };
    },
    markPriorAttemptFailed: noop,
    markFindingFit: noop,
    markResuming: noop,
  };

  // Inject the side-effecting seams; leave the routing seams (recommend,
  // nextInCascade, starterModelForSlot, isBelowFloor) as their real defaults so
  // the classification reflects the shipped decision logic.
  const seams: Partial<SetupSeams> = {
    resolveProfile: () => Promise.resolve(cell.profile),
    getSlot: () => emptySlot,
    setSlot: noop,
    setSlotStatus: noop,
    recordEvidence: noop,
    runAttempt: injectedAttempt(cell),
    isModelCached: () => Promise.resolve(false),
  };

  try {
    await executeSetup(actions, { slot, skipBootstrap: true, starterFirst: true, seams });
  } catch (err) {
    return { kind: 'silent-broken', reason: `executeSetup threw: ${(err as Error).message}` };
  }
  return result.outcome ?? { kind: 'silent-broken', reason: 'no terminal action fired' };
}
