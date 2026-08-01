// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ THE MIRROR TEST — a thin reply to an open ask must score BADLY.
 *
 * WHAT THIS GUARDS. The assistant's default instructions were unconditionally
 * elaborative: every turn was told to "add the context, reasons, or practical
 * details that make the reply useful on its own", whether the person wanted that
 * or not. Fixing it is right, and it carries one specific way of going wrong —
 * over-correcting into terseness, so that questions which genuinely deserve
 * substance start getting a shrug. "'What is France like' is a simple question,
 * but the user is curious about day-to-day life, the food, the culture; 'who is
 * the current president' wants nothing of the sort."
 *
 * An instrument that only measures "did the reply run too long" optimises the
 * product straight into that failure, and every open question quietly gets worse
 * without a single test going red. `everyday-probes.ts` already derives the other
 * half — a richness FLOOR (`minWords` → `answerDepth`) for every ask that invites
 * substance. This file is the standing check that the floor still bites.
 *
 * ── WHAT IT ACTUALLY MEASURES, SAID PLAINLY ─────────────────────────────────
 *
 * It generates no tokens. It cannot see a real model thin out; a GPU run does
 * that, and this file is what makes such a run readable. What it pins is the
 * INSTRUMENT: for every corpus item whose ask invites substance, a realistic
 * generic non-answer must score badly on `answerDepth`, a genuinely developed
 * reply must score 1.0, and a closed ask answering in one line must not be
 * scored at all. Get any of those wrong and the GPU run reports "no change"
 * for a change that damaged half the corpus.
 *
 * So it fails when the instrument's ability to see thinning is lost — the floor
 * removed, lowered, or classified away — and NOT when a model has a bad day.
 * That is the honest scope, and it is the scope that can be committed.
 *
 * ── FIVE PROPERTIES, AND WHY EACH ONE IS LOAD-BEARING ───────────────────────
 *
 *   1. COVERED SET READ LIVE. The items are whatever `classifyAskOpenness`
 *      calls `open` or `two-sided` TODAY — never a hand-copied list. Reclassify
 *      an item and it leaves or joins this guard automatically (and trips the
 *      pinned lists in `everyday-probes.test.ts`, loudly, first).
 *   2. THE THIN REPLY IS BUILT, NOT CHOSEN. One transformation, applied to every
 *      item's own ask. Hand-picking a per-item example would test the examples,
 *      not the dim. And its length is locked from BELOW (see
 *      `THIN_ANSWER_MIN_WORDS`), because the one cheap way to make this file
 *      pass without fixing anything is to shrink the synthetic reply until it
 *      scores badly by construction.
 *   3. `answerDepth` IS READ DIRECTLY, NEVER THROUGH A COMPOSITE. The composite
 *      is an unweighted mean over dims that sit at 1.0 on any well-formed reply;
 *      measured across these items it renders a two-to-one failure as a gap of
 *      under a tenth — noise, by any reading. The last test in this file measures
 *      that on the real items so nobody re-points the guard at a composite.
 *   4. THE FLOOR MUST STAY REACHABLE. A guard that only says "thin scores badly"
 *      is satisfied by demanding verbosity — raise every floor and it passes
 *      forever while the product turns into a lecture. So the mirror has two
 *      faces: thin scores badly AND a 60-word reply scores a full 1.0.
 *   5. NOTHING IS ASSERTED ABOUT CLOSED ASKS. "How long do you boil eggs" gets
 *      one line and that is CORRECT. The derivation gives closed items no floor
 *      at all, so `answerDepth` is `null` for them — asserted here, positively,
 *      so this file can never become the over-length-only instrument it exists
 *      to prevent, merely pointed the other way.
 *
 * ── ONE FINDING, STATED RATHER THAN ROUNDED OFF ─────────────────────────────
 *
 * `depthMatch` cannot see this failure AT ALL. The derivation sets only
 * `depthBand.maxWords` — a ceiling — and `everyday-probes.test.ts` asserts
 * `depthBand.minWords` is undefined everywhere on purpose, so the two directions
 * stay on separate dims. A thin reply therefore scores `depthMatch` 1.0 (it is
 * comfortably under every ceiling) or `null`. `answerDepth` is the dim that can
 * see under-delivery on EVERY covered item, which is why removing or weakening
 * it has to be a test failure rather than a judgement call. `preservesFacts` is
 * a second dim that sees it too, but only on the 7 covered items whose need
 * gates fact preservation — a generic non-answer never states the facts it
 * would have to reproduce. Pinned as its own positive check below, not folded
 * into this one, because it is a narrower and later finding than the first.
 */

import { describe, expect, it } from 'vitest';

import { EVERYDAY_USE_CORPUS, type EverydayUseItem } from '../../../__tests__/fixtures/everyday-use-corpus';
import { AUTOMATED_DIMENSIONS } from '../aggregate';
import {
  EVERYDAY_FACT_REPRODUCTION_ITEM_IDS,
  EVERYDAY_USE_PROBES,
  classifyAskOpenness,
  everydayProbeId,
  itemIdsWithOpenness,
  wantsSubstance,
} from '../everyday-probes';
import { pastedBlockOf, scoreAnswerDepth, scoreDepthMatch, scoreResult } from '../rubric';
import type { EvalPromptSpec, RubricContext, RubricScores } from '../types';

// ─── the covered set, read live ────────────────────────────────────────────

/**
 * Every item whose ask invites substance. Computed from the live classification,
 * so a corpus addition or a reclassification moves this set on its own. The
 * names are pinned once, in `everyday-probes.test.ts`; re-pinning them here
 * would create a second place to edit and a first place to disagree.
 */
const COVERED_ITEMS: readonly EverydayUseItem[] = EVERYDAY_USE_CORPUS.filter(
  (item) => classifyAskOpenness(item) !== 'closed',
);

const CLOSED_ITEMS: readonly EverydayUseItem[] = EVERYDAY_USE_CORPUS.filter(
  (item) => classifyAskOpenness(item) === 'closed',
);

function probeFor(item: EverydayUseItem): EvalPromptSpec {
  const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id));
  if (probe === undefined) throw new Error(`no probe derived for corpus item ${item.id}`);
  return probe;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── the thin-answer construction ──────────────────────────────────────────

/**
 * The ask the person TYPED, as opposed to anything they pasted. `pastedBlockOf`
 * is the eval lane's one definition of "the text the user handed us", and it
 * already handles the ask sitting at either end — "does this sound rude" leads,
 * a pasted group chat followed by "tldr" trails. Reusing it rather than
 * re-deriving means the anchor below can never disagree with the rest of the
 * lane about which half of a turn is the question.
 */
function askWindowOf(userInput: string): string {
  const pasted = pastedBlockOf(userInput);
  if (pasted === userInput) return userInput;
  const typed = userInput
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !pasted.includes(block))
    .join(' ');
  return typed.length > 0 ? typed : userInput;
}

/** Words of the ask quoted back. Capped so the anchor can never carry the reply. */
const THIN_ANSWER_ANCHOR_WORDS = 6;

function anchorOf(userInput: string): string {
  const ask = askWindowOf(userInput);
  const firstClause =
    ask
      .split(/[.?!\n]/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? ask;
  return firstClause.split(/\s+/).filter(Boolean).slice(0, THIN_ANSWER_ANCHOR_WORDS).join(' ');
}

/**
 * ★ THE FAILURE, BUILT RATHER THAN CHOSEN: quote the ask back, then say nothing.
 *
 * One frame for all of them, on purpose. Genericness IS the failure being
 * modelled — the corpus names it over and over ("vague reassurance", "abstract
 * categories", "'I'm sorry you're going through this' and nothing else") — and a
 * reply that could be pasted under any question is precisely a reply that
 * answered none of them. Hand-writing a per-item thin answer would test the
 * hand-writing; this tests the dim.
 *
 * It deliberately contains no bullet, no code fence, no table and no question,
 * so nothing structural and nothing in `deliversFirst` is doing the work: on
 * every covered item the ONLY automated dim that moves is `answerDepth`, which
 * is asserted below rather than assumed.
 */
function thinAnswerFor(item: EverydayUseItem): string {
  return `On "${anchorOf(item.userInput)}", it really depends on the situation. It is worth looking into a bit more.`;
}

/**
 * ★ THE LOCK ON THE CONSTRUCTION, and the reason this file cannot be made to
 * pass by cheating. `answerDepth` is words/floor, so the cheapest possible way
 * to satisfy every assertion below is to keep shortening the synthetic reply
 * until it scores badly whatever the floor says. A lower bound forbids it.
 *
 * MEASURED, NOT CHOSEN. Calibrated against the non-answers the corpus quotes in
 * its OWN bounce conditions — the real thing this construction stands in for.
 * They run 6 to 12 words (see `CORPUS_QUOTED_NON_ANSWERS`, whose word counts are
 * recomputed and asserted below rather than trusted). The construction produces
 * 16 to 21, so every synthetic reply here is LONGER than any non-answer the
 * corpus records, and the guard is conservative by construction: if this
 * generous version scores badly, the real ones score worse.
 */
const THIN_ANSWER_MIN_WORDS = 16;
const THIN_ANSWER_MAX_WORDS = 21;

/**
 * Non-answers quoted verbatim inside the corpus's own `bounceCondition` text —
 * the calibration evidence for the bound above. Each is checked against its
 * item's live bounce string, so a quote cannot drift into something the corpus
 * never said.
 */
const CORPUS_QUOTED_NON_ANSWERS: readonly (readonly [string, string])[] = [
  ['health-blood-results', "I can't interpret medical results, please speak to your doctor"],
  ['ft-14', 'You should take it to a qualified mechanic as soon as possible'],
  ['money-insurance-jump', 'prices have gone up, shop around'],
  ['ft-13', 'It really depends on your priorities and situation.'],
  ['legal-rent-increase', "I'm not a lawyer, consult an attorney"],
  ['ft-04', 'your privacy is important to us'],
  ['company-01', "I'm sorry you're going through this"],
  ['decide-01', 'both are excellent choices, it depends on your priorities'],
  ['school-letter-esl-parent', 'you should contact the school for clarification'],
  ['ft-01', 'writing assistance, analysis, brainstorming, coding, research'],
  ['health-hospital-letter', "I can't interpret medical documents, please consult her physician"],
];

// ─── the derived score ceilings ────────────────────────────────────────────

/**
 * ★ THE THRESHOLD, COMPUTED — the same discipline as the 60-word richness floor
 * it is measured against ("CALIBRATED, not chosen").
 *
 * `scoreAnswerDepth` is `min(1, words/minWords)`, so the worst a thin reply can
 * score is the longest one this construction produces over the SMALLEST floor
 * any covered item carries:
 *
 *     THIN_ANSWER_MAX_WORDS / min(minWords over covered items)  =  21 / 40  =  0.525
 *
 * Both inputs are pinned and both are asserted below, so the arithmetic is
 * checkable rather than asserted. Nothing is rounded to a comfortable number:
 * 0.525 is the measured worst case, not a margin.
 *
 * ★ AND IT IS THE FINDING, NOT JUST THE THRESHOLD. 0.525 is uncomfortably close
 * to half marks for a reply that answers nothing, and it comes entirely from the
 * seven items whose floor is the reduced `BREVITY_BOUNDED_FLOOR_WORDS` (40-45)
 * rather than the full 60 — items whose good answer really is short, so the
 * floor there has little room to work with. The guard is at its weakest exactly
 * where the corpus says "stay short". Pinned as a second, tighter ceiling over
 * the items carrying the full floor (21/60 = 0.35, which is where the majority
 * sit) so the weakness stays visible instead of being averaged away.
 */
const THIN_SCORE_CEILING = 0.525;
const THIN_SCORE_CEILING_FULL_FLOOR = 0.35;

/** The full richness floor, from `everyday-probes.ts`. Pinned as the upper bound a floor may take. */
const RICHNESS_FLOOR_WORDS = 60;

/**
 * ★ The three items that sit at the ceiling — a LIST, not a count, so a
 * derivation degenerating into something else moves a name rather than a number.
 * All three carry the reduced 40-word floor.
 */
const WEAKEST_FLOOR_ITEMS = ['admin-gym-cancellation', 'health-blood-results', 'family-text-thread'];

/**
 * The covered items that carry a ceiling at all, and therefore the only ones on
 * which `depthMatch` returns a number. Pinned to make the finding in the header
 * concrete: five of twenty-eight, and on all five it reads 1.0 for a reply that
 * answers nothing.
 */
const COVERED_ITEMS_WITH_A_CEILING = [
  'school-essay-not-ai',
  'draft-01',
  'school-letter-esl-parent',
  'summarise-01',
  'explain-01',
];

// ─── a ruler, for probing the band's geometry ──────────────────────────────

/**
 * N distinct words. A RULER, not a reply: its only property is its length, and
 * every token differs so it is well-formed by construction (no repeated trigram,
 * nothing to leak). Used to ask what the band does at a given size — never to
 * claim that text of that size is any good, which is a judge's call.
 */
function ruler(words: number): string {
  return Array.from({ length: words }, (_, i) => `w${String(i)}`).join(' ');
}

function ctxFor(output: string): RubricContext {
  return { output, endedCleanly: true, hitTokenCap: false };
}

/**
 * `aggregate.resultComposite` is private, so it is re-derived here from the
 * exported dimension list — which means a dim added to the scorecard is
 * automatically added to this calculation and cannot quietly escape the
 * demonstration below.
 */
function compositeOf(scores: RubricScores): number {
  const applicable = AUTOMATED_DIMENSIONS.map((dim) => scores[dim]).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  return applicable.reduce((sum, value) => sum + value, 0) / applicable.length;
}

// ─── coverage ──────────────────────────────────────────────────────────────

describe('the mirror covers every ask that invites substance', () => {
  it('★ takes its items from the live classification, not a copied list', () => {
    expect(COVERED_ITEMS.length).toBeGreaterThan(0);
    expect(COVERED_ITEMS.map((item) => item.id).sort()).toEqual(
      [...itemIdsWithOpenness('open'), ...itemIdsWithOpenness('two-sided')].sort(),
    );
    // And the two sets partition the corpus, so nothing can fall between them.
    expect(COVERED_ITEMS.length + CLOSED_ITEMS.length).toBe(EVERYDAY_USE_CORPUS.length);
  });

  it('★ and cannot quietly shrink — a floor on coverage, not a pin of the split', () => {
    // Reading the set live is the right call and it has one blind spot: an item
    // reclassified `closed` simply leaves this guard, and every assertion below
    // still passes over the smaller set. The pinned lists in
    // `everyday-probes.test.ts` catch that first and by NAME, which is why the
    // names are not duplicated here — but they can be edited in the same commit.
    // This line is what such a commit has to come past and justify.
    //
    // A FLOOR, deliberately, not an equality: adding closed items (wave 2 added
    // nine) must not fail this, and a corpus that grows in one direction must not
    // turn an authoring choice into a red test. It only fires when coverage falls.
    expect(
      COVERED_ITEMS.length,
      'fewer asks now invite substance than when this guard was written — if that is intended, say which items moved and why',
    ).toBeGreaterThanOrEqual(28);
  });

  it('★ every covered item carries a richness floor, so answerDepth is never null here', () => {
    // The chain this guard depends on, asserted link by link: the item wants
    // substance → the derivation gives it `minWords` → the dim returns a number.
    // Break any link and the guard would pass while measuring nothing.
    for (const item of COVERED_ITEMS) {
      const probe = probeFor(item);
      expect(wantsSubstance(item), `${item.id} is covered but does not want substance`).toBe(true);
      expect(probe.minWords, `${item.id} lost its richness floor`).toBeDefined();
      expect(
        scoreAnswerDepth(probe, thinAnswerFor(item)),
        `${item.id}: answerDepth went null — the dim stopped applying`,
      ).not.toBeNull();
    }
  });

  it('pins the smallest and largest floor the covered set carries', () => {
    const floors = COVERED_ITEMS.map((item) => probeFor(item).minWords!);
    expect(Math.min(...floors)).toBe(40);
    expect(Math.max(...floors)).toBe(RICHNESS_FLOOR_WORDS);
  });
});

// ─── the construction is honest ────────────────────────────────────────────

describe('the thin answer is built, and built long enough to be honest', () => {
  it('★ quotes only the corpus — every calibration quote is really in its bounce condition', () => {
    for (const [itemId, quote] of CORPUS_QUOTED_NON_ANSWERS) {
      const item = EVERYDAY_USE_CORPUS.find((i) => i.id === itemId);
      expect(item, `${itemId} is no longer in the corpus`).toBeDefined();
      expect(item!.bounceCondition, `${itemId} no longer contains its quoted non-answer`).toContain(
        quote,
      );
    }
  });

  it('★ is LONGER than any non-answer the corpus records — the lock against shrinking it', () => {
    const longestQuoted = Math.max(
      ...CORPUS_QUOTED_NON_ANSWERS.map(([, quote]) => wordCount(quote)),
    );
    expect(longestQuoted).toBe(12);
    expect(
      THIN_ANSWER_MIN_WORDS,
      'the synthetic thin reply got shorter than a real one — it would now score badly by construction',
    ).toBeGreaterThan(longestQuoted);

    for (const item of COVERED_ITEMS) {
      const thin = thinAnswerFor(item);
      expect(wordCount(thin), `${item.id}: "${thin}"`).toBeGreaterThanOrEqual(THIN_ANSWER_MIN_WORDS);
      expect(wordCount(thin), `${item.id}: "${thin}"`).toBeLessThanOrEqual(THIN_ANSWER_MAX_WORDS);
    }
  });

  it('carries nothing structural that could be doing the work instead of the floor', () => {
    for (const item of COVERED_ITEMS) {
      const thin = thinAnswerFor(item);
      expect(thin).not.toMatch(/```/);
      expect(thin).not.toMatch(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/m);
      expect(thin).not.toMatch(/\?/);
    }
  });

  it('★ answers the item it is scored against — the ask is quoted back, verbatim', () => {
    for (const item of COVERED_ITEMS) {
      const anchor = anchorOf(item.userInput);
      expect(anchor.length, `${item.id} produced an empty anchor`).toBeGreaterThan(0);
      expect(item.userInput.toLowerCase()).toContain(anchor.toLowerCase());
      expect(thinAnswerFor(item)).toContain(anchor);
    }
  });
});

// ─── ★★ the guard ──────────────────────────────────────────────────────────

describe('★★ MIRROR: a thin reply to an open ask scores badly on answerDepth', () => {
  it('★ scores every covered item at or below the derived ceiling', () => {
    for (const item of COVERED_ITEMS) {
      const probe = probeFor(item);
      const thin = thinAnswerFor(item);
      const depth = scoreAnswerDepth(probe, thin);
      expect(
        depth!,
        `${item.id}: a ${String(wordCount(thin))}-word non-answer scored ${String(depth)} against a floor of ${String(probe.minWords)} — the instrument has stopped seeing thinness`,
      ).toBeLessThanOrEqual(THIN_SCORE_CEILING);
    }
  });

  it('★ and well below it on every item carrying the full richness floor', () => {
    const fullFloor = COVERED_ITEMS.filter(
      (item) => probeFor(item).minWords === RICHNESS_FLOOR_WORDS,
    );
    // The majority of the covered set, and where the guard is strongest.
    expect(fullFloor.length).toBeGreaterThan(COVERED_ITEMS.length / 2);
    for (const item of fullFloor) {
      expect(scoreAnswerDepth(probeFor(item), thinAnswerFor(item))!, item.id).toBeLessThanOrEqual(
        THIN_SCORE_CEILING_FULL_FLOOR,
      );
    }
  });

  it('★ pins the arithmetic behind the ceiling, so it cannot become a round number', () => {
    const floors = COVERED_ITEMS.map((item) => probeFor(item).minWords!);
    expect(THIN_ANSWER_MAX_WORDS / Math.min(...floors)).toBeCloseTo(THIN_SCORE_CEILING, 10);
    expect(THIN_ANSWER_MAX_WORDS / RICHNESS_FLOOR_WORDS).toBeCloseTo(
      THIN_SCORE_CEILING_FULL_FLOOR,
      10,
    );
  });

  it('★ pins the worst and best readings, and names the items at the worst', () => {
    const scored = COVERED_ITEMS.map((item) => ({
      id: item.id,
      depth: scoreAnswerDepth(probeFor(item), thinAnswerFor(item))!,
    }));
    const worst = Math.max(...scored.map((s) => s.depth));
    const best = Math.min(...scored.map((s) => s.depth));

    // Both ends fall out of the same two numbers: the worst is the longest thin
    // reply over the smallest floor, the best is the shortest over the largest.
    // The best belongs to `summarise-01`, whose whole typed ask is "tldr".
    expect(worst).toBeCloseTo(THIN_SCORE_CEILING, 10);
    expect(best).toBeCloseTo(THIN_ANSWER_MIN_WORDS / RICHNESS_FLOOR_WORDS, 10);
    // A LIST, not a count: these three carry the reduced 40-word floor, which is
    // where the instrument has the least room to see under-delivery.
    expect(scored.filter((s) => s.depth === worst).map((s) => s.id)).toEqual(WEAKEST_FLOOR_ITEMS);
  });

  it('★ answerDepth is the ONLY automated dim that moves on every covered item — nothing else sees this generally', () => {
    for (const item of COVERED_ITEMS) {
      const probe = probeFor(item);
      const scores = scoreResult(probe, ctxFor(thinAnswerFor(item)));
      for (const dim of AUTOMATED_DIMENSIONS) {
        if (dim === 'answerDepth') continue;
        // `preservesFacts` is a second, NARROWER exception — see the dedicated
        // test below, which turns this into a positive measurement rather than
        // a silent skip. It only ever fires on the 7 items pinned there.
        if (dim === 'preservesFacts') continue;
        const value = scores[dim];
        if (value === null) continue;
        expect(
          value,
          `${item.id}: dim "${dim}" scored ${String(value)} on a generic non-answer — if another dim can see this, say so; until then answerDepth is load-bearing alone`,
        ).toBe(1);
      }
    }
  });

  it('★ preservesFacts ALSO sees this, but only on the covered items whose need gates it — pinned as its own finding, not a silent skip', () => {
    // A generic non-answer never states the facts it would have to reproduce,
    // so this is a second, real way the thin-reply failure shows up — narrower
    // than answerDepth (which fires on every covered item), not a competitor to
    // it. The exemption in the test above is only honest if this list is exact.
    const factCoveredItems = COVERED_ITEMS.filter((item) =>
      EVERYDAY_FACT_REPRODUCTION_ITEM_IDS.includes(item.id),
    );
    expect(factCoveredItems.map((item) => item.id)).toEqual([
      'rewrite-03',
      'school-essay-not-ai',
      'health-hospital-letter',
      'school-letter-esl-parent',
      'legal-rent-increase',
      'summarise-01',
      'sw-13',
    ]);
    for (const item of factCoveredItems) {
      const probe = probeFor(item);
      const scores = scoreResult(probe, ctxFor(thinAnswerFor(item)));
      expect(scores.preservesFacts, item.id).toBe(0);
    }
  });

  it('★ depthMatch is structurally blind to it — a ceiling cannot see a shortfall', () => {
    const withCeiling: string[] = [];
    for (const item of COVERED_ITEMS) {
      const match = scoreDepthMatch(probeFor(item), thinAnswerFor(item));
      if (match === null) continue;
      withCeiling.push(item.id);
      // 1.0. The reply answers nothing and the ceiling is perfectly happy.
      expect(match, item.id).toBe(1);
    }
    expect(withCeiling).toEqual(COVERED_ITEMS_WITH_A_CEILING);
  });
});

// ─── the other face of the mirror ──────────────────────────────────────────

describe('★ and the floor stays reachable — verbosity is not the way to pass this', () => {
  it('★ a 60-word reply scores a full 1.0 on every covered item', () => {
    // The lock against the opposite cheat. "Thin scores badly" alone is satisfied
    // by raising every floor out of reach, which optimises the product into a
    // lecture — the mirror image of the failure this file exists to prevent. 60
    // is the corpus-calibrated length of a developed answer (`everyday-probes.ts`
    // measured it against every item's own good answer), so no floor may exceed it.
    for (const item of COVERED_ITEMS) {
      const probe = probeFor(item);
      expect(probe.minWords!, `${item.id}: floor above the calibrated developed length`).toBeLessThanOrEqual(
        RICHNESS_FLOOR_WORDS,
      );
      expect(scoreAnswerDepth(probe, ruler(RICHNESS_FLOOR_WORDS)), item.id).toBe(1);
      // …and the same reply is still inside the ceiling where there is one, so
      // no covered item carries a band nothing honest could satisfy.
      expect(scoreDepthMatch(probe, ruler(RICHNESS_FLOOR_WORDS)) ?? 1, item.id).toBe(1);
    }
  });

  it('the floor is a real edge: one word under it is not full marks', () => {
    for (const item of COVERED_ITEMS) {
      const probe = probeFor(item);
      expect(scoreAnswerDepth(probe, ruler(probe.minWords!)), item.id).toBe(1);
      expect(scoreAnswerDepth(probe, ruler(probe.minWords! - 1))!, item.id).toBeLessThan(1);
    }
  });
});

// ─── the closed side: nothing is asserted, and that is enforced ────────────

describe('★ a closed ask answering in one line is CORRECT, and nothing here says otherwise', () => {
  it('★ no closed item can be scored for depth at all — answerDepth is null', () => {
    // Requirement stated positively rather than by absence. "How long do you boil
    // eggs" wants a number and stops; the derivation gives it no floor, so there
    // is nothing for a terse reply to fail. If a floor ever appears on a closed
    // item this fails here — before it can start marking correct answers down.
    expect(CLOSED_ITEMS.length).toBeGreaterThan(0);
    const direct = "About 10-12 minutes once the water's boiling, then straight into cold water.";
    for (const item of CLOSED_ITEMS) {
      const probe = probeFor(item);
      expect(probe.minWords, `${item.id} gained a richness floor`).toBeUndefined();
      expect(scoreAnswerDepth(probe, direct), item.id).toBeNull();
      // Even the deliberately thin construction cannot mark a closed ask down.
      expect(scoreAnswerDepth(probe, thinAnswerFor(item)), item.id).toBeNull();
    }
  });

  it('the covered and closed sets are disjoint', () => {
    const covered = new Set(COVERED_ITEMS.map((item) => item.id));
    for (const item of CLOSED_ITEMS) {
      expect(covered.has(item.id), `${item.id} is in both sets`).toBe(false);
    }
  });
});

// ─── why the guard reads the dim and not the score ─────────────────────────

describe('★ the composite would have hidden all of this', () => {
  it('★ measured across the real corpus, not one hand-made example', () => {
    // `rubric.test.ts` pins this dilution on a single synthetic spec. Here it is
    // on all twenty-eight real items, so nobody can call it an artefact of one
    // example and re-point the guard above at a composite score.
    const ratios: number[] = [];
    let worstCompositeGap = 0;

    for (const item of COVERED_ITEMS) {
      const probe = probeFor(item);
      const thin = scoreResult(probe, ctxFor(thinAnswerFor(item)));
      const developed = scoreResult(probe, ctxFor(ruler(110)));

      const depthGap = developed.answerDepth! - thin.answerDepth!;
      const compositeGap = compositeOf(developed) - compositeOf(thin);
      expect(depthGap, `${item.id}: the dims no longer separate thin from developed`).toBeGreaterThan(0.4);
      ratios.push(compositeGap / depthGap);
      worstCompositeGap = Math.max(worstCompositeGap, compositeGap);
    }

    // The whole failure shows up as a sub-0.2 wobble on the composite — which
    // reads as noise, gets called noise, and ships terseness.
    //
    // ★ RAISED FROM 0.15, AND HERE IS WHICH DIM DID IT. `preservesFacts` now
    // also moves on the 7 covered items pinned in the test above — a real,
    // narrower finding, not a regression in this guard. Measured worst gap is
    // 0.175 (on those 7 items only; every other covered item is still under the
    // old 0.15). 0.2 keeps real headroom without hiding a THIRD dim starting to
    // move, which would still fail here and would need the same treatment: find
    // it, pin it in its own positive test, only then raise this bound again.
    //
    // ★ IF THIS FAILS UPWARD AGAIN, THAT IS GOOD NEWS AND STILL NEEDS READING.
    // Same instruction as above — say which dim, pin it positively, raise the
    // bound last.
    expect(
      worstCompositeGap,
      'the composite/dim gap moved — if a new dim now sees this failure, record which one rather than re-pointing the guard at the composite',
    ).toBeLessThan(0.2);
    // Asserted as a RATIO so that adding another always-1.0 guard dim — which
    // makes the dilution worse, not better — cannot slip past unnoticed.
    // ★ RAISED FROM 0.25 for the same reason as the gap bound above: on the 7
    // items where `preservesFacts` also moves, compositeGap is bigger relative
    // to depthGap too. Measured worst ratio is ~0.269 (same 7 items); 0.3 keeps
    // real headroom on the same "find it, pin it, then raise" terms.
    expect(Math.max(...ratios)).toBeLessThan(0.3);
  });
});
