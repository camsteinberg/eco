// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use probes — unit tests.
 *
 * Two jobs:
 *
 *   1. COVERAGE. One probe per corpus item, asserted by name against the live
 *      corpus length. A corpus addition must fail loudly here rather than sit
 *      silently unmeasured.
 *   2. PINNING. Every derived value is pinned as a LIST, never as a count. A
 *      count survives a derivation quietly degenerating into something else;
 *      a list does not. These lists were read item by item against each item's
 *      own `goodAnswerLooksLike` before being written down — if you change a
 *      rule and a list moves, go and check the item, do not re-copy the output.
 */

import { describe, expect, it } from 'vitest';

import {
  EVERYDAY_USE_CORPUS,
  hasPriorTurns,
  needsFor,
} from '../../../__tests__/fixtures/everyday-use-corpus';
import { inferChatIntent } from '../../../lib/chat-intent';
import {
  EVERYDAY_ANAPHORIC_PROBE_IDS,
  EVERYDAY_ARTIFACT_ASKS,
  EVERYDAY_ARTIFACT_ASK_CANDIDATE_IDS,
  EVERYDAY_ASK_OPENNESS,
  EVERYDAY_UNGATED_ARTIFACT_ASKS,
  EVERYDAY_FACT_REPRODUCTION_ITEM_IDS,
  EVERYDAY_FAITHFUL_WITHOUT_PASTED_TEXT_ITEM_IDS,
  EVERYDAY_PROBE_IDS,
  EVERYDAY_UNMEASURED_CEILING_ITEM_IDS,
  EVERYDAY_USE_PROBES,
  EVERYDAY_WORDING_PRESERVATION_ITEM_IDS,
  classifyAskOpenness,
  everydayProbeId,
  itemIdsWithOpenness,
  wantsBrevity,
  wantsSubstance,
} from '../everyday-probes';
import {
  analyzeArtifactDelivery,
  analyzePreservesUserText,
  extractFacts,
  pastedBlockOf,
  scoreFactPreservation,
  scorePreservesUserText,
} from '../rubric';

// ─── the pinned derivation ─────────────────────────────────────────────────

/** Ceiling (over-shoot) and floor (under-shoot) per item, both optional. */
const EXPECTED_BANDS: Readonly<Record<string, { maxWords?: number; minWords?: number }>> = {
  'work-email-tone-fix': { maxWords: 87 },
  'work-followup-shorter': {},
  'rewrite-03': { minWords: 60 },
  'sw-15': { maxWords: 98 },
  'school-essay-not-ai': { maxWords: 104, minWords: 42 },
  'work-sick-text': { maxWords: 125 },
  'draft-01': { maxWords: 263, minWords: 60 },
  'admin-gym-cancellation': { minWords: 40 },
  'family-eulogy': { minWords: 60 },
  'ft-06': {},
  'health-blood-results': { minWords: 40 },
  'health-hospital-letter': { minWords: 60 },
  'school-letter-esl-parent': { maxWords: 113, minWords: 45 },
  'legal-rent-increase': { minWords: 40 },
  'summarise-01': { maxWords: 188, minWords: 60 },
  'explain-01': { maxWords: 525, minWords: 60 },
  'school-fractions': { minWords: 60 },
  'factual-01': { maxWords: 125 },
  'factual-02': { minWords: 60 },
  'factual-04': { minWords: 60 },
  'decide-01': { minWords: 60 },
  'money-insurance-jump': { minWords: 60 },
  'ft-14': { minWords: 60 },
  'money-budget-house': { minWords: 60 },
  'excel-sumif': { minWords: 60 },
  'sw-13': { minWords: 60 },
  'food-fridge-dinner': { minWords: 60 },
  'travel-lisbon-kid': { minWords: 60 },
  'ideas-01': { minWords: 60 },
  'family-text-thread': { minWords: 40 },
  'company-01': { minWords: 60 },
  'company-02': {},
  'translate-01': {},
  'translate-02': { minWords: 60 },
  'ft-01': { minWords: 60 },
  'ft-04': { minWords: 40 },
  'ft-08': {},
  'ft-13': {},
  'sw-12': {},
  'ft-15': { maxWords: 38 },
  // ── WAVE 2 — the proofread-class jobs ─────────────────────────────────────
  // Every one takes its ceiling from R2 (the reply is bounded by the text they
  // pasted), and none takes a floor: their bounces name substitution, not
  // thinness, and more words is not the remedy for a rewrite in the wrong voice.
  'proofread-teacher-note-esl': { maxWords: 165 },
  'proofread-birthday-caption': { maxWords: 189 },
  'proofread-memorial-tribute': { maxWords: 183 },
  'proofread-grandfather-letter': { maxWords: 187 },
  'proofread-vet-application': { maxWords: 193 },
  'proofread-crew-email': { maxWords: 183 },
  'proofread-marketplace-ad': { maxWords: 188 },
  'proofread-review-reply': { maxWords: 220 },
  'proofread-school-post': { maxWords: 229 },
};

/**
 * ★ The open/closed split — the evidence this instrument exists to produce.
 *
 * The headline is `two-sided`: 22 of the blind-authored 40 bounce in BOTH
 * directions. More than half of that corpus can be damaged by a change that is
 * only checked for length in one direction, which is the whole argument for the
 * richness floor riding alongside the ceiling rather than instead of it.
 *
 * ★ WAVE 2 DID NOT ADD TO THAT EVIDENCE — IT DILUTED IT, and the assertion below
 * was rewritten to say so rather than to keep reading green. All nine proofread
 * items are `closed`, so corpus-wide the two-sided share fell from 22/40 (55%) to
 * 22/49 (45%) without a single item changing its classification. The majority
 * claim is therefore made about the population it was measured on, and the skew
 * wave 2 introduced is pinned next to it. A count over a corpus that grows in one
 * direction is a statement about the additions, not about people.
 */
const WAVE_2_ITEM_IDS = [
  'proofread-teacher-note-esl',
  'proofread-birthday-caption',
  'proofread-memorial-tribute',
  'proofread-grandfather-letter',
  'proofread-vet-application',
  'proofread-crew-email',
  'proofread-marketplace-ad',
  'proofread-review-reply',
  'proofread-school-post',
];
const CLOSED_ITEMS = [
  'work-email-tone-fix',
  'work-followup-shorter',
  'sw-15',
  'work-sick-text',
  'ft-06',
  'factual-01',
  'company-02',
  'translate-01',
  'ft-08',
  'ft-13',
  'sw-12',
  'ft-15',
  // ── WAVE 2 — the proofread-class jobs, all nine closed and for one reason ──
  // Each states its bound in its own good answer ("the corrected text and
  // nothing else"), and none of their bounces names thinness: what they name is
  // the reply coming back in somebody else's voice, which no word floor fixes.
  'proofread-teacher-note-esl',
  'proofread-birthday-caption',
  'proofread-memorial-tribute',
  'proofread-grandfather-letter',
  'proofread-vet-application',
  'proofread-crew-email',
  'proofread-marketplace-ad',
  'proofread-review-reply',
  'proofread-school-post',
];

const OPEN_ITEMS = [
  'factual-02',
  'money-insurance-jump',
  'ft-14',
  'sw-13',
  'translate-02',
  'ft-01',
];

const TWO_SIDED_ITEMS = [
  'rewrite-03',
  'school-essay-not-ai',
  'draft-01',
  'admin-gym-cancellation',
  'family-eulogy',
  'health-blood-results',
  'health-hospital-letter',
  'school-letter-esl-parent',
  'legal-rent-increase',
  'summarise-01',
  'explain-01',
  'school-fractions',
  'factual-04',
  'decide-01',
  'money-budget-house',
  'excel-sumif',
  'food-fridge-dinner',
  'travel-lisbon-kid',
  'ideas-01',
  'family-text-thread',
  'company-01',
  'ft-04',
];

/**
 * Items whose reply has to hand the user's own WORDING back, in this turn — the
 * only place a longest-common-span measure reads the right way round. Was one;
 * wave 2 took it to ten, which is what makes the n-gram A/B a comparison rather
 * than a single reading.
 */
const REUSE_PROBE_IDS = [
  'everyday-sw-15',
  'everyday-proofread-teacher-note-esl',
  'everyday-proofread-birthday-caption',
  'everyday-proofread-memorial-tribute',
  'everyday-proofread-grandfather-letter',
  'everyday-proofread-vet-application',
  'everyday-proofread-crew-email',
  'everyday-proofread-marketplace-ad',
  'everyday-proofread-review-reply',
  'everyday-proofread-school-post',
];

/**
 * The other side of the split: pasted content present, the need derived, and the
 * job is the user's FACTS back while the wording deliberately CHANGES. Span
 * overlap would score their good answer and their bounce the wrong way round, so
 * these are gated to `preservesFacts` instead.
 */
const FACT_REPRODUCTION_ITEMS = [
  'work-email-tone-fix',
  'rewrite-03',
  'school-essay-not-ai',
  'health-hospital-letter',
  'school-letter-esl-parent',
  'legal-rent-increase',
  'summarise-01',
  'sw-13',
];

const ANAPHORIC_PROBE_IDS = [
  'everyday-work-followup-shorter',
  'everyday-ft-08',
  'everyday-ft-13',
  'everyday-sw-12',
  'everyday-ft-15',
];

/** ★ A stated gap: wants brevity, states no number, so no ceiling is measured. */
const UNMEASURED_CEILING_ITEMS = [
  'work-followup-shorter',
  'rewrite-03',
  'admin-gym-cancellation',
  'family-eulogy',
  'ft-06',
  'health-blood-results',
  'health-hospital-letter',
  'legal-rent-increase',
  'school-fractions',
  'factual-04',
  'decide-01',
  'money-budget-house',
  'excel-sumif',
  'food-fridge-dinner',
  'travel-lisbon-kid',
  'ideas-01',
  'family-text-thread',
  'company-01',
  'company-02',
  'translate-01',
  'ft-04',
  'ft-08',
  'ft-13',
  'sw-12',
];

// ─── coverage ──────────────────────────────────────────────────────────────

describe('everyday probe coverage', () => {
  it('★ derives exactly one probe per corpus item, all 49', () => {
    expect(EVERYDAY_USE_PROBES).toHaveLength(EVERYDAY_USE_CORPUS.length);
    expect(EVERYDAY_USE_PROBES.map((p) => p.id)).toEqual(
      EVERYDAY_USE_CORPUS.map((item) => everydayProbeId(item.id)),
    );
  });

  it('carries every prompt VERBATIM — never re-typed, never tidied', () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id));
      expect(probe?.prompt).toBe(item.userInput);
    }
  });

  it('★ carries each bounce condition into the notes — it is the acceptance criterion', () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id));
      expect(probe?.notes).toContain(item.bounceCondition);
      expect(probe?.notes).toContain(item.goodAnswerLooksLike);
    }
  });

  it('keeps intent in lockstep with the live router', () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id));
      expect(probe?.intent).toBe(
        inferChatIntent(item.userInput, { hasPriorTurns: hasPriorTurns(item.id) }),
      );
    }
  });

  it('gives every probe a distinct, namespaced id and asks for a judge', () => {
    expect(EVERYDAY_PROBE_IDS.size).toBe(EVERYDAY_USE_PROBES.length);
    for (const probe of EVERYDAY_USE_PROBES) {
      expect(probe.id.startsWith('everyday-')).toBe(true);
      expect(probe.category).toBe('everyday-use');
      expect(probe.judge).toEqual(['taskFit', 'coherence']);
      expect(probe.expectDeliverable).toBe(true);
    }
  });
});

// ─── the two-sided derivation ──────────────────────────────────────────────

describe('depth expectations are derived, and two-sided', () => {
  it('★ pins the ceiling and floor for all 49 items', () => {
    const actual = Object.fromEntries(
      EVERYDAY_USE_CORPUS.map((item) => {
        const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id))!;
        return [
          item.id,
          {
            ...(probe.depthBand?.maxWords !== undefined ? { maxWords: probe.depthBand.maxWords } : {}),
            ...(probe.minWords !== undefined ? { minWords: probe.minWords } : {}),
          },
        ];
      }),
    );
    expect(actual).toEqual(EXPECTED_BANDS);
  });

  it('★ never sets a floor a good answer could not clear: floor stays under the ceiling', () => {
    for (const probe of EVERYDAY_USE_PROBES) {
      const ceiling = probe.depthBand?.maxWords;
      if (ceiling === undefined || probe.minWords === undefined) continue;
      expect(probe.minWords).toBeLessThan(ceiling);
    }
  });

  it('★ the under-shoot side rides minWords and the over-shoot side rides depthBand', () => {
    // They must not be folded together: a composite that hides one direction
    // behind the other is how an instrument becomes one-sided by accident.
    for (const probe of EVERYDAY_USE_PROBES) {
      expect(probe.depthBand?.minWords).toBeUndefined();
    }
  });

  it('gives every substance-wanting item a floor, and no other item one', () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id))!;
      expect(probe.minWords !== undefined).toBe(wantsSubstance(item));
    }
  });

  it('★ defaults to expecting substance — silence is never licence to be terse', () => {
    // The asymmetry that keeps this instrument from optimising us into
    // terseness: an item has to SAY it wants brevity to lose its floor.
    const silent = EVERYDAY_USE_CORPUS.filter((item) => !wantsBrevity(item));
    expect(silent.length).toBeGreaterThan(0);
    for (const item of silent) {
      expect(wantsSubstance(item)).toBe(true);
    }
  });
});

// ─── the open/closed split ─────────────────────────────────────────────────

describe('★ open vs closed — the axis under the length question', () => {
  it('pins the closed items', () => {
    expect(itemIdsWithOpenness('closed')).toEqual(CLOSED_ITEMS);
  });

  it('pins the open items', () => {
    expect(itemIdsWithOpenness('open')).toEqual(OPEN_ITEMS);
  });

  it('★ pins the two-sided items — the majority of the blind forty, and the reason one-sided tuning is unsafe', () => {
    expect(itemIdsWithOpenness('two-sided')).toEqual(TWO_SIDED_ITEMS);
    // The claim, against the population it was measured on. Wave 2 was authored
    // to one job and classifies uniformly; counting it in would let an authoring
    // choice look like a finding about people.
    const blindAuthored = EVERYDAY_USE_CORPUS.filter((i) => !WAVE_2_ITEM_IDS.includes(i.id));
    const twoSidedBlind = blindAuthored.filter((i) => classifyAskOpenness(i) === 'two-sided');
    expect(blindAuthored).toHaveLength(40);
    expect(twoSidedBlind.length).toBeGreaterThan(blindAuthored.length / 2);
    // And the dilution, said out loud: every wave-2 item is closed, so the
    // corpus-wide two-sided share is now below half with nothing reclassified.
    for (const id of WAVE_2_ITEM_IDS) {
      expect(EVERYDAY_ASK_OPENNESS[id], `${id} is no longer closed — re-read the claim above`).toBe(
        'closed',
      );
    }
    expect(TWO_SIDED_ITEMS.length).toBeLessThan(EVERYDAY_USE_CORPUS.length / 2);
  });

  it('classifies every item exactly once', () => {
    expect([...CLOSED_ITEMS, ...OPEN_ITEMS, ...TWO_SIDED_ITEMS].sort()).toEqual(
      EVERYDAY_USE_CORPUS.map((i) => i.id).sort(),
    );
    for (const item of EVERYDAY_USE_CORPUS) {
      expect(EVERYDAY_ASK_OPENNESS[item.id]).toBe(classifyAskOpenness(item));
    }
  });

  it('★ pins the unmeasured-ceiling gap rather than papering over it', () => {
    expect([...EVERYDAY_UNMEASURED_CEILING_ITEM_IDS]).toEqual(UNMEASURED_CEILING_ITEMS);
  });

  /**
   * ★ A SECOND STATED GAP, found by adding wave 2 and NOT patched.
   *
   * `proofread-school-post` bounces on "a numbered audit instead of a fixed post
   * … eleven items with rule explanations and no corrected text". That is a
   * withheld deliverable — the reply substitutes commentary for the artifact —
   * and three separate mechanisms all miss it:
   *
   *   - `WITHHELD_BOUNCE_PATTERNS` is keyed to the reply ASKING ("clarifying
   *     questions", "before writing", "it depends"). This reply asks nothing.
   *   - `deliversFirst` is keyed to the same thing, so it scores an audit 1.0.
   *   - `BLOAT_BOUNCE_PATTERNS` catches the identical failure on `sw-15`, whose
   *     bounce happens to phrase it as "a list of every correction made instead
   *     of the clean text" and matches /\ba list of\b/. The only difference
   *     between the two items is the word "list" versus the word "audit".
   *
   * That last line is the finding, and it generalises: these pattern sets are
   * quotations generalised only as far as one item's wording required, so a
   * synonym walks past them. NOT fixed here on purpose — widening the patterns
   * re-classifies items in the pinned forty, which is a deliberate change with
   * its own evidence, not a side effect of adding a corpus item. Pinned so the
   * shortfall stays visible and so widening them later has to come past it.
   */
  it('★ pins a bounce the pattern sets cannot see, rather than widening them', () => {
    const item = EVERYDAY_USE_CORPUS.find((i) => i.id === 'proofread-school-post')!;
    expect(item.bounceCondition).toContain('no corrected text');
    // Not bloat, not thin, not withheld — the audit failure is invisible to all three.
    expect(classifyAskOpenness(item)).toBe('closed');
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-proofread-school-post')!;
    expect(probe.minWords).toBeUndefined();
    // And the same failure IS caught on sw-15, purely because it says "a list of".
    const sw15 = EVERYDAY_USE_CORPUS.find((i) => i.id === 'sw-15')!;
    expect(sw15.bounceCondition).toContain('a list of every correction made');
    expect(classifyAskOpenness(sw15)).toBe('closed');
  });
});

// ─── reuse and anaphora ────────────────────────────────────────────────────

describe('preservesUserText applies only where preserving the wording IS the job', () => {
  it('pins the items expecting reuse', () => {
    expect(EVERYDAY_USE_PROBES.filter((p) => p.expectUserTextReuse).map((p) => p.id)).toEqual(
      REUSE_PROBE_IDS,
    );
  });

  it('requires all three: the words in this turn, the need, and a wording job', () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id))!;
      const expected =
        item.hasPastedContent &&
        needsFor(item.id).needs.includes('faithful-reproduction') &&
        EVERYDAY_WORDING_PRESERVATION_ITEM_IDS.includes(item.id);
      expect(probe.expectUserTextReuse === true).toBe(expected);
    }
  });

  it('★ every mechanical candidate is classified — a new one cannot join silently', () => {
    // The drift guard. `hasPastedContent` + `faithful-reproduction` is a
    // mechanical property of the corpus; which SIDE of the wording/facts split
    // an item falls on is a judgement, and judgements have to be written down.
    // Add a pasted item with that need and this fails until someone classifies it.
    const candidates = EVERYDAY_USE_CORPUS.filter(
      (item) =>
        item.hasPastedContent && needsFor(item.id).needs.includes('faithful-reproduction'),
    ).map((item) => item.id);

    expect([...EVERYDAY_WORDING_PRESERVATION_ITEM_IDS, ...FACT_REPRODUCTION_ITEMS].sort()).toEqual(
      [...candidates].sort(),
    );
    expect([...EVERYDAY_FACT_REPRODUCTION_ITEM_IDS]).toEqual(FACT_REPRODUCTION_ITEMS);
    for (const id of EVERYDAY_WORDING_PRESERVATION_ITEM_IDS) {
      expect(EVERYDAY_FACT_REPRODUCTION_ITEM_IDS).not.toContain(id);
    }
  });

  it('★ THE PARTITION: every faithful-reproduction item lands in exactly one bucket', () => {
    // The stronger form of the guard above, now that both dims exist. Three
    // buckets, and a corpus item carrying `faithful-reproduction` has to be in
    // exactly one of them:
    //
    //   wording  → preservesUserText (a long shared span IS the success)
    //   facts    → preservesFacts    (the figures survive, the prose does not)
    //   no text  → neither, because the text to preserve is in an EARLIER turn
    //
    // The third bucket is pinned rather than derived from `hasPastedContent`,
    // so an item cannot leave the classification by having that flag flipped.
    const faithful = EVERYDAY_USE_CORPUS.filter((item) =>
      needsFor(item.id).needs.includes('faithful-reproduction'),
    ).map((item) => item.id);

    const buckets = [
      ...EVERYDAY_WORDING_PRESERVATION_ITEM_IDS,
      ...EVERYDAY_FACT_REPRODUCTION_ITEM_IDS,
      ...EVERYDAY_FAITHFUL_WITHOUT_PASTED_TEXT_ITEM_IDS,
    ];

    // Covers every one of them...
    expect([...buckets].sort()).toEqual([...faithful].sort());
    // ...exactly once (no id in two buckets)...
    expect(new Set(buckets).size).toBe(buckets.length);
    // ...and nothing outside the corpus's own need list is being classified.
    for (const id of buckets) {
      expect(needsFor(id).needs).toContain('faithful-reproduction');
    }
    // The no-text bucket is exactly the items whose words are not in this turn.
    expect([...EVERYDAY_FAITHFUL_WITHOUT_PASTED_TEXT_ITEM_IDS]).toEqual(
      faithful.filter((id) => EVERYDAY_USE_CORPUS.find((i) => i.id === id)?.hasPastedContent === false),
    );
  });

  it('★ no probe is scored by BOTH dims — a reply cannot keep the wording and change it', () => {
    for (const probe of EVERYDAY_USE_PROBES) {
      expect(probe.expectUserTextReuse === true && probe.expectFactPreservation === true).toBe(false);
    }
  });

  it('★ a faithful SUMMARY is not scored by this dim at all', () => {
    // "tldr" over a group-chat thread. This output keeps every fact and entity
    // the corpus's bounce names — Tom, the £25, Friday, 7 not 8 — and reformats
    // to bullets, which is the job. Span overlap cannot tell that apart from a
    // model that copied the thread instead of compressing it, so the gate must
    // not point the dim at it: the score is null, not high and not low.
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-summarise-01')!;
    const faithfulSummary = [
      '- Tom booked the spa half-day (180) and paid on his card.',
      '- Send Tom 25 by Friday, Revolut, same number as always.',
      '- Ellie is doing the card; Priya is messaging Steve.',
      '- The surprise bit is 7, not 8.',
    ].join('\n');

    expect(probe.expectUserTextReuse).toBeUndefined();
    expect(scorePreservesUserText(probe, faithfulSummary)).toBeNull();
    // What this pass means: this dim stays silent here. It does NOT mean the
    // summary is good — whether it caught the actionable line is the judge's
    // call (taskFit), and the bounce condition in the probe's notes is the
    // criterion for it.
  });

  it('never sets it on a turn whose text lives in an earlier message', () => {
    // "shorter. and take out the sorry" carries nothing to preserve, so measuring
    // reuse against its prompt would score noise.
    const followUp = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-work-followup-shorter')!;
    expect(followUp.expectUserTextReuse).toBeUndefined();
    expect(needsFor('work-followup-shorter').needs).toContain('faithful-reproduction');
  });

  /**
   * ★ THE PROPERTY THE WIDENED GATE RESTS ON, measured rather than assumed.
   *
   * `analyzePreservesUserText` scores 0 when one copied span covers 70% or more
   * of the reply, on the reasoning that echoing the input and appending a
   * sentence is the cheapest way to satisfy a reuse metric without doing the
   * task. A proofread reply is roughly 95% the user's own text, so that guard
   * looked like it might score every correct answer in wave 2 as a zero — which
   * would be a check that fails a good answer, whatever its justification.
   *
   * It does not, and the reason is worth stating because it is not the one the
   * guard's own comment gives. That comment says the shapes this dim applies to
   * "shatter long spans" because an edit or a summary interleaves new tokens.
   * For proofreading the shatter points are THE ERRORS THEMSELVES: real writing
   * carries its mistakes distributed through it — four to twelve of them here —
   * so no gap-free stretch gets anywhere near the reply. Measured across all
   * nine wave-2 items, single-span coverage runs 0.17 to 0.43 against a 0.70
   * threshold, and every correct reply scores 1.0.
   *
   * Pinned on the tightest of the nine. If someone raises the error density
   * assumption or lowers ECHO_COVERAGE, this is where it shows up.
   */
  it('★ a CORRECT proofread reply is not mistaken for an echo', () => {
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-proofread-crew-email')!;
    const item = EVERYDAY_USE_CORPUS.find((i) => i.id === 'proofread-crew-email')!;
    const corrected = pastedBlockOf(item.userInput)
      .replace('were switching', "we're switching")
      .replace('dont hide one', "don't hide one")
      .replace('it doesnt remember', "it doesn't remember")
      .replace('dont just chuck', "don't just chuck")
      .replace('Your going to be', "You're going to be")
      .replace('getting wrote up', 'getting written up')
      .replace('If it effects', 'If it affects')
      .replace('well move it', "we'll move it")
      .replace('Id rather', "I'd rather");

    const analysis = analyzePreservesUserText(probe.prompt, corrected);
    expect(analysis.echo).toBe(false);
    expect(analysis.longestSpan / analysis.outputTokens).toBeLessThan(0.7);
    expect(scorePreservesUserText(probe, corrected)).toBe(1);
  });

  it('★ MIRROR: a wave-2 probe scores its own bounce LOW', () => {
    // Her bounce condition, quoted from the corpus: the same announcement as an
    // HR memo. Nothing of hers survives, which is the failure, and the dim has
    // to see that as far below a clean-up that keeps her wording.
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-proofread-crew-email')!;
    const bounce =
      'Please be advised that effective Monday, the pick line will transition to updated scanning hardware. Employees are required to authenticate with their badge at the start of each shift. A temporary reduction in throughput is anticipated during the adjustment period.';

    expect(scorePreservesUserText(probe, bounce)!).toBeLessThan(0.5);
  });

  it('★ MIRROR: the original gated probe still scores its own bounce LOW', () => {
    // A gate that only ever scores well is not measuring anything. sw-15 says
    // "dont change my voice"; its bounce is the same account in neutral business
    // prose. That must stay far below a clean-up that keeps their register.
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-sw-15')!;
    const bounce =
      'Upon arrival at the site at 07:00, the crew was not present. Two telephone calls were placed to Michael without response. Work on the demolition commenced at 08:30.';
    const inTheirVoice =
      "So basically what happened was we got to the site at 7 and the crew wasn't there, I called Mike twice no answer. By 8:30 I decided to start on the demo myself because we were already behind.";

    const bounceScore = scorePreservesUserText(probe, bounce)!;
    const goodScore = scorePreservesUserText(probe, inTheirVoice)!;
    expect(bounceScore).toBeLessThan(0.5);
    expect(goodScore).toBe(1);
  });
});

describe('preservesFacts applies where the WORDING is meant to change', () => {
  it('pins the probes expecting fact preservation', () => {
    expect(EVERYDAY_USE_PROBES.filter((p) => p.expectFactPreservation).map((p) => p.id)).toEqual(
      FACT_REPRODUCTION_ITEMS.map(everydayProbeId),
    );
  });

  it('requires all three: the words in this turn, the need, and a facts job', () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(item.id))!;
      const expected =
        item.hasPastedContent &&
        needsFor(item.id).needs.includes('faithful-reproduction') &&
        EVERYDAY_FACT_REPRODUCTION_ITEM_IDS.includes(item.id);
      expect(probe.expectFactPreservation === true).toBe(expected);
    }
  });

  /**
   * ★ THE DENOMINATOR, WRITTEN DOWN. Fact extraction is mechanical, but what it
   * pulls out of a real paste is a claim about that paste — so it is pinned per
   * item and can be argued with, the same way the depth bands are.
   *
   * Read it and you can see both edges of the instrument honestly:
   *
   *   - it OVER-extracts institutional Titlecase nouns ("Parent", "Guardian",
   *     "Key", "Stage", "Year", "Appendix" in the school letter), which are not
   *     things a good reply has to repeat;
   *   - it UNDER-extracts names the writer never capitalized ("steve", "nadias"
   *     in the group chat).
   *
   * Neither is hidden and neither is fatal, because the denominator is identical
   * in every arm of an A/B: over-extraction lowers both arms by the same amount
   * and cancels in the delta. It IS why the absolute level is not a grade —
   * `everyday-school-letter-esl-parent` scores about 0.2 on the corpus's own good
   * answer, and the test below pins that so nobody reads it as a failure.
   */
  const EXPECTED_FACTS: Readonly<Record<string, readonly string[]>> = {
    'work-email-tone-fix': ['monday', 'wednesday', 'friday', 'dave'],
    'rewrite-03': ['friday'],
    'school-essay-not-ai': ['macbeth', 'duncan', 'banquo', 'macduffs'],
    'health-hospital-letter': ['68', '14/7', '6', '3'],
    'school-letter-esl-parent': [
      '2', '5', '12', '45', '8',
      'october', 'friday', 'august',
      'parent', 'guardian', 'key', 'stage', 'year', 'appendix',
    ],
    'legal-rent-increase': [
      '1', '3', '1450', '1725', '31', '10',
      'september', 'august',
      'tenant', 'unit',
    ],
    'summarise-01': [
      '40', '25', '8', '200', '180', '7',
      'friday', 'thursday',
      'priya', 'tom', 'mark', 'ellie',
    ],
    'sw-13': [
      '342.19', '1208', '887.45', '412.3', '265', '3400', '118.72',
      '210', '1540.88', '305.15', '2800', '94.4',
      'october', 'november',
    ],
  };

  it('★ pins the facts extracted from every gated item', () => {
    const actual = Object.fromEntries(
      EVERYDAY_FACT_REPRODUCTION_ITEM_IDS.map((id) => {
        const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId(id))!;
        return [id, extractFacts(pastedBlockOf(probe.prompt)).map((f) => f.key)];
      }),
    );
    expect(actual).toEqual(EXPECTED_FACTS);
  });

  it('★ MIRROR: an answer that keeps the figures beats one that quietly changes them', () => {
    // health-hospital-letter bounces on "invents a detail the letter doesn't
    // contain". A dim that only ever scores well measures nothing, so the
    // invented version has to come out clearly below the faithful one.
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-health-hospital-letter')!;
    const faithful =
      'In plain words: your mum, 68, was seen at the chest clinic on 14/7. The scan found a small 6mm spot on the right lung and nothing in the lymph nodes. Her breathing tests were normal. The plan is another, lower-dose scan in 3 months to check it has not changed.';
    const invented =
      'The scan found a 6cm mass on the lung and the doctors want to rescan her in 6 weeks. They have started treatment already.';

    const faithfulScore = scoreFactPreservation(probe, faithful)!;
    const inventedScore = scoreFactPreservation(probe, invented)!;
    expect(faithfulScore).toBe(1);
    expect(inventedScore).toBeLessThan(0.5);
  });

  it('★ a plain-English translation is NOT punished for dropping the jargon', () => {
    // The failure the previous gate had: `health-hospital-letter`'s bounce is
    // "Parrots the jargon back with a definition list", and a span measure
    // REWARDED it. This dim extracts no jargon at all there — "CT", "thorax",
    // "lymphadenopathy" and "spirometry" are absent from the pinned list — so
    // translating them away costs nothing.
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-health-hospital-letter')!;
    for (const jargon of ['ct', 'thorax', 'lymphadenopathy', 'spirometry', 'subsolid']) {
      expect(EXPECTED_FACTS['health-hospital-letter']).not.toContain(jargon);
    }
    const noJargon =
      'She is 68, was seen on 14/7, and the scan showed a small 6mm spot with clear glands. They will look again in 3 months.';
    expect(scoreFactPreservation(probe, noJargon)).toBe(1);
  });

  it('★ THE HONEST LIMIT: a good, heavily compressing answer scores LOW in absolute terms', () => {
    // The school letter's own good answer is "Three simple lines" that keep the
    // £45 and the 8 August and drop everything else — including six Titlecase
    // nouns this extractor counts. It therefore scores around 0.2, and that is
    // NOT a verdict on the answer. Pinned here so the number is read as what it
    // is: a comparative readout with an inflated denominator, never a grade.
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-school-letter-esl-parent')!;
    const goodAnswer =
      'Sign the form and send it back. Pay 45 online by 8 August — that money is not refundable. The rest you pay later, in two parts. If money is hard, the school office will help quietly.';
    const bounce = 'You should contact the school for clarification.';

    const goodScore = scoreFactPreservation(probe, goodAnswer)!;
    expect(goodScore).toBeGreaterThan(scoreFactPreservation(probe, bounce)!);
    expect(goodScore).toBeLessThan(0.4);
    // The direction is right and that is what the dim is for. Whether the reply
    // caught the two things that mattered is the judge's call (taskFit), against
    // the bounce condition carried in the probe's notes.
  });

  it('never sets it on a turn whose text lives in an earlier message', () => {
    const followUp = EVERYDAY_USE_PROBES.find((p) => p.id === 'everyday-work-followup-shorter')!;
    expect(followUp.expectFactPreservation).toBeUndefined();
    expect(followUp.expectUserTextReuse).toBeUndefined();
  });
});

describe('deliversAskedArtifact is pointed only at asks for correspondence', () => {
  /**
   * The three single-turn items whose deliverable is a message, email or letter
   * the person will send. Read item by item against each one's own ask before
   * being written down — if a rule change moves this list, go and read the item,
   * do not re-copy the output.
   */
  const ARTIFACT_ASK_ITEM_IDS = ['work-email-tone-fix', 'draft-01', 'admin-gym-cancellation'];

  it('pins the annotated items, their kind and their audience', () => {
    expect(Object.keys(EVERYDAY_ARTIFACT_ASKS)).toEqual(ARTIFACT_ASK_ITEM_IDS);
    expect(
      Object.fromEntries(
        Object.entries(EVERYDAY_ARTIFACT_ASKS).map(([id, entry]) => [id, entry.kind + ' → ' + entry.audience]),
      ),
    ).toEqual({
      'work-email-tone-fix': 'email → Dave, the colleague the pasted email is already addressed to',
      'draft-01': "message → her son's class teacher",
      'admin-gym-cancellation': 'letter → the gym that has kept taking payments',
    });
  });

  it('sets the spec field on exactly those probes, and on no others', () => {
    const gated = EVERYDAY_USE_PROBES.filter((p) => p.expectsArtifact !== undefined).map((p) => p.id);
    expect(gated).toEqual(ARTIFACT_ASK_ITEM_IDS.map(everydayProbeId));
  });

  it('★ every entry quotes the corpus text it rests on', () => {
    for (const [id, entry] of Object.entries(EVERYDAY_ARTIFACT_ASKS)) {
      expect(entry.why.length, id).toBeGreaterThan(60);
    }
    for (const [id, reason] of Object.entries(EVERYDAY_UNGATED_ARTIFACT_ASKS)) {
      expect(reason.length, id).toBeGreaterThan(60);
    }
  });

  it('★ hands the audience to the judge — the half a mechanical check reads only indirectly', () => {
    const probe = EVERYDAY_USE_PROBES.find((p) => p.id === everydayProbeId('draft-01'));
    expect(probe?.notes).toContain("the deliverable is a message the person will send to her son's class teacher");
    expect(probe?.notes).toContain('not notes about it');
  });

  it('★ every mechanical candidate is classified — a new one cannot join silently', () => {
    expect(EVERYDAY_ARTIFACT_ASK_CANDIDATE_IDS).toEqual([
      'rewrite-03',
      'work-sick-text',
      'draft-01',
      'admin-gym-cancellation',
      'summarise-01',
      'proofread-grandfather-letter',
      'proofread-school-post',
    ]);
    for (const id of EVERYDAY_ARTIFACT_ASK_CANDIDATE_IDS) {
      const gated = EVERYDAY_ARTIFACT_ASKS[id] !== undefined;
      const ungated = EVERYDAY_UNGATED_ARTIFACT_ASKS[id] !== undefined;
      expect(gated !== ungated, id + ' must be classified exactly once').toBe(true);
    }
  });

  it('the two maps are disjoint and name only real corpus items', () => {
    const ids = new Set(EVERYDAY_USE_CORPUS.map((item) => item.id));
    for (const id of [
      ...Object.keys(EVERYDAY_ARTIFACT_ASKS),
      ...Object.keys(EVERYDAY_UNGATED_ARTIFACT_ASKS),
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
    for (const id of Object.keys(EVERYDAY_ARTIFACT_ASKS)) {
      expect(EVERYDAY_UNGATED_ARTIFACT_ASKS[id]).toBeUndefined();
    }
  });

  it('★ pins the stated gap: an artifact ask the instrument cannot read', () => {
    // "text my boss saying i cant come in today" is unmistakably an artifact ask
    // and is deliberately ungated, because a good two-line text carries neither
    // a salutation nor a signature. Rounding that off would be the same defect
    // as inventing a ceiling the corpus never states.
    expect(EVERYDAY_UNGATED_ARTIFACT_ASKS['work-sick-text']).toContain('A STATED GAP');
    const goodBareText = 'Not going to make it in today — food poisoning. Sorry for the short notice.';
    expect(analyzeArtifactDelivery(goodBareText).score).toBe(0);
  });
});

describe('anaphoric probes are flagged, not faked', () => {
  it('pins them, and says so in their notes', () => {
    expect([...EVERYDAY_ANAPHORIC_PROBE_IDS]).toEqual(ANAPHORIC_PROBE_IDS);
    for (const id of ANAPHORIC_PROBE_IDS) {
      expect(EVERYDAY_USE_PROBES.find((p) => p.id === id)?.notes).toContain('anaphoric turn');
    }
  });

  it('invents no history for them', () => {
    for (const probe of EVERYDAY_USE_PROBES) {
      expect(probe.history).toBeUndefined();
    }
  });
});
