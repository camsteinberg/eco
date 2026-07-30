// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use A/B arms — the two switches worth measuring against the everyday
 * corpus, and the machinery that refuses to report a result without a control.
 *
 * TWO SWITCHES, both LOCAL and UNSHIPPED. Like the eco-tangent identity arms
 * this module mirrors, nothing here ever lands in prod code: only a winning
 * value ships, as a deliberate one-line change made afterwards.
 *
 *   1. `addContextClause` — the shipped system prompt tells the model to "add
 *      the context, reasons, or practical details that make the reply useful on
 *      its own", unconditionally, on every turn. The counterfactual makes it
 *      conditional. This is the direct-by-default question in its exact form:
 *      the clause is what a closed ask does not want and an open one does.
 *   2. `ngramBan` — the 350M starter carries a BASE `noRepeatNgramSize`, and
 *      Transformers.js applies the ban across the full sequence INCLUDING the
 *      prompt, so the model is hard-banned from copying n consecutive prompt
 *      tokens. The profile comment says settling it "needs a measured A/B
 *      against a real loaded model, not a judgement call". This is that A/B; the
 *      dims that read it out are `preservesUserText` (does their WORDING come
 *      back, on the one proofread item) and `preservesFacts` (do their figures,
 *      dates and names come back UNCORRUPTED, on the eight items where the
 *      wording is supposed to change).
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

// ─── The add-context clause (arm 1) ─────────────────────────────────────────

/**
 * The clause as SHIPPED, verbatim from `ON_DEVICE_PROMPT` (lib/system-prompt.ts).
 * It must stay byte-identical or `applyEverydayArmSystemPrompt` silently no-ops;
 * the drift guard is a unit test asserting `getOnDeviceSystemPrompt()` still
 * contains this string. We deliberately do NOT import the prod constant — this
 * module must never become a back door that couples an A/B into the shipping
 * prompt.
 */
export const ADD_CONTEXT_CLAUSE_SHIPPED =
  'Be genuinely helpful: address what was asked, then add the context, reasons, or practical details that make the reply useful on its own.';

/**
 * The counterfactual: the same clause, conditioned on the ask inviting it. NOT a
 * "be brief" instruction — that would test a different and much blunter thing,
 * and the whole risk being managed here is optimising into terseness.
 */
export const ADD_CONTEXT_CLAUSE_CONDITIONED =
  'Be genuinely helpful: address what was asked, and when the ask invites it, add the context, reasons, or practical details that make the reply useful on its own.';

// ─── The arm table ──────────────────────────────────────────────────────────

export type AddContextClauseSetting = 'as-shipped' | 'conditioned';
export type NgramBanSetting = 'as-shipped' | 'off';

export type EverydayArm = {
  id: EvalEverydayArmId;
  addContextClause: AddContextClauseSetting;
  ngramBan: NgramBanSetting;
  notes: string;
};

/** The cell every other cell is measured against. */
export const EVERYDAY_CONTROL_ARM_ID: EvalEverydayArmId = 'control';

/** The 2×2. `control` is both switches as shipped and is never optional. */
export const EVERYDAY_ARMS: readonly EverydayArm[] = [
  {
    id: 'control',
    addContextClause: 'as-shipped',
    ngramBan: 'as-shipped',
    notes: 'Control: exactly what ships today. Every claim about another arm is a delta against this one.',
  },
  {
    id: 'no-add-context',
    addContextClause: 'conditioned',
    ngramBan: 'as-shipped',
    notes: 'Does conditioning the add-context clause reduce over-answering on closed asks WITHOUT thinning the open ones? Read depthMatch and answerDepth together — either alone is half the picture.',
  },
  {
    id: 'ngram-off',
    addContextClause: 'as-shipped',
    ngramBan: 'off',
    notes: 'Does dropping the prompt-inclusive n-gram ban let the model give the user their own words and figures back? preservesUserText and preservesFacts are the readouts; noRepetition is the risk being watched.',
  },
  {
    id: 'no-add-context-ngram-off',
    addContextClause: 'conditioned',
    ngramBan: 'off',
    notes: 'Both switches, to catch an interaction the single-switch arms would miss.',
  },
];

export function getEverydayArm(id: EvalEverydayArmId): EverydayArm {
  const arm = EVERYDAY_ARMS.find((a) => a.id === id);
  if (arm === undefined) throw new Error(`unknown everyday arm: ${id}`);
  return arm;
}

// ─── Appliers ───────────────────────────────────────────────────────────────

/**
 * Swap the add-context clause for the arm's variant. `as-shipped` returns the
 * prompt unchanged. If the shipped clause is not present (prompt drift) the
 * prompt is returned unchanged — the drift-guard unit test is the real catch, so
 * a silent no-op here can never ship a wrong sentence.
 */
export function applyEverydayArmSystemPrompt(basePrompt: string, arm: EverydayArm): string {
  if (arm.addContextClause === 'as-shipped') return basePrompt;
  return basePrompt.replace(ADD_CONTEXT_CLAUSE_SHIPPED, ADD_CONTEXT_CLAUSE_CONDITIONED);
}

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
