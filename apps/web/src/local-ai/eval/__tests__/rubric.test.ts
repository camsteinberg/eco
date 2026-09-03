// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eval-harness rubric — unit tests.
 *
 * Tests real scoring behavior (no mocks). Each scorer is exercised against
 * concrete inputs that mirror the cases the harness will see in practice.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeDeliversFirst,
  longestCommonTokenSpan,
  pastedBlockOf,
  scoreAnswerDepth,
  scoreCjkLeak,
  scoreCorrectStop,
  scoreDeliversFirst,
  scoreExactness,
  scoreRepetition,
  scoreResult,
  scoreThinkLeakage,
  tokenizeForReuse,
} from '../rubric';
import { AUTOMATED_DIMENSIONS } from '../aggregate';
import type { EvalPromptSpec, RubricContext, RubricScores } from '../types';

function spec(overrides: Partial<EvalPromptSpec> = {}): EvalPromptSpec {
  return {
    id: 'test',
    category: 'factual-known',
    intent: 'quick',
    prompt: 'placeholder',
    ...overrides,
  };
}

function ctx(overrides: Partial<RubricContext> = {}): RubricContext {
  return {
    output: 'A clear, complete answer that runs to a reasonable length without looping.',
    endedCleanly: true,
    hitTokenCap: false,
    ...overrides,
  };
}

describe('scoreRepetition', () => {
  it('returns 1.0 for a clean, non-repetitive answer', () => {
    const text =
      'Paris is the capital of France and one of the most visited cities in the entire world.';
    expect(scoreRepetition(text)).toBe(1);
  });

  it('returns 1.0 for very short text (too short to judge)', () => {
    expect(scoreRepetition('the cat sat')).toBe(1);
    expect(scoreRepetition('')).toBe(1);
  });

  it('scores low when a single line repeats three or more times', () => {
    const text = 'I love this.\nI love this.\nI love this.\nI love this.';
    expect(scoreRepetition(text)).toBeLessThanOrEqual(0.3);
  });

  it('★ does NOT cap the score when a Markdown divider line repeats (structure, not a loop)', () => {
    // Found scoring the 350M starter-bar arc (2026-08-01): a reply that uses
    // "---" between sections tripped the same hard cap as genuine degenerate
    // repetition, even though every line of actual content here is unique.
    const text = [
      'Revised Version',
      '---',
      'Here is the corrected paragraph with the grammar fixed for you.',
      '---',
      'Practical Takeaways',
      '---',
      'Keep sentences short and read them aloud before sending.',
    ].join('\n');
    expect(scoreRepetition(text)).toBe(1);
  });

  it('still caps the score when real content repeats, dividers aside', () => {
    const text = ['---', 'I love this.', 'I love this.', 'I love this.', 'I love this.', '---'].join(
      '\n',
    );
    expect(scoreRepetition(text)).toBeLessThanOrEqual(0.3);
  });

  it('recognizes a spaced divider variant ("- - -") for the same line-repeat exemption', () => {
    const text = [
      'The kitchen was full of golden afternoon light.',
      '- - -',
      'A quiet river bends past the old stone bridge.',
      '- - -',
      'Mountains rose sharply beyond the distant green fields.',
      '- - -',
      'Somewhere a dog barked twice and then went silent.',
    ].join('\n');
    // Not a clean 1.0: "- - -" tokenizes into three separate "-" characters,
    // so repeating it three times is a little genuine token-level repetition
    // in its own right. What matters is that it stays nowhere near the 0.3
    // hard-cap floor a mis-fired line-repeat exemption would have produced.
    expect(scoreRepetition(text)).toBeGreaterThan(0.85);
  });

  it('scores low on a degenerate repeated phrase loop', () => {
    const text = Array(12).fill('the answer is the answer is').join(' ');
    expect(scoreRepetition(text)).toBeLessThan(0.5);
  });

  it('is deterministic across calls', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve.';
    expect(scoreRepetition(text)).toBe(scoreRepetition(text));
  });
});

describe('scoreThinkLeakage', () => {
  it('returns 1 when no think tags are present', () => {
    expect(scoreThinkLeakage('The answer is 42.')).toBe(1);
  });

  it('returns 0 when a think tag leaks into the visible text', () => {
    expect(scoreThinkLeakage('<think>let me reason</think> The answer is 42.')).toBe(0);
    expect(scoreThinkLeakage('partial leak </think> tail')).toBe(0);
    expect(scoreThinkLeakage('<THINK> uppercase')).toBe(0);
  });
});

describe('scoreCjkLeak', () => {
  it('returns 0 when CJK leaks into an all-English conversation', () => {
    // The s1 artifact: a Chinese token ("甲烷" = methane) emitted mid-English.
    const s = spec({ prompt: 'Explain how greenhouse gases trap heat.' });
    expect(scoreCjkLeak(s, 'Carbon dioxide and 甲烷 trap heat.')).toBe(0);
  });

  it('penalizes leaked Hiragana, Katakana, and Hangul too (not just ideographs)', () => {
    const s = spec({ prompt: 'Say something in English.' });
    expect(scoreCjkLeak(s, 'Hello こんにちは')).toBe(0); // Hiragana
    expect(scoreCjkLeak(s, 'Hello カタカナ')).toBe(0); // Katakana
    expect(scoreCjkLeak(s, 'Hello 안녕하세요')).toBe(0); // Hangul
  });

  it('returns 1 when CJK in the OUTPUT is legitimate (the PROMPT contains CJK)', () => {
    const s = spec({ prompt: '“methane” を日本語で説明してください。' });
    expect(scoreCjkLeak(s, 'メタンは温室効果ガスです。')).toBe(1);
  });

  it('returns 1 when CJK appears anywhere in the prompt-side history', () => {
    const s = spec({
      prompt: 'And the next one?',
      history: [
        { role: 'user', content: '日本語で答えて。' },
        { role: 'assistant', content: 'はい。' },
      ],
    });
    expect(scoreCjkLeak(s, '次は猫です。')).toBe(1);
  });

  it('returns 1 for clean English in / English out', () => {
    const s = spec({ prompt: 'What is the capital of France?' });
    expect(scoreCjkLeak(s, 'The capital of France is Paris.')).toBe(1);
  });

  it('does NOT trip on emoji or Latin accents (those are not CJK)', () => {
    const s = spec({ prompt: 'Reply warmly.' });
    expect(scoreCjkLeak(s, 'Café au lait, naïve résumé — 🌿✨ enjoy!')).toBe(1);
  });

  it('does NOT trip on CJK punctuation/symbols alone (only ideographs/kana/hangul count)', () => {
    // Fullwidth comma (U+FF0C) and ideographic space (U+3000) are punctuation,
    // not script characters — a stray one is not the leak class we guard.
    const s = spec({ prompt: 'List two items.' });
    expect(scoreCjkLeak(s, 'apples，oranges')).toBe(1);
  });

  it('flows through scoreResult as the noCjkLeak dim', () => {
    const leaked = scoreResult(
      spec({ prompt: 'Explain greenhouse gases.' }),
      ctx({ output: 'Carbon dioxide and 甲烷 trap heat.' }),
    );
    expect(leaked.noCjkLeak).toBe(0);

    const clean = scoreResult(spec(), ctx());
    expect(clean.noCjkLeak).toBe(1);
  });
});

describe('scoreExactness', () => {
  it('returns null when the spec has no expectedAnswers', () => {
    expect(scoreExactness(spec(), 'anything')).toBeNull();
  });

  it('returns 1 when an expected whole-token answer is present', () => {
    expect(scoreExactness(spec({ expectedAnswers: ['paris'] }), 'The capital is Paris.')).toBe(1);
  });

  it('matches the number 408 as a whole token but NOT inside 1408', () => {
    const m1 = spec({ expectedAnswers: ['408'] });
    expect(scoreExactness(m1, 'The answer is 408.')).toBe(1);
    expect(scoreExactness(m1, 'The answer is 1408.')).toBe(0);
  });

  it('returns 0 when no expected answer matches', () => {
    expect(scoreExactness(spec({ expectedAnswers: ['paris'] }), 'I think it is London.')).toBe(0);
  });

  it('returns 0.5 when both an expected AND a forbidden answer match', () => {
    const batBall = spec({
      expectedAnswers: ['0.05', '5 cents', 'five cents'],
      forbiddenAnswers: ['0.10', '10 cents', 'ten cents'],
    });
    // Classic wrong + right both stated.
    const both = scoreExactness(batBall, 'The ball costs 10 cents, so really 5 cents.');
    expect(both).toBe(0.5);
  });

  it('the forbidden "10 cents" alone pulls a wrong answer to 0', () => {
    const batBall = spec({
      expectedAnswers: ['0.05', '5 cents', 'five cents'],
      forbiddenAnswers: ['0.10', '10 cents', 'ten cents'],
    });
    expect(scoreExactness(batBall, 'The ball costs 10 cents.')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(scoreExactness(spec({ expectedAnswers: ['shakespeare'] }), 'By SHAKESPEARE.')).toBe(1);
  });

  it('escapes regex-special characters in expected answers (crash-safe + literal match)', () => {
    // A currency token with a regex-special "$" and "." must match literally.
    expect(scoreExactness(spec({ expectedAnswers: ['$0.05'] }), 'it costs $0.05')).toBe(1);
    // Tokens containing regex metacharacters must not throw and must match their literal form.
    expect(() => scoreExactness(spec({ expectedAnswers: ['(a+b)'] }), 'the result is (a+b)')).not.toThrow();
    expect(scoreExactness(spec({ expectedAnswers: ['(a+b)'] }), 'the result is (a+b)')).toBe(1);
    expect(() => scoreExactness(spec({ expectedAnswers: ['c++'] }), 'written in c++')).not.toThrow();
    expect(scoreExactness(spec({ expectedAnswers: ['c++'] }), 'written in c++')).toBe(1);
  });
});

describe('tokenizeForReuse / longestCommonTokenSpan', () => {
  // Both are exported for `diagnostics/backend-crosscheck.ts`, which measures the
  // longest run two backends agree on. Their contract is pinned here because
  // that consumer reads the number rather than asserting on it.
  it('tokenizes on words, lowercased, punctuation dropped', () => {
    expect(tokenizeForReuse('The quick, Brown fox!')).toEqual(['the', 'quick', 'brown', 'fox']);
  });

  it('measures the longest contiguous shared run, not total overlap', () => {
    const a = tokenizeForReuse('alpha beta gamma delta epsilon');
    const b = tokenizeForReuse('zulu beta gamma delta yankee alpha');
    expect(longestCommonTokenSpan(a, b)).toBe(3);
  });

  it('is 0 when nothing is shared', () => {
    expect(longestCommonTokenSpan(tokenizeForReuse('one two'), tokenizeForReuse('three four'))).toBe(0);
  });
});

describe('scoreCorrectStop', () => {
  it('returns 1.0 on a clean stop with no repetition', () => {
    expect(scoreCorrectStop(spec(), ctx())).toBe(1);
  });

  it('returns 0.0 on a repetition runaway', () => {
    const runaway = ctx({
      output: 'I love this.\nI love this.\nI love this.\nI love this.',
      endedCleanly: true,
    });
    expect(scoreCorrectStop(spec(), runaway)).toBe(0);
  });

  it('returns 0.5 when generation hit the token cap', () => {
    expect(scoreCorrectStop(spec(), ctx({ hitTokenCap: true }))).toBe(0.5);
  });

  it('returns 0.7 when ended cleanly with mild repetition', () => {
    // Mild repetition: scoreRepetition lands in [0.3, 0.5) — not clean, not a runaway.
    const mild = 'one two three one two three one two three four five six seven eight';
    expect(scoreRepetition(mild)).toBeGreaterThanOrEqual(0.3);
    expect(scoreRepetition(mild)).toBeLessThan(0.5);
    expect(scoreCorrectStop(spec(), ctx({ output: mild }))).toBe(0.7);
  });
});

describe('scoreResult', () => {
  it('returns nulls for non-applicable conditional dims', () => {
    const scores = scoreResult(spec(), ctx());
    expect(scores.exactness).toBeNull();
    expect(scores.answerDepth).toBeNull();
    expect(scores.deliversFirst).toBeNull();
    expect(scores.preservesHistoryFacts).toBeNull();
    expect(scores.honorsRuledOut).toBeNull();
    // Always-computed dims are present.
    expect(scores.noRepetition).toBe(1);
    expect(scores.noThinkLeakage).toBe(1);
    expect(scores.noCjkLeak).toBe(1);
    // Judge dims start null.
    expect(scores.coherence).toBeNull();
    expect(scores.taskFit).toBeNull();
    // correctStop is never null.
    expect(scores.correctStop).not.toBeNull();
  });

  it('populates exactness for an applicable prompt', () => {
    const s = spec({ expectedAnswers: ['408'] });
    const scores = scoreResult(s, ctx({ output: 'The answer is 408.' }));
    expect(scores.exactness).toBe(1);
  });

  it('flags think leakage from the output', () => {
    const scores = scoreResult(spec(), ctx({ output: 'Sure. <think>hmm</think>' }));
    expect(scores.noThinkLeakage).toBe(0);
  });
});

// ─── scoreAnswerDepth (chat #7 richness floor) ─────────────────────────────

describe('scoreAnswerDepth', () => {
  it('is null when the spec sets no minWords', () => {
    expect(scoreAnswerDepth(spec(), 'short reply')).toBeNull();
  });

  it('scores 1 at or above the floor (verbosity beyond it is never rewarded)', () => {
    const s = spec({ minWords: 10 });
    expect(scoreAnswerDepth(s, 'one two three four five six seven eight nine ten')).toBe(1);
    expect(scoreAnswerDepth(s, 'word '.repeat(500))).toBe(1);
  });

  it('scores graduated below the floor', () => {
    const s = spec({ minWords: 60 });
    expect(scoreAnswerDepth(s, 'word '.repeat(30).trim())).toBeCloseTo(0.5);
  });

  it('scores 0 for an empty reply', () => {
    expect(scoreAnswerDepth(spec({ minWords: 60 }), '')).toBe(0);
  });

  it('flows through scoreResult as the answerDepth dim', () => {
    const terse = scoreResult(
      spec({ minWords: 60 }),
      ctx({ output: 'Practice more.' }),
    );
    expect(terse.answerDepth).toBeLessThan(0.1);

    const noFloor = scoreResult(spec(), ctx());
    expect(noFloor.answerDepth).toBeNull();
  });
});

// ─── scoreDepthMatch (Wave 2.6 answer-shape band) ───────────────────────────

describe('scoreDeliversFirst', () => {
  const delivers = (overrides: Partial<EvalPromptSpec> = {}): EvalPromptSpec =>
    spec({ expectDeliverable: true, ...overrides });

  it('is null unless the spec expects a deliverable', () => {
    expect(scoreDeliversFirst(spec(), 'What is your name?')).toBeNull();
  });

  it('scores 1 when nothing is asked of the user', () => {
    const output = "About 10-12 minutes once the water's boiling, then straight into cold water.";
    expect(scoreDeliversFirst(delivers(), output)).toBe(1);
    expect(analyzeDeliversFirst(output).requestCount).toBe(0);
  });

  it('★ a two-word preamble does NOT flip it', () => {
    const output = [
      'Sure —',
      '',
      'Hi Dave, following up on the client deck we discussed on Monday.',
      'It was due Wednesday and I have not received it yet — could you send it across today?',
    ].join('\n');

    const analysis = analyzeDeliversFirst(output);
    expect(analysis.requestCount).toBeGreaterThan(0); // the draft does contain a question
    expect(analysis.deliverableBeforeFirstRequest).toBe(true);
    expect(scoreDeliversFirst(delivers(), output)).toBe(1);
  });

  it('scores 0 when it asks and never delivers', () => {
    const output =
      "Before I write this, what's your working relationship with Dave like? And how formal is your team?";
    expect(scoreDeliversFirst(delivers(), output)).toBe(0);
  });

  it('★ cheapest satisfying change — filler ahead of the questions — FAILS', () => {
    // The cheapest way to pass a naive "some words before the question" check is
    // to pad with pleasantries. It buys the user nothing, so it must score 0.
    const output =
      "Of course, I'd be absolutely delighted to help you with this today. What's your dog's name? What breed is he, and how old?";

    const analysis = analyzeDeliversFirst(output);
    expect(analysis.deliverableBeforeFirstRequest).toBe(false);
    expect(analysis.deliverableAfterFirstRequest).toBe(false);
    expect(scoreDeliversFirst(delivers(), output)).toBe(0);
  });

  it('★ dropping the question mark does not launder an interrogation', () => {
    // The other cheap satisfier: ask without asking. A '?'-only implementation
    // scores this 1.
    const output = 'Of course. Tell me his name and breed first.';
    expect(scoreDeliversFirst(delivers(), output)).toBe(0);
  });

  it('scores 0.5 when it asks first but still delivers in the same turn', () => {
    const output = [
      "What's his name?",
      "Here's one you can use in the meantime:",
      '',
      'He waits beside the door each afternoon,',
      'a small brown shadow humming like a tune,',
      'and when the key turns he forgets the day,',
      'the hours he spent just waiting for the play.',
    ].join('\n');
    expect(scoreDeliversFirst(delivers(), output)).toBe(0.5);
  });

  it('does not read a rhetorical question inside the answer as an interrogation', () => {
    const output =
      'Keep, flip, multiply: 3/4 divided by 1/2 becomes 3/4 times 2/1, which is 6/4, or one and a half. How many halves fit into three quarters? One and a half of them, which is why the answer comes out bigger than most people expect.';
    expect(analyzeDeliversFirst(output).requestCount).toBe(0);
    expect(scoreDeliversFirst(delivers(), output)).toBe(1);
  });

  it('counts a table as a deliverable whatever its length', () => {
    const output = [
      '| Category | Oct | Nov |',
      '| --- | --- | --- |',
      '| Travel | 887.45 | 1,540.88 |',
      '',
      'Do you want a totals row as well?',
    ].join('\n');
    expect(scoreDeliversFirst(delivers(), output)).toBe(1);
  });

  it('flows through scoreResult only when the spec opts in', () => {
    const asked = 'What would you like me to do?';
    expect(scoreResult(delivers(), ctx({ output: asked })).deliversFirst).toBe(0);
    expect(scoreResult(spec(), ctx({ output: asked })).deliversFirst).toBeNull();
  });

  it('★ an interrogation phrased without "you" is still an interrogation', () => {
    // `isUserRequest` reads a question as an ask only when it also says "you", so
    // none of these four register as requests — and a branch that returned 1.0
    // whenever nothing was recognized as a request scored this, the single most
    // common bounce shape in the corpus, a perfect mark.
    const output =
      "What's the occasion? How many people? Any dietary requirements? What sort of budget per head?";
    expect(analyzeDeliversFirst(output).requestCount).toBe(0);
    expect(scoreDeliversFirst(delivers(), output)).toBe(0);
  });

  it('★ a reply that handed the user nothing at all scores 0, not 1', () => {
    expect(scoreDeliversFirst(delivers(), '')).toBe(0);
    expect(scoreDeliversFirst(delivers(), '   \n  ')).toBe(0);
    // Pleasantries only: the filler stripper leaves no content behind.
    expect(scoreDeliversFirst(delivers(), 'Sure! Of course.')).toBe(0);
  });

  it('★ THE OTHER SIDE: a short, complete answer is not empty-handed', () => {
    // The two-sided constraint. The empty-handed test asks whether ANY content
    // survived, never whether there was enough of it — a five-word answer to a
    // closed question is complete, and a dim that failed it would be paying for
    // length. `answerDepth` owns "too thin", and only where the ask invites it.
    for (const answer of [
      'Boil them for seven minutes.',
      'Yes.',
      'It is 12 miles.',
      'Yes — the second one.',
      'About four hours, door to door.',
    ]) {
      expect(scoreDeliversFirst(delivers(), answer), answer).toBe(1);
    }
  });
});

describe('pastedBlockOf', () => {
  it('returns the whole turn when nothing was pasted alongside it', () => {
    const typed = 'how do i say "the appointment is at 3" in spanish';
    expect(pastedBlockOf(typed)).toBe(typed);
  });

  it('drops the typed ask when it leads', () => {
    const turn = 'does this sound rude\n\nPer my last email, the deadline was Friday.';
    expect(pastedBlockOf(turn)).toBe('Per my last email, the deadline was Friday.');
  });

  it('★ drops the typed ask when it TRAILS — a short fragment is not the paste', () => {
    // The shape that scored a faithful reply at zero: a pasted thread with the
    // ask tacked on the end. Taking the last block hands back "tldr", and an
    // overlap measured against one word is near zero however good the answer is.
    const turn = [
      'Priya: ok so for nadias 40th are we doing a group gift',
      'Tom: yes ill sort it like last time',
      'Mark: whats the budget',
      'Tom: 25 each? theres 8 of us so 200',
      '',
      'tldr',
    ].join('\n');
    const block = pastedBlockOf(turn);
    expect(block).toContain('nadias 40th');
    expect(block).toContain('25 each');
    expect(block).not.toContain('tldr');
  });

  it('keeps every paragraph of a multi-paragraph paste, greeting and sign-off included', () => {
    const turn =
      'can u make this sound less passive aggressive\n\nHi Dave,\n\nThe deck was due Wednesday and it is now Friday.\n\nPlease advise.\n\nSarah';
    expect(pastedBlockOf(turn)).toBe(
      'Hi Dave,\n\nThe deck was due Wednesday and it is now Friday.\n\nPlease advise.\n\nSarah',
    );
  });

  it('keeps the whole turn when neither end is the minority — over-including is the safe error', () => {
    // Two blocks of comparable size: nothing here identifies one as the ask, and
    // a wrong guess would DROP the words a caller is looking for. Including the
    // ask can only lengthen a match, so the fallback is the whole turn.
    const turn = 'first block of roughly this many words here\n\nsecond block of roughly that many words too';
    expect(pastedBlockOf(turn)).toBe(turn);
  });
});

describe('★ the instrument is two-sided: terseness must not pay', () => {
  // The product worry, as a test. "'What is France like' is a simple question,
  // but the user is curious about day-to-day life, the food, the culture." An
  // instrument that only detects over-length optimises us into terseness, so a
  // short, direct, unhelpfully thin reply has to score BADLY — not neutrally.
  //
  // ★★ AND READ THE DIMS, NEVER THE COMPOSITE. The unweighted mean is dominated
  // by guard dims sitting at 1.0 on any well-formed reply, so the thin/developed
  // gap collapses from 0.733 on `answerDepth` to 0.105 on the composite — which
  // reads as noise and ships terseness. The last test in this block pins that
  // dilution so the warning in `aggregate.resultComposite` cannot quietly stop
  // being true. It is NOT fixed by reweighting: weights picked to make a number
  // come out right are an unfounded counterweight.
  const OPEN_ASK: EvalPromptSpec = {
    id: 'open-ask',
    category: 'everyday-use',
    intent: 'explain',
    prompt: 'what is france like',
    expectDeliverable: true,
    // What the probe derivation produces for an open ask: a richness floor and
    // NO ceiling. Nothing in the instrument can reward brevity here.
    minWords: 60,
  };

  const THIN = 'France is a country in Western Europe. It is known for its food and its culture.';
  const DEVELOPED = [
    'France is big enough that it feels like several countries stitched together.',
    'Paris runs on cafés, museums and a fast métro; the Alps are for snow and long walks;',
    'Provence smells of lavender and moves at half the speed.',
    'Food is the daily backbone rather than an occasion — bread bought fresh, markets on set',
    'mornings, lunch taken seriously. People can seem reserved at first and then turn out warm',
    'once you have said bonjour properly, which matters more than visitors expect. Trains make',
    'the whole place easy to cross without a car. One honest caveat: August empties the cities,',
    'and plenty of small shops simply shut for the month.',
  ].join(' ');

  it('scores a thin, direct, unhelpful reply badly', () => {
    const thin = scoreResult(OPEN_ASK, ctx({ output: THIN }));
    expect(thin.answerDepth).toBeLessThan(0.35);
    // It is not caught by anything else: it delivers, it does not loop, it leaks
    // nothing. The richness floor is the ONLY dim that sees this failure.
    expect(thin.deliversFirst).toBe(1);
    expect(thin.noRepetition).toBe(1);
  });

  it('scores the developed reply full marks on the same ask', () => {
    const developed = scoreResult(OPEN_ASK, ctx({ output: DEVELOPED }));
    expect(developed.answerDepth).toBe(1);
  });

  it('★ no automated dim rewards the thin reply over the developed one', () => {
    const thin = scoreResult(OPEN_ASK, ctx({ output: THIN }));
    const developed = scoreResult(OPEN_ASK, ctx({ output: DEVELOPED }));

    for (const dim of AUTOMATED_DIMENSIONS) {
      const thinScore = thin[dim];
      const developedScore = developed[dim];
      if (thinScore === null || developedScore === null) continue;
      expect(
        thinScore,
        `dim "${dim}" pays for terseness: thin ${thinScore} > developed ${developedScore}`,
      ).toBeLessThanOrEqual(developedScore);
    }
  });

  it('★ the COMPOSITE cannot resolve it — the dilution, pinned', () => {
    const composite = (s: RubricScores): number => {
      const applicable = AUTOMATED_DIMENSIONS.map((d) => s[d]).filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      );
      return applicable.reduce((a, v) => a + v, 0) / applicable.length;
    };

    const thin = scoreResult(OPEN_ASK, ctx({ output: THIN }));
    const developed = scoreResult(OPEN_ASK, ctx({ output: DEVELOPED }));

    // Measured: thin 16 words → answerDepth 0.267, composite 0.895;
    //           developed 110 words → 1.000, 1.000.
    const answerDepthGap = developed.answerDepth! - thin.answerDepth!;
    const compositeGap = composite(developed) - composite(thin);

    expect(answerDepthGap).toBeGreaterThan(0.7);
    expect(compositeGap).toBeLessThan(0.15);
    // ★ The dilution itself: the mean shrinks a four-to-one failure into a
    // rounding error. Asserted as a ratio so that adding another always-1.0
    // guard dim — which makes this WORSE — cannot slip by unnoticed.
    expect(compositeGap).toBeLessThan(answerDepthGap / 4);
  });

});
