// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Outcome classifier for the coverage audit. Drives each MatrixCell through the
 * REAL first-run decision path — `isBelowFloor`, then the real `runSetupCascade`
 * (with `recommend`/`nextInCascade` bound to this profile and an injected
 * `runAttempt` derived from the cell's download/smoke fields) — and maps the
 * terminal result to a coverage outcome.
 *
 * The guarantee under audit: every cell resolves to `served` or `declined`; the
 * `silent-broken` class must be empty (or exactly the tracked KNOWN_UNCOVERED
 * allowlist). `silent-broken` here means the selection path either threw an
 * unhandled error or reached "no assignable model" WITHOUT the below-floor gate
 * that is supposed to precede it — i.e. a cell the shipped UI has no designed
 * surface for.
 *
 * Honest limitation: the `ledger` dimension is not simulated here. The real
 * admission engine reads persisted evidence, which is empty in a unit context,
 * so every cell classifies as if the ledger were fresh. Non-fresh ledger cells
 * therefore collapse onto their fresh equivalent — recorded in the audit
 * findings, NOT papered over with a fabricated ledger effect.
 */

import type { ModelConfig, Slot } from '../types';
import type { MatrixCell } from './device-matrix';
import { isBelowFloor } from '../device/below-floor';
import { recommend, NoAssignableModelError } from '../selection/recommend';
import { nextInCascade } from '../selection/cascade';
import { runSetupCascade, type AttemptResult } from '../lifecycle/setup-cascade';

export type CoverageOutcome =
  | { kind: 'served'; modelId: string; via: 'setup-ladder' }
  | { kind: 'declined'; surface: 'below-floor' | 'diagnosis' }
  | { kind: 'silent-broken'; reason: string };

/** Injected attempt outcome for the setup ladder, derived from the cell. */
function injectedAttempt(cell: MatrixCell): (model: ModelConfig) => Promise<AttemptResult> {
  return () => {
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

export async function classifyCell(cell: MatrixCell): Promise<CoverageOutcome> {
  const { profile } = cell;
  const slot: Slot = 'eco-fast';

  // 1. Below-floor is the intended graceful decline for devices that run nothing.
  if (isBelowFloor(profile)) {
    return { kind: 'declined', surface: 'below-floor' };
  }

  // 2. Drive the REAL setup cascade with the injected download/smoke outcome.
  try {
    const result = await runSetupCascade({
      slot,
      profile,
      recommend: (s, p) => recommend(s, p),
      nextInCascade: (failed, s, p, intent, opts) => nextInCascade(failed, s, p, intent, opts),
      runAttempt: injectedAttempt(cell),
      recordFailure: () => {},
      recordSuccess: () => {},
    });
    if (result.kind === 'ready') {
      return { kind: 'served', modelId: result.model.id, via: 'setup-ladder' };
    }
    // exhausted → the app surfaces recovery + diagnosis (diagnoseUnsupportedProfile
    // always yields guidance): an honest decline, not a dead-end.
    return { kind: 'declined', surface: 'diagnosis' };
  } catch (err) {
    if (err instanceof NoAssignableModelError) {
      // Not below-floor, yet nothing assignable — the H1 seam. The pure layer
      // flags it; Layer-2 confirms whether the shipped setup-runner catches it.
      return { kind: 'silent-broken', reason: 'empty-not-belowfloor' };
    }
    return { kind: 'silent-broken', reason: `unhandled: ${(err as Error).message}` };
  }
}
