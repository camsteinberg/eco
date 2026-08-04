// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday CONVERSATION probes — one generation probe per item of the
 * multi-turn everyday corpus, DERIVED at module load.
 *
 * WHY THIS EXISTS. `everyday-probes.ts` turned "what forty-nine real people
 * asked for" into something a model can be run against, and states its own
 * honest limitation: five of its items only make sense after an earlier
 * exchange, and the corpus does not contain that exchange, so they run as
 * opening turns. This module is the other side of that. Its corpus DOES contain
 * the exchange, so the history is replayed instead of apologised for, and the
 * failures that only exist across turns — a correction that has to stay made, a
 * figure pasted twelve turns ago, a topic picked back up — become measurable at
 * all.
 *
 * ★ DERIVED, NEVER COPIED, and derived by the SAME RULES. Every probe is
 * computed from `EVERYDAY_CONVERSATION_CORPUS` at module load, and every field
 * that has a rule in `everyday-probes.ts` is computed by importing that rule
 * rather than restating it. The bridge is `probedTurnAsItem`: a conversation
 * viewed as the single-turn item its probed ask would be if it stood alone. One
 * definition of openness, one ceiling rule, one floor rule, no second copy to
 * drift.
 *
 * ── HOW EACH FIELD IS DERIVED ───────────────────────────────────────────────
 *
 * `prompt`    — the PROBED turn's text, verbatim. Never re-typed, never tidied.
 * `history`   — every turn above it, verbatim, in order. The assistant turns are
 *               the corpus's, and they are a setting rather than a prediction:
 *               they exist so the user turns make sense in sequence.
 * `intent`    — `inferChatIntent` on the probed turn with `hasPriorTurns: true`,
 *               which is true here by construction. The probe therefore measures
 *               production routing rather than a snapshot of it.
 * `notes`     — the item's `bounceCondition` verbatim, because ★ the bounce
 *               condition is the acceptance criterion, plus the conversation
 *               facts a judge cannot see from the prompt alone: which turn is
 *               under test, how many turns sit above it, and whether the thing
 *               being recalled was pasted rather than typed.
 * `depthBand`, `minWords` — `ceilingWordsFor` / `richnessFloorFor`, unchanged.
 * `expectDeliverable` — true, as in the single-turn set.
 * `expectUserTextReuse` — never set. See the block below; this is a rule, not an
 *               accident, and it has a drift guard.
 * `historyFactSources`, `historyRuledOut` — the corpus's `carriesForward` /
 *               `ruledOut` quotes, copied through unchanged. The ONLY fields
 *               here that are authored rather than computed, because the window
 *               they describe cannot be derived from the history — see the block
 *               below, and `rubric.analyzeHistoryFactPreservation`. The corpus's
 *               third list, `mentionNotViolation`, is deliberately NOT copied
 *               through: those terms are on the record precisely because a token
 *               check flags the correct reply as readily as the wrong one.
 *
 * ── WHAT THIS SET DOES NOT MEASURE ──────────────────────────────────────────
 *
 * Only ONE turn per conversation is scored. The turns above it are context, not
 * results: nothing here says whether a model would have produced the scripted
 * assistant replies, and a run that scores well says nothing about the eight or
 * ten turns it was handed for free. Widening that means probing more than one
 * turn per conversation, which needs a per-turn `goodAnswerLooksLike` and a
 * per-turn bounce condition — corpus work, not derivation work.
 *
 * NOT in the harness's default prompt pool, for the same reason the everyday
 * probes are not: they ride `EvalRunConfig.extraPrompts`, so they never dilute
 * the standing scorecard and never reach the app bundle. Their own category
 * keeps them out of the single-turn average as well — a probe carrying eight
 * turns of history is not comparable with one that carries none.
 */

import {
  EVERYDAY_CONVERSATION_CORPUS,
  conversationNeedsFor,
  historyCarriesPastedContent,
  probedTurnAsItem,
  turnsBeforeProbe,
  type ConversationJob,
  type MultiTurnEverydayItem,
} from '../../__tests__/fixtures/everyday-conversation-corpus';
import { inferChatIntent } from '../../lib/chat-intent';
import {
  ceilingWordsFor,
  classifyAskOpenness,
  richnessFloorFor,
  wantsBrevity,
  type AskOpenness,
} from './everyday-probes';
import type { EvalHistoryTurn, EvalPromptSpec } from './types';

/** Probe id for a conversation. Namespaced so it can collide with nothing. */
export function conversationProbeId(itemId: string): string {
  return `everyday-convo-${itemId}`;
}

/**
 * ★ WHY `preservesUserText` IS OFF FOR THE WHOLE SET, and why that is a finding
 * rather than an omission.
 *
 * `scorePreservesUserText` measures the longest span of `spec.prompt` the reply
 * reproduced. In a conversation the words that have to survive are almost never
 * in the probed turn — they are in a paste eight turns up, or in a draft the
 * assistant wrote four turns up. Pointing a span measure at the probed turn
 * there would score noise, which is exactly the reasoning that already keeps it
 * off `work-followup-shorter` ("shorter. and take out the sorry") in the
 * single-turn set.
 *
 * So five of these conversations carry `faithful-reproduction` and NONE of them
 * can have it measured. That is a real gap in the instrument, not a property of
 * the corpus: the dim reads one turn, and the requirement spans many.
 *
 * ── HALF OF THAT GAP IS NOW CLOSED, AND HALF IS STILL OPEN ──────────────────
 *
 * `faithful-reproduction` covers two jobs, and the single-turn set already
 * splits them: the WORDING has to survive (`preservesUserText`, a span measure)
 * or the FACTS have to survive (`preservesFacts`, an entity measure). The FACT
 * half now has a conversation sibling — `preservesHistoryFacts`, fed by the
 * `carriesForward` spans in the corpus's layer 2 and gated below. It reads the
 * history, so a figure given twelve turns ago is measurable at last.
 *
 * ⚠ The SPAN half is still missing and this note is still the record of it. A
 * longest-common-span measure over the history would say something the fact
 * measure cannot: whether the resent email is RECOGNISABLY the one she approved,
 * as opposed to a fresh email that happens to contain Thursday and Friday. That
 * needs a scope rule for "which earlier text is the one being reproduced", and
 * the honest answer is that the same authored quote would serve — but a span
 * measure is not a survival count, and shipping it on the back of this one is
 * how a dim ends up measuring something other than its name. Deliberately not
 * made here.
 *
 * The list below is the drift guard. A conversation whose PROBED turn itself
 * carries a paste and needs `faithful-reproduction` would be a genuine
 * candidate; none exists today, and the test asserts the list is exactly what
 * this rule produces, so the first one to appear has to be classified rather
 * than silently joining or silently missing the gate.
 */
export const EVERYDAY_CONVERSATION_REUSE_CANDIDATE_ITEM_IDS: readonly string[] =
  EVERYDAY_CONVERSATION_CORPUS.filter((item) => {
    const view = probedTurnAsItem(item);
    return (
      view.hasPastedContent &&
      conversationNeedsFor(item.id).needs.includes('faithful-reproduction')
    );
  }).map((item) => item.id);

function toHistory(item: MultiTurnEverydayItem): EvalHistoryTurn[] {
  return turnsBeforeProbe(item).map((turn) => ({ role: turn.role, content: turn.text }));
}

function buildNotes(item: MultiTurnEverydayItem, openness: AskOpenness): string {
  const priorTurns = turnsBeforeProbe(item).length;
  const lines = [
    `ASK: ${openness}.`,
    `CONVERSATION: ${item.conversationJob}. This is turn ${String(priorTurns + 1)} of ${String(item.turns.length)}; ${String(priorTurns)} turns of real history precede it and are replayed in full.`,
    `WHAT THEY WANT: ${item.whatTheyActuallyWant}`,
    `GOOD ANSWER: ${item.goodAnswerLooksLike}`,
    `★ BOUNCE (the acceptance criterion — this response makes them give up): ${item.bounceCondition}`,
  ];
  if (historyCarriesPastedContent(item)) {
    lines.push(
      'NOTE: the facts this turn asks for were PASTED in an earlier turn, not typed in this one. Re-asking for them is the failure the bounce condition names.',
    );
  }
  lines.push(
    'NOTE: the assistant turns in the history are the corpus’s own, written so the user turns make sense in sequence. They are not a claim about what this model would say, and only the reply to the final turn is being judged.',
  );
  return lines.join('\n');
}

/**
 * The spans of history whose facts this reply has to carry, straight off layer 2.
 * Copied rather than re-derived for the same reason `probedTurnIndex` is: the
 * judgement belongs to the corpus, and there must be exactly one copy of it.
 */
function historyFactSourcesFor(item: MultiTurnEverydayItem): readonly string[] {
  return (conversationNeedsFor(item.id).carriesForward ?? []).map((span) => span.quote);
}

/**
 * The terms layer 2 says an earlier turn ruled out.
 *
 * ⚠ Reads `ruledOut` and NOT `mentionNotViolation`, which is the point of the
 * two lists being separate. A superseded value can be named by a correct reply
 * ("£790, up from £745 in October"), so gating it scores the right answer the
 * same as the wrong one; those terms stay on the record with the replies they
 * flagged, and never reach a probe.
 */
function historyRuledOutFor(item: MultiTurnEverydayItem): readonly string[] {
  return (conversationNeedsFor(item.id).ruledOut ?? []).map((entry) => entry.term);
}

function toProbe(item: MultiTurnEverydayItem): EvalPromptSpec {
  const view = probedTurnAsItem(item);
  const openness = classifyAskOpenness(view);
  const ceiling = ceilingWordsFor(view);
  const floor = richnessFloorFor(view, ceiling);
  const factSources = historyFactSourcesFor(item);
  const ruledOut = historyRuledOutFor(item);

  return {
    id: conversationProbeId(item.id),
    category: 'everyday-conversation',
    intent: inferChatIntent(view.userInput, { hasPriorTurns: true }),
    prompt: view.userInput,
    history: toHistory(item),
    expectDeliverable: true,
    ...(factSources.length > 0 ? { historyFactSources: factSources } : {}),
    ...(ruledOut.length > 0 ? { historyRuledOut: ruledOut } : {}),
    ...(ceiling !== null ? { depthBand: { maxWords: ceiling } } : {}),
    ...(floor !== null ? { minWords: floor } : {}),
    judge: ['taskFit', 'coherence'],
    notes: buildNotes(item, openness),
  };
}

/** One probe per conversation, in corpus order. Derived at module load. */
export const EVERYDAY_CONVERSATION_PROBES: readonly EvalPromptSpec[] =
  EVERYDAY_CONVERSATION_CORPUS.map(toProbe);

/** Probe id → the corpus item id it came from. */
export const EVERYDAY_CONVERSATION_PROBE_SOURCE_ITEM: Readonly<Record<string, string>> =
  Object.fromEntries(
    EVERYDAY_CONVERSATION_CORPUS.map((item) => [conversationProbeId(item.id), item.id]),
  );

/** The conversation probe ids, for scoping a report to the set. */
export const EVERYDAY_CONVERSATION_PROBE_IDS: ReadonlySet<string> = new Set(
  EVERYDAY_CONVERSATION_PROBES.map((p) => p.id),
);

/** Corpus item id → its derived openness, by the single-turn rule. The pinned split. */
export const EVERYDAY_CONVERSATION_ASK_OPENNESS: Readonly<Record<string, AskOpenness>> =
  Object.fromEntries(
    EVERYDAY_CONVERSATION_CORPUS.map((item) => [
      item.id,
      classifyAskOpenness(probedTurnAsItem(item)),
    ]),
  );

/** Conversation ids with a given openness, in corpus order. */
export function conversationIdsWithOpenness(openness: AskOpenness): readonly string[] {
  return EVERYDAY_CONVERSATION_CORPUS.filter(
    (item) => classifyAskOpenness(probedTurnAsItem(item)) === openness,
  ).map((item) => item.id);
}

/** Probe ids for one conversation shape, so a run can scope to it. */
export function conversationProbeIdsWithJob(job: ConversationJob): readonly string[] {
  return EVERYDAY_CONVERSATION_CORPUS.filter((item) => item.conversationJob === job).map((item) =>
    conversationProbeId(item.id),
  );
}

/**
 * ★ A STATED GAP, carried over from the single-turn set because it behaves the
 * same way here. These conversations want brevity — their bounce names
 * over-delivery, or their good answer says so — but put no NUMBER on it, so no
 * ceiling could be derived and `depthMatch` measures nothing on their over-shoot
 * side. Pinned as a list so the gap stays visible instead of being rounded off
 * with an invented default.
 */
export const EVERYDAY_CONVERSATION_UNMEASURED_CEILING_ITEM_IDS: readonly string[] =
  EVERYDAY_CONVERSATION_CORPUS.filter((item) => {
    const view = probedTurnAsItem(item);
    return wantsBrevity(view) && ceilingWordsFor(view) === null;
  }).map((item) => item.id);
