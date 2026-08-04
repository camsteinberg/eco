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
 * `expectsArtifact` — hand-authored for the two conversations whose PROBED TURN
 *               asks for a sendable message, by the same rule and the same type
 *               as the single-turn map. Read the probed turn, never the
 *               conversation's subject: the insurance conversation ends in a
 *               formal letter and its probed turn is a recall question.
 * `expectUserTextReuse` — never set. See the block below; this is a rule, not an
 *               accident, and it has a drift guard.
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
  artifactNote,
  artifactOf,
  ceilingWordsFor,
  classifyAskOpenness,
  richnessFloorFor,
  wantsBrevity,
  type ArtifactAskEntry,
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
 * the corpus: the dim reads one turn, and the requirement spans many. Closing it
 * needs a span measure that reads the history too — a rubric change, deliberately
 * not made here.
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

// ─── the artifact asks, on the conversation side ──────────────────────────

/**
 * ★ THE TWO CONVERSATIONS WHOSE PROBED TURN ASKS FOR A SENDABLE MESSAGE, and the
 * ones this dim was measured on. Hand-authored by the same rule as the
 * single-turn map in `everyday-probes.ts`: the ask names a message, email or
 * letter the person will send, and the reply's deliverable IS that
 * correspondence.
 *
 * ★ THE PROBED TURN IS WHAT COUNTS, NOT THE CONVERSATION. `convo-insurance-recall`
 * ends in a formal complaint letter and is deliberately absent: its probed turn
 * (index 10) is "remind me what the excess was", a recall question four turns
 * before the letter. Reading the conversation's SUBJECT instead of its probed ask
 * would gate the wrong turn and score a recall answer as a failed letter.
 *
 * Likewise absent: `convo-four-day-budget-list`, whose probed turn asks for a
 * printable list for the fridge — an artifact with no addressee, which this dim
 * cannot read (see the two stated limits in `rubric.ts`).
 */
export const EVERYDAY_CONVERSATION_ARTIFACT_ASKS: Readonly<Record<string, ArtifactAskEntry>> = {
  'convo-birthday-lunch-message': {
    kind: 'message',
    audience: 'the family group chat — fourteen relatives, several of them older',
    why: '"can you write the message i send to the family group chat". What they want: "The actual WhatsApp message, ready to paste into the family chat, carrying every decision they reached across the conversation."',
  },
  'convo-teacher-email-resend': {
    kind: 'email',
    audience: "her son's class teacher, with the front office copied per the policy",
    why: '"can u resend it … i need the actual days in there". Good answer: "The email again, recognisably the one she approved and about the same length, with Thursday and Friday where the vague phrase was."',
  },
};

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
  const artifact = EVERYDAY_CONVERSATION_ARTIFACT_ASKS[item.id];
  if (artifact !== undefined) {
    lines.push(artifactNote(artifact));
  }
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

function toProbe(item: MultiTurnEverydayItem): EvalPromptSpec {
  const view = probedTurnAsItem(item);
  const openness = classifyAskOpenness(view);
  const ceiling = ceilingWordsFor(view);
  const floor = richnessFloorFor(view, ceiling);

  return {
    id: conversationProbeId(item.id),
    category: 'everyday-conversation',
    intent: inferChatIntent(view.userInput, { hasPriorTurns: true }),
    prompt: view.userInput,
    history: toHistory(item),
    expectDeliverable: true,
    ...(EVERYDAY_CONVERSATION_ARTIFACT_ASKS[item.id] !== undefined
      ? { expectsArtifact: artifactOf(EVERYDAY_CONVERSATION_ARTIFACT_ASKS[item.id]!) }
      : {}),
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
