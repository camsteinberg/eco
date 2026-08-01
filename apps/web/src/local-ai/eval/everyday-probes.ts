// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use probes — one generation probe per item of the blind-authored
 * everyday-use corpus, DERIVED at module load.
 *
 * WHY THIS EXISTS. Three sessions of chat-quality work ranked and prioritised
 * changes without ever generating a token: every claim was about the strings we
 * hand the model, none about the answers it produces. This module is the other
 * half — it turns "what forty real people asked for" into something the eval
 * harness can actually run a model against.
 *
 * ★ DERIVED, NEVER COPIED. Every probe is computed from `EVERYDAY_USE_CORPUS`
 * at module load. A copy drifts the moment someone edits one side; a derivation
 * cannot. `everyday-probes.test.ts` asserts 40/40 coverage, so a corpus addition
 * fails loudly rather than sitting silently unmeasured.
 *
 * ── THE INSTRUMENT IS TWO-SIDED, AND THAT IS ITS MOST IMPORTANT PROPERTY ─────
 *
 * An instrument that only sees over-length optimises whatever it measures into
 * terseness, and terseness loses the thing that makes an assistant worth
 * keeping: "'what is France like' is a simple question, but the user is curious
 * about day-to-day life, the food, the culture — a longer, more insightful
 * response is better here; 'who is the current president' wants nothing of the
 * sort." So each probe can carry BOTH directions, on two different dims that
 * already exist — this module builds no parallel machinery:
 *
 *   - the OVER-shoot side rides `depthBand.maxWords` → `depthMatch`, the band
 *     whose own rubric comment names "a lecture on a simple ask";
 *   - the UNDER-shoot side rides `minWords` → `answerDepth`, the graduated
 *     richness floor whose own rubric comment names "the terse failure mode
 *     ('super short and not helpful')".
 *
 * They are deliberately kept on separate dims rather than folded into one band,
 * so a composite can never hide one direction behind the other, and so neither
 * is double-counted.
 *
 * ── HOW EACH FIELD IS DERIVED (all rules stated, all mechanical) ─────────────
 *
 * `prompt`   — `userInput`, verbatim. Never re-typed, never tidied.
 * `intent`   — whatever `inferChatIntent` returns for that input TODAY, with
 *              the corpus's own `priorTurns` reading passed through. The probe
 *              therefore always measures production routing rather than a
 *              snapshot of it; a routing change changes what the model is asked,
 *              which is correct for an instrument that measures what ships.
 * `notes`    — carries the item's `bounceCondition` verbatim to the judge,
 *              because ★ the bounce condition is the acceptance criterion.
 * `depthBand`, `minWords`, `expectDeliverable`, `expectUserTextReuse`,
 * `expectFactPreservation` — see the rule blocks below, each of which quotes the
 *              corpus text it reads.
 *
 * ── ONE HONEST LIMITATION ───────────────────────────────────────────────────
 *
 * Five items are anaphoric ("no i meant the second one", "shorter."): they only
 * make sense after an earlier exchange, and the corpus does not contain that
 * exchange. Inventing one would be authoring corpus content — precisely what the
 * corpus's own header warns against. So they run as opening turns and their
 * generations should be read as such. `EVERYDAY_ANAPHORIC_PROBE_IDS` names them
 * so a run can exclude them; their `notes` say so too.
 *
 * NOT in the harness's default prompt pool. These are fed through
 * `EvalRunConfig.extraPrompts`, so they never dilute the standing scorecard and
 * never reach the app bundle.
 */

import { inferChatIntent } from '../../lib/chat-intent';
import {
  EVERYDAY_USE_CORPUS,
  hasPriorTurns,
  needsFor,
  type EverydayUseItem,
} from '../../__tests__/fixtures/everyday-use-corpus';
import { pastedBlockOf } from './rubric';
import type { EvalPromptSpec } from './types';

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
 * Bounce phrasings that name a WITHHELD deliverable — the reply interrogates, or
 * refuses to pick, instead of answering. Recorded because it is a third distinct
 * direction in the corpus, and pinned as evidence; it feeds `deliversFirst`, and
 * deliberately feeds NEITHER the ceiling nor the floor.
 */
export const WITHHELD_BOUNCE_PATTERNS: readonly RegExp[] = [
  /\bbefore (?:writing|helping|anything)\b/i,
  /\bdemands details\b/i,
  /\bclarifying questions\b/i,
  /\bcould you clarify\b/i,
  /\basks (?:what|which|four|three|how)\b/i,
  /\brefusing to commit\b/i,
  /\bit depends\b/i,
  /\bdepends on your priorities\b/i,
  /\bboth are excellent choices\b/i,
  /\bno recommendation\b/i,
  /\bsame answer\b/i,
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

/** Whether the bounce names a withheld deliverable (asks, or won't commit). */
export function bounceNamesWithheld(item: EverydayUseItem): boolean {
  return matchesAny(WITHHELD_BOUNCE_PATTERNS, item.bounceCondition);
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

// ─── probe construction ────────────────────────────────────────────────────

/** Probe id for a corpus item. Prefixed so it can never collide with a probe set. */
export function everydayProbeId(itemId: string): string {
  return `everyday-${itemId}`;
}

/**
 * ★ Items whose JOB is to hand the user's own WORDING back — the reply IS their
 * text, carrying only the fixes they asked for ("fix the spelling and grammar
 * but dont change my voice" → "The corrected text and nothing else"). These are
 * the only items where a longest-common-span measure means what its name says.
 *
 * `faithful-reproduction` on its own is too broad to gate it. That need covers
 * two different jobs, and span overlap is a valid reading of exactly one:
 *
 *   - WORDING must survive (this list) — a long shared span IS the success, and
 *     a rewrite out of their register is the failure the item names.
 *   - FACTS must survive (the list below) — figures, dates and names have to
 *     come back intact while the wording is deliberately CHANGED: a summary
 *     compresses, a tone rewrite softens, a hospital letter gets translated out
 *     of jargon. There a longer shared span often means the model failed.
 *     `health-hospital-letter` bounces on "Parrots the jargon back with a
 *     definition list" — precisely the answer a high span score would reward.
 *     Those items are scored by `preservesFacts` instead, which counts entity
 *     and figure survival and is blind to how the reply was worded.
 *
 * ⚠ THE HONEST SIZE OF THIS: one item. A dim reading out a single probe is a
 * data point, not a comparison, and it cannot carry an A/B by itself. Widening
 * it means adding proofread-class jobs to the corpus, not relaxing the criterion.
 */
export const EVERYDAY_WORDING_PRESERVATION_ITEM_IDS: readonly string[] = ['sw-15'];

/**
 * The other side of that split: items whose `faithful-reproduction` need is
 * about FACTS, not wording. Span overlap would read their good answer and their
 * bounce the wrong way round, so they are gated to `preservesFacts` — did the
 * figures, dates and names come back uncorrupted, however the reply re-worded
 * them.
 *
 * Pinned as a list, with the reason, so the judgement is reviewable. Together
 * with the list above (and the no-pasted-text list below) it must cover EVERY
 * corpus item carrying `faithful-reproduction` — `everyday-probes.test.ts`
 * asserts that, so a new corpus item fails until someone classifies it instead
 * of silently joining a gate.
 */
export const EVERYDAY_FACT_REPRODUCTION_ITEM_IDS: readonly string[] = [
  'work-email-tone-fix', // tone rewrite: "firm but neutral" — changing the wording is the task
  'rewrite-03', // verdict first, then their sentence SOFTENED
  'school-essay-not-ai', // "can you make this better" — handing it straight back is not an answer
  'health-hospital-letter', // plain-English translation; bounces on parroting the jargon
  'school-letter-esl-parent', // pull £45 and 8 August OUT of institutional English
  'legal-rent-increase', // reads the notice back plainly, in their words not the landlord's
  'summarise-01', // "tldr" — compression is the whole request
  'sw-13', // reformat into a table: the figures survive, the prose does not
];

/**
 * ★ THE THIRD BUCKET, pinned so nothing falls through in silence. These items
 * carry `faithful-reproduction` but the text to be reproduced is NOT in this
 * turn — "shorter. and take out the sorry" refers to a message the corpus does
 * not contain. Neither dim can be pointed at them: there is nothing in `prompt`
 * to preserve, and measuring against it would score noise.
 *
 * Without this list the partition test would be gated on `hasPastedContent`, and
 * an item could quietly leave the classification by having that flag flipped.
 */
export const EVERYDAY_FAITHFUL_WITHOUT_PASTED_TEXT_ITEM_IDS: readonly string[] = [
  'work-followup-shorter', // the antecedent lives in an earlier turn
];

/**
 * `preservesUserText` applies only where all three agree: the words are actually
 * in this turn, the derived needs say they have to come back, and the item's job
 * is to preserve the WORDING rather than the facts. A follow-up whose antecedent
 * lives in an earlier turn ("shorter. and take out the sorry") has nothing in
 * `prompt` to preserve, and measuring it there would score noise.
 */
function expectsUserTextReuse(item: EverydayUseItem): boolean {
  return (
    item.hasPastedContent &&
    needsFor(item.id).needs.includes('faithful-reproduction') &&
    EVERYDAY_WORDING_PRESERVATION_ITEM_IDS.includes(item.id)
  );
}

/**
 * `preservesFacts` applies under the same three conditions, on the other side of
 * the wording/facts split. Exclusive with `expectsUserTextReuse` by construction:
 * the two id lists are disjoint and the test asserts it, so no probe is ever
 * scored by both — a reply cannot be asked to keep the wording and to change it.
 */
function expectsFactPreservation(item: EverydayUseItem): boolean {
  return (
    item.hasPastedContent &&
    needsFor(item.id).needs.includes('faithful-reproduction') &&
    EVERYDAY_FACT_REPRODUCTION_ITEM_IDS.includes(item.id)
  );
}

function buildNotes(item: EverydayUseItem, openness: AskOpenness): string {
  const lines = [
    `ASK: ${openness}.`,
    `WHAT THEY WANT: ${item.whatTheyActuallyWant}`,
    `GOOD ANSWER: ${item.goodAnswerLooksLike}`,
    `★ BOUNCE (the acceptance criterion — this response makes them give up): ${item.bounceCondition}`,
  ];
  if (hasPriorTurns(item.id)) {
    lines.push(
      'NOTE: anaphoric turn. The corpus holds no antecedent exchange and inventing one would be authoring corpus content, so this runs as an opening turn — judge it as such.',
    );
  }
  return lines.join('\n');
}

function toProbe(item: EverydayUseItem): EvalPromptSpec {
  const openness = classifyAskOpenness(item);
  const ceiling = ceilingWordsFor(item);
  const floor = richnessFloorFor(item, ceiling);

  return {
    id: everydayProbeId(item.id),
    category: 'everyday-use',
    intent: inferChatIntent(item.userInput, { hasPriorTurns: hasPriorTurns(item.id) }),
    prompt: item.userInput,
    expectDeliverable: true,
    ...(expectsUserTextReuse(item) ? { expectUserTextReuse: true as const } : {}),
    ...(expectsFactPreservation(item) ? { expectFactPreservation: true as const } : {}),
    ...(ceiling !== null ? { depthBand: { maxWords: ceiling } } : {}),
    ...(floor !== null ? { minWords: floor } : {}),
    judge: ['taskFit', 'coherence'],
    notes: buildNotes(item, openness),
  };
}

/** One probe per corpus item, in corpus order. Derived at module load. */
export const EVERYDAY_USE_PROBES: readonly EvalPromptSpec[] = EVERYDAY_USE_CORPUS.map(toProbe);

/** Probe id → the corpus item id it came from. */
export const EVERYDAY_PROBE_SOURCE_ITEM: Readonly<Record<string, string>> = Object.fromEntries(
  EVERYDAY_USE_CORPUS.map((item) => [everydayProbeId(item.id), item.id]),
);

/** Corpus item id → its derived openness. The pinned split. */
export const EVERYDAY_ASK_OPENNESS: Readonly<Record<string, AskOpenness>> = Object.fromEntries(
  EVERYDAY_USE_CORPUS.map((item) => [item.id, classifyAskOpenness(item)]),
);

/** Corpus item ids with a given openness, in corpus order. */
export function itemIdsWithOpenness(openness: AskOpenness): readonly string[] {
  return EVERYDAY_USE_CORPUS.filter((item) => classifyAskOpenness(item) === openness).map((i) => i.id);
}

/**
 * ★ A STATED GAP, not a solved problem. These items want brevity — their bounce
 * names over-delivery ("a pros-and-cons table", "a paragraph of reassurance"),
 * or their good answer says "Stays short" — but neither puts a NUMBER on it, so
 * no ceiling could be derived and `depthMatch` measures NOTHING on their
 * over-shoot side. The judge dims are the only thing watching there.
 *
 * Inventing a default ceiling for them was considered and rejected: it would
 * assert a bound the corpus never states, which is how an unfounded counterweight
 * ends up firing on answers that were fine. Pinned as a list so the gap stays
 * visible instead of being quietly rounded off.
 */
export const EVERYDAY_UNMEASURED_CEILING_ITEM_IDS: readonly string[] = EVERYDAY_USE_CORPUS
  .filter((item) => wantsBrevity(item) && ceilingWordsFor(item) === null)
  .map((item) => item.id);

/**
 * Probes whose turn only makes sense after an exchange the corpus does not
 * contain. Exclude them from a run when an opening-turn generation would be
 * meaningless for the question being asked.
 */
export const EVERYDAY_ANAPHORIC_PROBE_IDS: ReadonlySet<string> = new Set(
  EVERYDAY_USE_CORPUS.filter((item) => hasPriorTurns(item.id)).map((item) => everydayProbeId(item.id)),
);

/** The everyday probe ids, for scoping a report to the set. */
export const EVERYDAY_PROBE_IDS: ReadonlySet<string> = new Set(
  EVERYDAY_USE_PROBES.map((p) => p.id),
);
