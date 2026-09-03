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
import type { EverydayUseItem } from '../../__tests__/fixtures/everyday-use-corpus';
import { pastedBlockOf } from './rubric';
import type { EvalHistoryTurn, EvalPromptSpec, ExpectedArtifact } from './types';

// ─── ask-shape derivation (moved here from everyday-probes.ts, R6) ─────────
//
// R6 deleted the single-turn everyday-use probe pool. These openness, ceiling
// and floor rules were shared by both sets and survive because this set still
// derives every probe from them; this module is now their only consumer, so
// they live here rather than in a module with nothing else in it.

// ─── small shared helpers ──────────────────────────────────────────────────

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Strip surrounding punctuation from a scanned word, lowercased. */
function bareWord(token: string): string {
  return token.toLowerCase().replace(/^[^\w£$%]+/, '').replace(/[^\w£$%]+$/, '');
}

// ─── openness: does this ask INVITE substance, or want the fact and stop? ───

/**
 * The real axis under the length question. A keyword cascade sorts turns by the
 * words in them; what actually decides how much an answer should say is whether
 * the person is curious or just needs a fact — and those two are not the same
 * variable. Pinning this split is the evidence for whether a cascade can see the
 * distinction at all.
 *
 *   `closed`    — the item wants brevity and its bounce never names thinness.
 *   `open`      — the item invites substance: no brevity bound, or a bounce that
 *                 names under-delivery outright.
 *   `two-sided` — both at once. These are the interesting ones and the dangerous
 *                 ones: a length-only optimiser damages them in whichever
 *                 direction it is pointed.
 *
 * ★ THE DEFAULT IS `open`. An item earns a brevity classification only by SAYING
 * so; silence is read as "this ask invites substance", never as licence to be
 * terse. That asymmetry is deliberate and is the whole guard against optimising
 * ourselves into terseness — get it backwards and the instrument quietly becomes
 * one-sided again.
 */
export type AskOpenness = 'open' | 'closed' | 'two-sided';

/**
 * Bounce phrasings that name OVER-delivery. Each is a quotation from the corpus,
 * generalised only as far as the wording of that one item required.
 */
export const BLOAT_BOUNCE_PATTERNS: readonly RegExp[] = [
  /\b\d{3,}[- ]word\b/i, // "500-word guide", "900-word tutorial"
  /\bessay\b/i,
  /\blecture\b/i,
  /\blesson\b/i, // "A grammar lesson about subjunctive mood"
  /\btutorial\b/i,
  /\bas long as\b/i, // "a summary as long as the thread"
  /\btriples the length\b/i,
  /\bboilerplate\b/i,
  /\bheadings?\b/i, // "three labelled options with headings"
  /\bheaded sections\b/i,
  /\btable\b/i, // "pros-and-cons table", "comparison table"
  /\bspreadsheet\b/i,
  /\ba list of\b/i, // "a list of every correction made instead of the clean text"
  /\bdefinition list\b/i,
  /\bnumbered list\b/i,
  /\bbulleted\b/i,
  /\bpamphlet\b/i,
  /\bevery single\b/i, // "biochemistry on every single marker"
  /\btwenty\b/i, // "twenty vague options instead of eight good ones"
  /\bfloods\b/i, // "floods them with eight questions"
  /\bpacks six\b/i,
  /\btwo paragraphs\b/i,
  /\bthree paragraphs\b/i,
  /\bparagraph of\b/i, // "a paragraph of reassurance", "a paragraph about how versatile"
  /\bmore work than writing it themselves\b/i,
];

/**
 * Bounce phrasings that name UNDER-delivery IN SUBSTANCE — the failure the
 * founder's worry is about, and the one a length-only instrument is blind to.
 *
 * ⚠ Two neighbouring failure classes are deliberately NOT here, because a word
 * floor is the wrong remedy for both and lumping them in produced measurably
 * wrong floors when this set was first drafted:
 *
 *   - WITHHELD (asks instead of answering, won't commit) — more words do not fix
 *     it; `deliversFirst` is the dim that sees it. See WITHHELD_BOUNCE_PATTERNS.
 *   - UNORIGINAL ("a generic funeral-poem template that could be about anyone")
 *     — a quality failure a judge owns. A generic poem is not a short one, and
 *     scoring it as one put an 80-word floor on "can you write a poem about my
 *     dog", whose good answer is a short warm poem.
 */
export const THIN_BOUNCE_PATTERNS: readonly RegExp[] = [
  // "refuses to translate", "refuses on academic-integrity grounds" — but NOT
  // "refusing to commit", which is non-commitment and lives in WITHHELD.
  /\brefus\w*\s+to\s+(?!commit\b)\w+/i,
  /\brefus\w*\s+on\s+[\w-]+\s+grounds\b/i,
  /\bwithout ever answering\b/i,
  /\bwhile explaining nothing\b/i,
  /\bno triage\b/i,
  /\bno phone script\b/i,
  /\bno working\b/i,
  /\bnever (?:gives?|states?|answers?|actually)\b/i,
  /\bwithout extracting anything\b/i,
  /\bwithout defining them\b/i,
  /\b(?:replies|answers|says) only\b/i,
  /\bleaves out\b/i,
  /\bmisses the\b/i,
  /\band nothing else\b/i, // "'I'm sorry you're going through this' and nothing else"
  /\bdoesn't actually say\b/i,
  /\bvague reassurance\b/i,
  /\babstract categories\b/i,
  /\bcategory list\b/i,
];


/**
 * Brevity bounds an item states in its GOOD ANSWER — the only thing that turns
 * the richness floor off. Beyond the numeric bounds R1/R2 already find, these
 * are the corpus's un-numbered ways of saying "and stop": "plainly", "Stays
 * short", "Short enough to read in ten seconds", "the one-sentence reason",
 * "restates it in four words".
 */
const BREVITY_PHRASE_RE =
  /\b(?:short|shorter|briefly|plainly|nothing more|ten seconds)\b|\bone-(?:line|sentence|word)\b|\bin (?:a few|two|three|four|five) words\b/i;

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

/** Whether the bounce names over-delivery. */
export function bounceNamesBloat(item: EverydayUseItem): boolean {
  return matchesAny(BLOAT_BOUNCE_PATTERNS, item.bounceCondition);
}

/** Whether the bounce names under-delivery in substance. */
export function bounceNamesThin(item: EverydayUseItem): boolean {
  return matchesAny(THIN_BOUNCE_PATTERNS, item.bounceCondition);
}


/**
 * Whether the item's good answer states a bound on how much to say — either a
 * number R1/R2 can read, or one of the corpus's plain-language equivalents.
 */
export function namesBrevityBound(item: EverydayUseItem): boolean {
  return ceilingWordsFor(item) !== null || BREVITY_PHRASE_RE.test(item.goodAnswerLooksLike);
}

/**
 * Does this ask invite substance? True unless the item states a brevity bound —
 * and true regardless if its bounce names thinness outright, because a stated
 * bound does not license answering with nothing in it ("Plainly points at the
 * two low ones" still bounces on "explaining nothing").
 */
export function wantsSubstance(item: EverydayUseItem): boolean {
  return bounceNamesThin(item) || !namesBrevityBound(item);
}

/** Does this ask want to be kept short? */
export function wantsBrevity(item: EverydayUseItem): boolean {
  return namesBrevityBound(item) || bounceNamesBloat(item);
}

/** Classify one item's ask on the open/closed axis. Never `unclassified`: the
 *  brevity-bound test partitions, so every item lands somewhere. */
export function classifyAskOpenness(item: EverydayUseItem): AskOpenness {
  const substance = wantsSubstance(item);
  const brevity = wantsBrevity(item);
  if (substance && brevity) return 'two-sided';
  return substance ? 'open' : 'closed';
}

// ─── R1: a length bound the item states outright ───────────────────────────

/**
 * Words per unit. Only units that describe THE WHOLE REPLY's length are listed.
 * "ideas", "options", "steps", "days" are deliberately absent: they count list
 * items, and a per-item count bounds nothing without knowing how long an item
 * is. ("Six to eight specific ideas … each one line" is a shape, not a length.)
 * "minutes" is absent for a sharper reason — the corpus uses it for boiling eggs
 * and for a eulogy, and a rule that cannot tell those apart is worse than no
 * rule.
 */
const UNIT_WORDS: Readonly<Record<string, number>> = {
  word: 1,
  sentence: 25,
  line: 15,
  paragraph: 70,
};

/**
 * Slack on a stated count before over-shoot is scored. The corpus's own bloat
 * bounces run 3-10x the good answer ("a 500-word guide" against "one or two
 * sentences"), so 2.5x leaves every good answer at a clean 1.0 and still catches
 * every failure the corpus names.
 */
const CEILING_SLACK = 2.5;

const COUNT = String.raw`\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve`;
const UNIT = String.raw`words?|sentences?|lines?|paragraphs?`;
/**
 * `<count>[ or/to/- <count>] [up to two adjectives] <unit>`. Whitespace between
 * count and unit is REQUIRED, which is what makes hyphenated compounds
 * ("one-line note", "two-sentence intro") fail to match: those are always a
 * component of the reply, never the reply.
 */
const COUNT_PHRASE_RE = new RegExp(
  String.raw`\b(${COUNT})(?:\s*(?:-|–|to|or)\s*(${COUNT}))?\s+(?:\w+\s+){0,2}?(${UNIT})\b`,
  'gi',
);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function parseCount(token: string): number | null {
  const lower = token.toLowerCase();
  if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower]!;
  const n = Number.parseInt(lower, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A count phrase preceded by one of these is describing a PART of the reply, or
 * a rate, not the reply: "each one line", "2-3 plain lines" after "and",
 * "restates it in four words", "explains in a sentence".
 */
const COMPONENT_BEFORE = new Set(['each', 'per', 'every', 'and', 'plus', 'in', 'within']);
/**
 * A count phrase followed by one of these governs a sub-topic, so again it
 * bounds a component: "One line ON the actual difference", "one sentence SAYING
 * where to type it", "one line POINTING out travel nearly doubled".
 */
const COMPONENT_AFTER = new Set([
  'on', 'for', 'about', 'of',
  'saying', 'pointing', 'explaining', 'noting', 'showing', 'describing', 'telling',
]);

/** The word immediately before `index` in `text`, bare and lowercased. */
function wordBefore(text: string, index: number): string {
  const head = text.slice(0, index).trimEnd();
  const match = /(\S+)$/.exec(head);
  return match ? bareWord(match[1]!) : '';
}

/** The word immediately after `index` in `text`, bare and lowercased. */
function wordAfter(text: string, index: number): string {
  const tail = text.slice(index).trimStart();
  const match = /^(\S+)/.exec(tail);
  return match ? bareWord(match[1]!) : '';
}

/**
 * The reply-length ceiling the item states in its own words, or null. Takes the
 * FIRST count phrase that survives the component guards above; a wrong ceiling
 * is far worse than no ceiling, so every guard fails toward null.
 */
export function statedCeilingWords(goodAnswerLooksLike: string): number | null {
  COUNT_PHRASE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COUNT_PHRASE_RE.exec(goodAnswerLooksLike)) !== null) {
    const [whole, lowRaw, highRaw, unitRaw] = match;
    if (COMPONENT_BEFORE.has(wordBefore(goodAnswerLooksLike, match.index))) continue;
    if (COMPONENT_AFTER.has(wordAfter(goodAnswerLooksLike, match.index + whole!.length))) continue;

    const low = parseCount(lowRaw!);
    const high = highRaw ? parseCount(highRaw) : low;
    if (low === null || high === null) continue;

    const unit = unitRaw!.toLowerCase().replace(/s$/, '');
    const perUnit = UNIT_WORDS[unit];
    if (perUnit === undefined) continue;

    return Math.ceil(Math.max(low, high) * perUnit * CEILING_SLACK);
  }
  return null;
}

// ─── R2: a length bound stated RELATIVE to the text the user pasted ────────

/**
 * "same length or shorter", "the corrected text and nothing else", "a tightened
 * version" — the item names no number, but it does name a bound: the reply must
 * not outgrow what the user pasted. Only meaningful when there IS a pasted
 * block, which is why `hasPastedContent` gates it.
 */
const BOUNDED_BY_INPUT_RE =
  /\bsame length or shorter\b|\bvisibly shorter\b|\band nothing else\b|\ba tightened version\b/i;

/** Headroom over the pasted text: a rewrite plus, at most, a line about it. */
const INPUT_BOUND_SLACK = 1.25;

function inputBoundedCeilingWords(item: EverydayUseItem): number | null {
  if (!item.hasPastedContent) return null;
  if (!BOUNDED_BY_INPUT_RE.test(item.goodAnswerLooksLike)) return null;
  return Math.ceil(wordCount(pastedBlockOf(item.userInput)) * INPUT_BOUND_SLACK);
}

/** The over-shoot ceiling for one item: R1 (an explicit count) beats R2. */
export function ceilingWordsFor(item: EverydayUseItem): number | null {
  return statedCeilingWords(item.goodAnswerLooksLike) ?? inputBoundedCeilingWords(item);
}

// ─── the under-shoot side: a richness floor for asks that invite substance ──

/**
 * A verdict plus two developed sentences — the smallest reply that can hold an
 * answer AND the reason or next step the corpus's thin bounces demand ("with no
 * triage", "no phone script", "while explaining nothing").
 *
 * CALIBRATED, not chosen: this started at 80 and was measured against every
 * item's own good answer. At 80 the floor failed answers the corpus calls good —
 * `rewrite-03` (a verdict, the offending phrase, and a softened two-sentence
 * email ≈ 55-70 words) and `draft-01` ("six or seven lines" ≈ 70-90). 60 clears
 * both and still scores a thin reply badly: the 1-3 sentence non-answers the
 * bounces describe run 15-40 words, i.e. 0.25-0.67 on a graduated floor.
 *
 * It is a FLOOR, not a target: `scoreAnswerDepth` saturates at 1.0 here, so
 * nothing in the instrument ever rewards writing past it.
 */
const RICHNESS_FLOOR_WORDS = 60;

/**
 * The floor when the item states a brevity bound that carries no number
 * ("Plainly points at the two low ones", "Short enough to read in ten seconds")
 * but whose bounce still names thinness. Asserting the full floor there
 * penalised good answers of ~40-50 words; asserting none would let "your privacy
 * is important to us" pass. This is the honest middle.
 */
const BREVITY_BOUNDED_FLOOR_WORDS = 40;

/**
 * Fraction of an item's own ceiling the floor may occupy. Without this a
 * two-sided item whose ceiling is tight ("Three simple lines", ceiling 113)
 * would carry the full floor and fail its own good answer — a check that fails a
 * good answer is a defect, however well-founded the constant behind it.
 */
const FLOOR_FRACTION_OF_CEILING = 0.4;

export function richnessFloorFor(item: EverydayUseItem, ceiling: number | null): number | null {
  if (!wantsSubstance(item)) return null;
  if (ceiling !== null) {
    return Math.min(RICHNESS_FLOOR_WORDS, Math.round(ceiling * FLOOR_FRACTION_OF_CEILING));
  }
  return BREVITY_PHRASE_RE.test(item.goodAnswerLooksLike)
    ? BREVITY_BOUNDED_FLOOR_WORDS
    : RICHNESS_FLOOR_WORDS;
}

// ─── the artifact ask annotation ───────────────────────────────────────────

/** An artifact annotation plus the corpus text the reading rests on. */
export type ArtifactAskEntry = ExpectedArtifact & { readonly why: string };

/**
 * The line an artifact ask adds to a probe's judge notes. This is where the
 * `audience` annotation does its work: the mechanical scorer can see that
 * SOMEBODY is addressed, but only a reader can see whether it is the right
 * somebody, so the reading is handed to them in the item's own terms. Exported so
 * both probe sets compose it identically.
 */
/** The spec-facing half of an annotation: the reading, without its provenance. */
export function artifactOf(entry: ArtifactAskEntry): ExpectedArtifact {
  return { kind: entry.kind, audience: entry.audience };
}

export function artifactNote(artifact: ArtifactAskEntry): string {
  return [
    `★ ARTIFACT: the deliverable is a ${artifact.kind} the person will send to ${artifact.audience}.`,
    `The reply has to BE that ${artifact.kind} — in their voice, addressed to that audience,`,
    'pasteable with at most trivial edits — not notes about it, not advice about it, and not',
    'a version addressed back to the person who asked.',
  ].join(' ');
}

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
