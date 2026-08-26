// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use A/B arms — the switches worth measuring against the everyday
 * corpus, and the machinery that refuses to report a result without a control.
 *
 * ONE REMAINING SWITCH, LOCAL and UNSHIPPED:
 *
 *   `ngramBan` — the 350M starter carried a BASE `noRepeatNgramSize`, and
 *      Transformers.js applies the ban across the full sequence INCLUDING the
 *      prompt, so the model is hard-banned from copying n consecutive prompt
 *      tokens. The profile comment says settling it "needs a measured A/B
 *      against a real loaded model, not a judgement call". This is that A/B; the
 *      dims that read it out are `preservesUserText` (does their WORDING come
 *      back, on the one proofread item) and `preservesFacts` (do their figures,
 *      dates and names come back UNCORRUPTED, on the eight items where the
 *      wording is supposed to change).
 *
 * RETIRED 2026-08-26 (the posture-direct treatment shipped as the production
 * prompt after a 3-sample known-answer A/B on the 1.2B, accuracy unchanged
 * 82.9% vs 82.0%, ~10% fewer tokens):
 *   - `addContextClause` / `no-add-context` / `no-add-context-ngram-off`
 *   - `posture` / `posture-direct` / `POSTURE_BASE_SHIPPED` / `POSTURE_BASE_DIRECT`
 *   - `ADD_CONTEXT_CLAUSE_SHIPPED` / `ADD_CONTEXT_CLAUSE_CONDITIONED`
 *
 * ★ A CONTROL ARM IS MANDATORY, and enforced rather than encouraged.
 * `compareEverydayArms` returns a problem instead of a comparison when no
 * control run is present. This project adopted a change on a ±50% band with no
 * control arm once and paid +43% TTFT for it; a helper that will happily diff
 * two treatments against each other is how that happens again.
 */

import { buildScorecard, diffScorecards } from './aggregate';
import type { GenerateOptions } from '../runtime/types';
import type { EvalEverydayArmId, EvalRun, ScorecardDiff } from './types';

// ─── The arm table ──────────────────────────────────────────────────────────

export type NgramBanSetting = 'as-shipped' | 'off';

export type EverydayArm = {
  id: EvalEverydayArmId;
  ngramBan: NgramBanSetting;
  notes: string;
};

/** The cell every other cell is measured against. */
export const EVERYDAY_CONTROL_ARM_ID: EvalEverydayArmId = 'control';

/**
 * The remaining arm table: `control` (shipped) and `ngram-off`.
 * `control` is every switch as shipped and is never optional.
 */
export const EVERYDAY_ARMS: readonly EverydayArm[] = [
  {
    id: 'control',
    ngramBan: 'as-shipped',
    notes: 'Control: exactly what ships today. Every claim about another arm is a delta against this one.',
  },
  {
    id: 'ngram-off',
    ngramBan: 'off',
    notes: 'Does dropping the prompt-inclusive n-gram ban let the model give the user their own words and figures back? preservesUserText and preservesFacts are the readouts; noRepetition is the risk being watched.',
  },
];

export function getEverydayArm(id: EvalEverydayArmId): EverydayArm {
  const arm = EVERYDAY_ARMS.find((a) => a.id === id);
  if (arm === undefined) throw new Error(`unknown everyday arm: ${id}`);
  return arm;
}

// ─── Appliers ───────────────────────────────────────────────────────────────

/**
 * Drop `noRepeatNgramSize` for the `off` arm, leaving every other sampling knob
 * exactly as the production profile built it — `repetitionPenalty` in particular
 * stays, because it is the loop guard that has to hold the line without the ban.
 */
export function applyEverydayArmOptions(
  options: GenerateOptions,
  arm: EverydayArm,
): GenerateOptions {
  if (arm.ngramBan === 'as-shipped') return options;
  const { noRepeatNgramSize: _dropped, ...rest } = options;
  return rest;
}

// ─── Comparison, with the control arm enforced ──────────────────────────────

/** One treatment arm's delta against the control run. */
export type EverydayArmDelta = {
  armId: EvalEverydayArmId;
  runId: string;
  label: string;
  diff: ScorecardDiff;
};

export type EverydayArmComparison = {
  /** Non-empty when the comparison could not be made honestly. `deltas` is then empty. */
  problems: string[];
  controlRunId: string | null;
  deltas: EverydayArmDelta[];
};

function armIdOf(run: EvalRun): EvalEverydayArmId | null {
  return run.config?.everydayArm ?? null;
}

/**
 * Diff every treatment arm against the control arm.
 *
 * Refuses — returning `problems` and no deltas — when there is no control run,
 * when more than one run claims to be the control, or when a run carries no arm
 * stamp at all. Refusing is the point: a treatment-vs-treatment delta reads like
 * evidence and is not.
 */
export function compareEverydayArms(runs: readonly EvalRun[]): EverydayArmComparison {
  const problems: string[] = [];

  const unstamped = runs.filter((r) => armIdOf(r) === null);
  for (const run of unstamped) {
    problems.push(`run ${run.runId} ("${run.label}") carries no everydayArm stamp — it cannot be placed in the A/B`);
  }

  const stamped = runs.filter((r) => armIdOf(r) !== null);

  // ★ Greedy decode collapses options to `{ temperature: 0, maxTokens }`, which
  // drops `noRepeatNgramSize` for EVERY arm — so an n-gram arm run greedily is
  // byte-identical to the control and would report "no effect" for a change it
  // never made. Refuse rather than publish that zero.
  for (const run of stamped) {
    const armId = armIdOf(run)!;
    if (getEverydayArm(armId).ngramBan !== 'off') continue;
    if (run.config?.samplingMode !== 'greedy') continue;
    problems.push(
      `run ${run.runId} ("${run.label}") sets the ${armId} arm under greedy decode, which already drops noRepeatNgramSize for every arm — the n-gram switch cannot be measured here; re-run it sampled`,
    );
  }

  const controls = stamped.filter((r) => armIdOf(r) === EVERYDAY_CONTROL_ARM_ID);
  if (controls.length === 0) {
    problems.push('no control-arm run present — a treatment arm can only be read as a delta against the control');
  } else if (controls.length > 1) {
    problems.push(`${controls.length} runs claim the control arm — the comparison has no single baseline`);
  }

  if (problems.length > 0) {
    return { problems, controlRunId: null, deltas: [] };
  }

  const control = controls[0]!;
  const controlScorecard = buildScorecard(control);
  const deltas = stamped
    .filter((run) => run.runId !== control.runId)
    .map((run) => ({
      armId: armIdOf(run)!,
      runId: run.runId,
      label: run.label,
      diff: diffScorecards(controlScorecard, buildScorecard(run)),
    }));

  return { problems: [], controlRunId: control.runId, deltas };
}
