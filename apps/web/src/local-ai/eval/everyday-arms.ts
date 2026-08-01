// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use A/B arms — the switches worth measuring against the everyday
 * corpus, and the machinery that refuses to report a result without a control.
 *
 * THREE SWITCHES, all LOCAL and UNSHIPPED. Like the eco-tangent identity arms
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
 *   3. `posture` — the whole always-on elaboration posture, not one clause of
 *      it. Arm 1 conditions a single sentence while the next one still says an
 *      open ask "deserves a thorough, well-developed reply"; this arm replaces
 *      both with a direct-by-default posture built on the OPEN-vs-CLOSED axis.
 *      It is the removal arm arm 1 is not, and the two are mutually exclusive
 *      by table invariant — see `POSTURE_BASE_DIRECT`.
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

// ─── The posture base (arm 3) ───────────────────────────────────────────────

/**
 * `ON_DEVICE_PROMPT` as SHIPPED (lib/system-prompt.ts), VERBATIM.
 *
 * Held as a copy rather than imported for the same reason arm 1 holds its
 * clause: this module must never become a back door that couples an A/B into
 * the shipping prompt. The copy is safe because its drift guard is EXACT
 * equality — `getOnDeviceSystemPrompt()` must equal this string, so an edit to
 * the shipped prompt fails a unit test instead of silently turning the arm into
 * a no-op.
 */
export const POSTURE_BASE_SHIPPED =
  'You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user. Reply in a natural, conversational voice. Be genuinely helpful: address what was asked, then add the context, reasons, or practical details that make the reply useful on its own. Match depth to the question — a simple ask gets a brief reply; an open or substantial one deserves a thorough, well-developed reply. When the user gives explicit format or length instructions, follow them exactly. Use markdown lists or code blocks when they genuinely help.';

/**
 * ★ A/B TREATMENT TEXT — REVIEWED AND APPROVED BY CAM (2026-07-31), with one
 * tweak (see the REVIEW NOTE below). It is unshipped and unshippable by
 * construction (nothing on the dispatch path reads this module) — only a
 * winning value ships, as a deliberate one-line change made afterwards.
 *
 * ★ THE AXIS IS OPEN vs CLOSED, NOT SHORT vs LONG. "What is France like" is an
 * open ask — day-to-day life, the food, the culture all belong in a good reply.
 * "Who is the current president" is closed — it has one reply and that reply is
 * the whole job. A treatment that commanded brevity would measure a different
 * and much blunter thing, and would optimise the product into terseness; a unit
 * test forbids brevity vocabulary in this string for exactly that reason.
 *
 * WHAT CHANGED, LINE BY LINE (everything not listed is byte-identical):
 *
 *   KEPT  "You are Eco, a private AI — …conversations stay with the user."
 *         Identity is the eco-tangent A/B's variable, not this one. Touching it
 *         would confound two experiments.
 *   KEPT  "Reply in a natural, conversational voice." Register, not posture.
 *   SWAP  "…address what was asked, then add the context, reasons, or practical
 *         details that make the reply useful on its own."
 *      →  "…give what was asked for first."
 *         The shipped clause is the unconditional elaboration push: `then add`
 *         fires on every turn regardless of what was asked. The replacement
 *         keeps the deliver-first duty and drops the automatic addition. It
 *         deliberately avoids the words "lead with the answer": lib/system-
 *         prompt.ts records that the 1.2B default LITERALIZED that phrasing
 *         into replies opening with an H1 "Answer".
 *   SWAP  "Match depth to the question — a simple ask gets a brief reply; an
 *         open or substantial one deserves a thorough, well-developed reply."
 *      →  "Then let the question decide what follows — an open question —
 *         about how something is or works or feels, or what someone should
 *         do — is an invitation to say more, so give the detail, reasons, and
 *         practical specifics that make the reply worth having; a closed
 *         question has one definite reply, and giving it is the whole job."
 *         The shipped sentence sorts asks by SIZE ("a simple ask") and carries
 *         the second piece of elaboration language ("deserves a thorough,
 *         well-developed reply"). The replacement sorts them by OPENNESS and
 *         says what each one wants: the open side keeps — and names more
 *         concretely than the shipped prompt does — the substance an open ask
 *         invites, so this arm cannot be read as the terse arm; the closed side
 *         is stated positively ("giving it is the whole job") rather than as a
 *         prohibition, because lib/system-prompt.ts's design principles record
 *         that negative instructions backfire on sub-2B models. ★ REVIEW NOTE
 *         (Cam, approved with this tweak): the open side originally read only
 *         "about how something is or works or feels", which misses advice asks
 *         ("what should I do about X") that are just as open. Added.
 *   KEPT  "When the user gives explicit format or length instructions, follow
 *         them exactly." The user's own instruction still outranks the posture.
 *   KEPT  "Use markdown lists or code blocks when they genuinely help."
 */
export const POSTURE_BASE_DIRECT =
  'You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user. Reply in a natural, conversational voice. Be genuinely helpful: give what was asked for first. Then let the question decide what follows — an open question — about how something is or works or feels, or what someone should do — is an invitation to say more, so give the detail, reasons, and practical specifics that make the reply worth having; a closed question has one definite reply, and giving it is the whole job. When the user gives explicit format or length instructions, follow them exactly. Use markdown lists or code blocks when they genuinely help.';

// ─── The arm table ──────────────────────────────────────────────────────────

export type AddContextClauseSetting = 'as-shipped' | 'conditioned';
export type NgramBanSetting = 'as-shipped' | 'off';
export type PostureSetting = 'as-shipped' | 'direct';

export type EverydayArm = {
  id: EvalEverydayArmId;
  addContextClause: AddContextClauseSetting;
  ngramBan: NgramBanSetting;
  /**
   * Whole-base posture. `direct` replaces `POSTURE_BASE_SHIPPED` with
   * `POSTURE_BASE_DIRECT`, which already contains no add-context clause — so an
   * arm may never set this AND `addContextClause` together (the second swap
   * would silently find nothing to replace). A table invariant enforces it.
   */
  posture: PostureSetting;
  notes: string;
};

/** The cell every other cell is measured against. */
export const EVERYDAY_CONTROL_ARM_ID: EvalEverydayArmId = 'control';

/**
 * The 2×2 over the first two switches, plus the whole-base posture arm.
 * `control` is every switch as shipped and is never optional.
 */
export const EVERYDAY_ARMS: readonly EverydayArm[] = [
  {
    id: 'control',
    addContextClause: 'as-shipped',
    ngramBan: 'as-shipped',
    posture: 'as-shipped',
    notes: 'Control: exactly what ships today. Every claim about another arm is a delta against this one.',
  },
  {
    id: 'no-add-context',
    addContextClause: 'conditioned',
    ngramBan: 'as-shipped',
    posture: 'as-shipped',
    notes: 'Does conditioning the add-context clause reduce over-answering on closed asks WITHOUT thinning the open ones? Read depthMatch and answerDepth together — either alone is half the picture.',
  },
  {
    id: 'ngram-off',
    addContextClause: 'as-shipped',
    ngramBan: 'off',
    posture: 'as-shipped',
    notes: 'Does dropping the prompt-inclusive n-gram ban let the model give the user their own words and figures back? preservesUserText and preservesFacts are the readouts; noRepetition is the risk being watched.',
  },
  {
    id: 'no-add-context-ngram-off',
    addContextClause: 'conditioned',
    ngramBan: 'off',
    posture: 'as-shipped',
    notes: 'Both switches, to catch an interaction the single-switch arms would miss.',
  },
  {
    id: 'posture-direct',
    addContextClause: 'as-shipped',
    ngramBan: 'as-shipped',
    posture: 'direct',
    notes: 'The true REMOVAL arm: the always-on elaboration posture is gone, replaced by a direct-by-default one sorted on OPEN vs CLOSED. Read depthMatch (over-shoot on closed asks) and answerDepth (the thinning risk on open ones) TOGETHER — this arm is only a win if the closed side improves and the open side does not move down. Its treatment text is drafted and pending review; see POSTURE_BASE_DIRECT.',
  },
];

export function getEverydayArm(id: EvalEverydayArmId): EverydayArm {
  const arm = EVERYDAY_ARMS.find((a) => a.id === id);
  if (arm === undefined) throw new Error(`unknown everyday arm: ${id}`);
  return arm;
}

/**
 * Whether this arm's system prompt differs from the shipped one. The shared
 * predicate behind the topology guard, so the panel's launch refusal and
 * `compareEverydayArms`' reporting refusal can never disagree about which arms
 * a discarded system prompt would silently neuter.
 */
export function armRewritesSystemPrompt(arm: EverydayArm): boolean {
  return arm.addContextClause !== 'as-shipped' || arm.posture !== 'as-shipped';
}

/**
 * The message topology under which a system-prompt arm cannot act at all:
 * `composeGemmaNativeMessages` sends NO system role and folds a fixed contract
 * into the first user turn, so the arm's prompt is built and then thrown away.
 * Pinned by `harness-system-prompt-seam.test.ts`.
 */
export const SYSTEM_PROMPT_DISCARDING_TOPOLOGY = 'gemma-native-user-contract';

// ─── Appliers ───────────────────────────────────────────────────────────────

/**
 * Apply the arm's system-prompt switch.
 *
 * `posture: 'direct'` replaces the whole shipped base, keeping anything appended
 * after it (the model's catalog `systemDirective`) byte-identical. It THROWS
 * when the shipped base is not the prefix, rather than no-opping like the clause
 * swap: the clause swap is protected by a `contains` drift guard, but a
 * whole-base swap also fails when another local arm has already rewritten the
 * base — composing this with an eco-tangent identity arm is exactly that case,
 * and no unit test can see it because it only exists at run time. A loud crash
 * beats a run that reports a clean zero for a change it never made.
 *
 * `addContextClause: 'conditioned'` swaps the single clause. If the shipped
 * clause is not present (prompt drift) the prompt is returned unchanged — the
 * drift-guard unit test is the real catch there.
 *
 * Both are never set at once (table invariant, asserted in the unit tests).
 */
export function applyEverydayArmSystemPrompt(basePrompt: string, arm: EverydayArm): string {
  if (arm.posture === 'direct') {
    if (!basePrompt.startsWith(POSTURE_BASE_SHIPPED)) {
      throw new Error(
        `everyday arm "${arm.id}" cannot swap the posture: the composed prompt does not start with the shipped base. Either lib/system-prompt.ts drifted from POSTURE_BASE_SHIPPED, or another arm (e.g. the eco-tangent identity arm) already rewrote it.`,
      );
    }
    return POSTURE_BASE_DIRECT + basePrompt.slice(POSTURE_BASE_SHIPPED.length);
  }
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

  // ★ The same failure for the system-prompt arms: the gemma-native topology
  // sends no system message at all, so an arm that works by rewriting the base
  // prompt has its prompt built and discarded. Byte-identical to the control,
  // reported as "no effect". Both this and the panel's launch refusal read
  // `armRewritesSystemPrompt` off the arm table, so neither can drift into
  // permitting what the other forbids.
  for (const run of stamped) {
    const armId = armIdOf(run)!;
    if (!armRewritesSystemPrompt(getEverydayArm(armId))) continue;
    if (run.config?.messageTopology !== SYSTEM_PROMPT_DISCARDING_TOPOLOGY) continue;
    problems.push(
      `run ${run.runId} ("${run.label}") sets the ${armId} arm under the ${SYSTEM_PROMPT_DISCARDING_TOPOLOGY} topology, which sends no system prompt at all — the system-prompt switch cannot be measured here; re-run it on the production topology`,
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
