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
  CANNED_LEAKAGE_PATTERNS,
  analyzeArtifactDelivery,
  analyzeDeliversFirst,
  scoreArtifactDelivery,
  analyzeFactPreservation,
  analyzePreservesUserText,
  extractFacts,
  longestCommonTokenSpan,
  scoreFactPreservation,
  pastedBlockOf,
  scoreDeliversFirst,
  scorePreservesUserText,
  tokenizeForReuse,
  scoreAnswerDepth,
  scoreCannedLeakage,
  scoreCjkLeak,
  scoreCorrectStop,
  scoreDepthMatch,
  scoreExactness,
  scoreFormat,
  scoreInstructionFollowing,
  scoreRepetition,
  scoreResult,
  scoreThinkLeakage,
  scoreUncertaintyHeuristic,
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

describe('scoreCannedLeakage', () => {
  it('returns 1.0 for clean output', () => {
    expect(scoreCannedLeakage('The capital of France is Paris.')).toBe(1);
  });

  it('penalizes "As an AI" disclaimers', () => {
    expect(scoreCannedLeakage('As an AI, I cannot have personal opinions.')).toBeLessThan(1);
  });

  it('drops by the 0.34 step per distinct hit', () => {
    // One distinct hit: 1 - 0.34 = 0.66.
    expect(scoreCannedLeakage('As an AI, here is the answer.')).toBeCloseTo(0.66);
    // Two distinct hits: 1 - 0.68 = 0.32.
    expect(scoreCannedLeakage('As an AI, I cannot provide that.')).toBeCloseTo(0.32);
    // Three distinct hits floor at 0 (1 - 1.02, clamped).
    expect(
      scoreCannedLeakage('As an AI, I cannot provide that and I do not have personal opinions.'),
    ).toBe(0);
  });

  it('penalizes chat-template / role-tag leakage', () => {
    expect(scoreCannedLeakage('<|assistant|> here is the answer')).toBeLessThan(1);
    expect(scoreCannedLeakage('assistant: here is the answer')).toBeLessThan(1);
  });

  it('never returns below 0', () => {
    const noisy =
      'As an AI, as a language model, as an artificial intelligence, I cannot provide, I cannot and will not, I do not have personal, <|system|> system: user:';
    expect(scoreCannedLeakage(noisy)).toBeGreaterThanOrEqual(0);
  });

  it('exports a non-empty pattern list', () => {
    expect(Array.isArray(CANNED_LEAKAGE_PATTERNS)).toBe(true);
    expect(CANNED_LEAKAGE_PATTERNS.length).toBeGreaterThan(0);
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

describe('scoreFormat', () => {
  it('returns null when neither requireCodeBlock nor requireJsonKeys is set', () => {
    expect(scoreFormat(spec(), 'plain text')).toBeNull();
  });

  it('passes a fenced code block when requireCodeBlock is true', () => {
    const s = spec({ requireCodeBlock: true });
    expect(scoreFormat(s, '```ts\nconst x = 1;\n```')).toBe(1);
    expect(scoreFormat(s, 'no code here')).toBe(0);
  });

  it('requires the whole reply to be one fenced block when requireOnlyCodeBlock is true', () => {
    const s = spec({ requireCodeBlock: true, requireOnlyCodeBlock: true });
    expect(scoreFormat(s, '```ts\nconst x = 1;\n```')).toBe(1);
    expect(scoreFormat(s, 'Sure:\n\n```ts\nconst x = 1;\n```')).toBe(0);
    expect(scoreFormat(s, '```ts\nconst x = 1;\n```\n\nThat is it.')).toBe(0);
  });

  it('passes valid JSON containing all required keys', () => {
    const s = spec({ requireJsonKeys: ['name', 'age'] });
    expect(scoreFormat(s, 'Here: {"name":"Sam","age":30}')).toBe(1);
  });

  it('returns 0.5 when JSON parses but is missing some keys', () => {
    const s = spec({ requireJsonKeys: ['name', 'age'] });
    expect(scoreFormat(s, '{"name":"Sam"}')).toBe(0.5);
  });

  it('returns 0 when no parseable JSON object is present', () => {
    const s = spec({ requireJsonKeys: ['name', 'age'] });
    expect(scoreFormat(s, 'name is Sam, age is 30')).toBe(0);
  });

  it('finds the first balanced object even with surrounding prose', () => {
    const s = spec({ requireJsonKeys: ['name'] });
    expect(scoreFormat(s, 'Sure! {"name":"Sam","nested":{"a":1}} done')).toBe(1);
  });
});

describe('scoreInstructionFollowing', () => {
  it('returns null when no instruction-following fields are set', () => {
    expect(scoreInstructionFollowing(spec(), 'anything')).toBeNull();
  });

  it('exactReply: 1 for exact, 0.5 for present-with-extra, 0 for absent', () => {
    const s = spec({ exactReply: 'READY' });
    expect(scoreInstructionFollowing(s, 'READY')).toBe(1);
    expect(scoreInstructionFollowing(s, 'Sure! READY')).toBe(0.5);
    expect(scoreInstructionFollowing(s, 'hello')).toBe(0);
  });

  it('exactReply: tolerates surrounding quotes / trailing punctuation', () => {
    const s = spec({ exactReply: 'READY' });
    expect(scoreInstructionFollowing(s, '"READY"')).toBe(1);
    expect(scoreInstructionFollowing(s, 'READY.')).toBe(1);
  });

  it('maxSentences: 1 when within budget, graduated when over', () => {
    const s = spec({ maxSentences: 1 });
    expect(scoreInstructionFollowing(s, 'The sky is blue because of Rayleigh scattering.')).toBe(1);
    const three = scoreInstructionFollowing(
      s,
      'One thing happens. Then a second thing. And finally a third.',
    );
    expect(three).toBeLessThan(1);
    expect(three).toBeCloseTo(1 / 3, 5);
  });

  it('requireLineCount: 1 for exact count, penalized when off by N', () => {
    const s = spec({ requireLineCount: 3 });
    expect(scoreInstructionFollowing(s, 'apple\nbanana\ncherry')).toBe(1);
    expect(scoreInstructionFollowing(s, 'apple\nbanana')).toBe(0.5);
    expect(scoreInstructionFollowing(s, 'apple')).toBe(0);
  });

  it('requireBulletLines: requires every counted line to be a bullet/list marker', () => {
    const s = spec({ requireLineCount: 3, requireBulletLines: true });
    expect(scoreInstructionFollowing(s, '- apple\n- banana\n- cherry')).toBe(1);
    expect(scoreInstructionFollowing(s, 'apple\nbanana\ncherry')).toBe(0);
    expect(scoreInstructionFollowing(s, '- apple\nbanana\n- cherry')).toBe(0);
  });

  it('forbidBullets: 1 for prose, 0 when bullet markers appear', () => {
    const s = spec({ forbidBullets: true });
    expect(scoreInstructionFollowing(s, 'Sleep helps memory. It also steadies mood.')).toBe(1);
    expect(scoreInstructionFollowing(s, '- Sleep helps memory.\n- It steadies mood.')).toBe(0);
    expect(scoreInstructionFollowing(s, '1. Sleep helps memory.\n2. It steadies mood.')).toBe(0);
  });
});

describe('scoreUncertaintyHeuristic', () => {
  it('returns null when expectDecline is not set', () => {
    expect(scoreUncertaintyHeuristic(spec(), 'anything')).toBeNull();
  });

  it('returns 1 when the reply hedges or declines', () => {
    const s = spec({ expectDecline: true });
    expect(scoreUncertaintyHeuristic(s, "I don't know what you ate this morning.")).toBe(1);
    expect(scoreUncertaintyHeuristic(s, 'I have no way to know that.')).toBe(1);
  });

  it('returns 0 when the reply confidently fabricates an answer', () => {
    const s = spec({ expectDecline: true });
    expect(scoreUncertaintyHeuristic(s, 'You ate scrambled eggs and toast.')).toBe(0);
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
    expect(scores.formatAdherence).toBeNull();
    expect(scores.instructionFollowing).toBeNull();
    expect(scores.appropriateUncertainty).toBeNull();
    // Always-computed dims are present.
    expect(scores.noRepetition).toBe(1);
    expect(scores.noCannedLeakage).toBe(1);
    expect(scores.noThinkLeakage).toBe(1);
    expect(scores.noCjkLeak).toBe(1);
    // Judge dims start null.
    expect(scores.coherence).toBeNull();
    expect(scores.taskFit).toBeNull();
    // correctStop is never null.
    expect(scores.correctStop).not.toBeNull();
  });

  it('populates the full automated set for an applicable prompt', () => {
    const s = spec({
      expectedAnswers: ['408'],
      requireJsonKeys: ['name'],
      maxSentences: 1,
      expectDecline: false,
    });
    const scores = scoreResult(s, ctx({ output: 'The answer is 408. {"name":"Sam"}' }));
    expect(scores.exactness).toBe(1);
    expect(scores.formatAdherence).toBe(1);
    expect(scores.instructionFollowing).not.toBeNull();
    // expectDecline:false → still null (heuristic only applies when expectDecline truthy)
    expect(scores.appropriateUncertainty).toBeNull();
  });

  it('flags canned leakage and think leakage from the output', () => {
    const scores = scoreResult(
      spec(),
      ctx({ output: 'As an AI, I cannot help. <think>hmm</think>' }),
    );
    expect(scores.noCannedLeakage).toBeLessThan(1);
    expect(scores.noThinkLeakage).toBe(0);
  });

  it('computes appropriateUncertainty when expectDecline is true', () => {
    const s = spec({ expectDecline: true });
    const declined = scoreResult(s, ctx({ output: "I don't know what you ate." }));
    const fabricated = scoreResult(s, ctx({ output: 'You ate eggs and toast.' }));
    expect(declined.appropriateUncertainty).toBe(1);
    expect(fabricated.appropriateUncertainty).toBe(0);
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

describe('scoreDepthMatch', () => {
  it('is null when the spec sets no depthBand', () => {
    expect(scoreDepthMatch(spec(), 'any reply at all')).toBeNull();
  });

  it('scores 1 inside the band', () => {
    const s = spec({ depthBand: { minWords: 5, maxWords: 20 } });
    expect(scoreDepthMatch(s, 'one two three four five six seven')).toBe(1);
  });

  it('penalizes under-shoot graduated (stub on a teach-me ask)', () => {
    const s = spec({ depthBand: { minWords: 100 } });
    expect(scoreDepthMatch(s, 'word '.repeat(50).trim())).toBeCloseTo(0.5);
    expect(scoreDepthMatch(s, '')).toBe(0);
  });

  it('penalizes over-shoot graduated (lecture on a simple ask)', () => {
    const s = spec({ depthBand: { maxWords: 60 } });
    expect(scoreDepthMatch(s, 'word '.repeat(120).trim())).toBeCloseTo(0.5);
    expect(scoreDepthMatch(s, 'word '.repeat(240).trim())).toBeCloseTo(0.25);
  });

  it('an unset band side never penalizes that direction', () => {
    // Floor-only: arbitrarily long is fine.
    expect(scoreDepthMatch(spec({ depthBand: { minWords: 10 } }), 'word '.repeat(500).trim())).toBe(1);
    // Ceiling-only: very short is fine.
    expect(scoreDepthMatch(spec({ depthBand: { maxWords: 80 } }), 'Canberra.')).toBe(1);
  });

  it('empty output is a floor violation, and NO SIGNAL on a ceiling-only band', () => {
    // With a floor: empty = hard 0 (the stub failure the floor exists for).
    expect(scoreDepthMatch(spec({ depthBand: { minWords: 100 } }), '')).toBe(0);
    expect(scoreDepthMatch(spec({ depthBand: { minWords: 100, maxWords: 300 } }), '  \n ')).toBe(0);
    // Ceiling-only: empty is not a "perfect non-overshoot" — it's null
    // (excluded from means); smokePass/taskFit own the empty failure.
    expect(scoreDepthMatch(spec({ depthBand: { maxWords: 80 } }), '')).toBeNull();
  });

  it('exact boundary words score 1 on both sides', () => {
    const s = spec({ depthBand: { minWords: 10, maxWords: 10 } });
    expect(scoreDepthMatch(s, 'word '.repeat(10).trim())).toBe(1);
  });

  it('flows through scoreResult as the depthMatch dim, independent of answerDepth', () => {
    const scored = scoreResult(
      spec({ depthBand: { maxWords: 10 } }),
      ctx({ output: 'word '.repeat(40).trim() }),
    );
    expect(scored.depthMatch).toBeCloseTo(0.25);
    expect(scored.answerDepth).toBeNull(); // no minWords set — dims stay independent

    const unscored = scoreResult(spec(), ctx());
    expect(unscored.depthMatch).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The two dims added for the generation-eval instrument.
//
// These tests ARE the verification for both dims: the harness runs on demand
// against a real model, so nothing in CI ever exercises them end to end. They
// are written adversarially on purpose — for each dim, the cheapest output that
// would satisfy it WITHOUT helping a user is constructed and asserted to fail.
// A dim for which that test cannot be written is a dim measuring something
// other than its name.
// ───────────────────────────────────────────────────────────────────────────

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
});

describe('scoreArtifactDelivery', () => {
  const artifact = (overrides: Partial<EvalPromptSpec> = {}): EvalPromptSpec =>
    spec({
      expectsArtifact: { kind: 'message', audience: 'the family group chat' },
      ...overrides,
    });

  const GOOD_MESSAGE = [
    'Hi all 👋 Mum’s 60th — family Sunday lunch.',
    '',
    'Sunday 8th March, 1pm, the Italian on Bridgford Road. We’ve got the back room so it’s nice and quiet.',
    '',
    '£25 each for food and a drink — just get it to me any time before the day.',
    '',
    'Just let me know if you’re coming. Cheers x',
  ].join('\n');

  it('is null unless the spec carries an artifact annotation', () => {
    expect(scoreArtifactDelivery(spec(), GOOD_MESSAGE)).toBeNull();
    expect(scoreArtifactDelivery(artifact(), GOOD_MESSAGE)).toBe(1);
  });

  it('scores 1 for a message somebody could paste', () => {
    // The corpus's own scripted reply to this turn, near enough. Emoji and all.
    const analysis = analyzeArtifactDelivery(GOOD_MESSAGE);
    expect(analysis.addressOpening).toBe('Hi all 👋');
    expect(analysis.score).toBe(1);
  });

  it('scores 0 for organiser notes, however well formatted', () => {
    const notes = [
      '**📅 MUM’S 60TH — SUNDAY 8TH MARCH**',
      '',
      '### ✅ What’s confirmed:',
      '- **Time:** 1pm',
      '- **Cost:** £25 per person',
      '',
      '### ✅ Next steps:',
      '1. Confirm attendance with everyone',
      '2. Send a reminder with the payment status',
    ].join('\n');
    expect(scoreArtifactDelivery(artifact(), notes)).toBe(0);
    // …and `deliversFirst` calls the very same reply a clean success, which is
    // the whole reason this dim exists.
    expect(analyzeDeliversFirst(notes).score).toBe(1);
  });

  it('★ the cheapest satisfying change — a salutation over a stub — FAILS', () => {
    // If a greeting alone were enough, the cheapest way to pass would be to bolt
    // one onto anything. The body floor is what forbids it.
    expect(scoreArtifactDelivery(artifact(), 'Hi everyone,\n\nAll booked!')).toBe(0);
  });

  it('★ a thin non-delivery FAILS — a short reply must be able to score 0', () => {
    expect(scoreArtifactDelivery(artifact(), 'Just hit send now.')).toBe(0);
    expect(
      scoreArtifactDelivery(artifact(), 'Send it again with the dates spelled out: Thursday and Friday.'),
    ).toBe(0);
  });

  it('★ a delivered draft inside assistant framing PASSES', () => {
    const framed = [
      'No problem — here’s the version to send:',
      '',
      '“Hi [Teacher] — copying the front office per the attendance policy. [Son] will be out',
      'Thursday and Friday for a family trip. Could you let me know if there’s anything he',
      'should take with him or make up when he’s back? Thanks so much.”',
    ].join('\n');
    expect(scoreArtifactDelivery(artifact({ expectsArtifact: { kind: 'email', audience: 'the teacher' } }), framed)).toBe(1);
  });

  it('★ signed but addressed to nobody lands in the middle, not at either end', () => {
    const announcement = [
      '**📅 MUM’S 60TH — BOOKED!**',
      '',
      'Sunday 8th March, 1pm, the Italian on Bridgford Road. Back room, away from the bar,',
      'so it will be nice and quiet for everyone. £25 each covers food and a drink, and the',
      'deposit is already paid.',
      '',
      '— *Organiser*',
    ].join('\n');
    const analysis = analyzeArtifactDelivery(announcement);
    expect(analysis.addressOpening).toBeNull();
    expect(analysis.signOff).toBe('— *Organiser*');
    expect(analysis.score).toBe(0.5);
  });

  it('does not read an assistant opener as an address to somebody', () => {
    // "there" is not an audience. A dim that thought it was would score every
    // chatty preamble as a delivered message.
    const chatty = [
      'Hi there! Happy to help with this.',
      '',
      'The main thing to decide is whether you want the deposit mentioned at all, since',
      'most of them will assume it is covered, and whether the date needs repeating.',
    ].join('\n');
    expect(analyzeArtifactDelivery(chatty).addressOpening).toBeNull();
    expect(scoreArtifactDelivery(artifact(), chatty)).toBe(0);
  });

  it('flows through scoreResult only when the spec opts in', () => {
    expect(scoreResult(artifact(), ctx({ output: GOOD_MESSAGE })).deliversAskedArtifact).toBe(1);
    expect(scoreResult(spec(), ctx({ output: GOOD_MESSAGE })).deliversAskedArtifact).toBeNull();
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

describe('scorePreservesUserText', () => {
  const PASTED_TURN =
    'fix the spelling and grammar but dont change my voice\n\nso basically what happend was we got to the site at 7 and the crew wasnt there, i called mike twice no answer.';
  const PASTED_BLOCK = pastedBlockOf(PASTED_TURN);

  const reuse = (overrides: Partial<EvalPromptSpec> = {}): EvalPromptSpec =>
    spec({ expectUserTextReuse: true, prompt: PASTED_TURN, ...overrides });

  it('is null unless the spec expects reuse', () => {
    expect(scorePreservesUserText(spec({ prompt: PASTED_TURN }), PASTED_BLOCK)).toBeNull();
  });

  it('★ an output reusing none of the user text scores 0', () => {
    expect(scorePreservesUserText(reuse(), 'Understood, everything has been noted.')).toBe(0);
  });

  it('★ cheapest satisfying change — a verbatim echo — FAILS', () => {
    // Handing the text straight back maximises reuse and does none of the work.
    const analysis = analyzePreservesUserText(PASTED_TURN, PASTED_BLOCK);
    expect(analysis.echo).toBe(true);
    expect(scorePreservesUserText(reuse(), PASTED_BLOCK)).toBe(0);
  });

  it('★ the next-cheapest — echo plus a tacked-on sentence — also FAILS', () => {
    const output = `${PASTED_BLOCK} Let me know if you want anything else.`;
    expect(analyzePreservesUserText(PASTED_TURN, output).echo).toBe(true);
    expect(scorePreservesUserText(reuse(), output)).toBe(0);
  });

  it('scores a genuine correction highly — real edits shatter the copied span', () => {
    const corrected =
      "So basically what happened was we got to the site at 7 and the crew wasn't there. I called Mike twice, no answer.";
    const analysis = analyzePreservesUserText(PASTED_TURN, corrected);
    expect(analysis.echo).toBe(false);
    expect(scorePreservesUserText(reuse(), corrected)).toBe(1);
  });

  it('reads the PASTED block, not the instruction line the user typed around it', () => {
    // Parroting the instruction is another way to look faithful while returning
    // nothing of the user's actual text.
    const parroted = 'I will fix the spelling and grammar but dont change my voice.';
    const parrotScore = scorePreservesUserText(reuse(), parroted)!;
    const realScore = scorePreservesUserText(
      reuse(),
      "So basically what happened was we got to the site at 7 and the crew wasn't there.",
    )!;
    expect(parrotScore).toBeLessThan(0.2);
    expect(realScore).toBeGreaterThan(parrotScore);
  });

  it('★ MIRROR: the proofread bounce — rewritten out of the user\'s voice — still scores LOW', () => {
    // "fix the spelling and grammar but dont change my voice", answered with the
    // neutral business prose the corpus names as the bounce. Every fact survives;
    // none of the wording does, and this dim exists to see exactly that.
    const businessProse =
      'Upon arrival at the site at 07:00, the crew was not present. Two telephone calls were placed to Michael without response.';
    const inTheirVoice =
      "So basically what happened was we got to the site at 7 and the crew wasn't there, I called Mike twice no answer.";

    const mangled = scorePreservesUserText(reuse(), businessProse)!;
    const faithful = scorePreservesUserText(reuse(), inTheirVoice)!;

    expect(mangled).toBeLessThan(0.5);
    expect(faithful).toBe(1);
    expect(faithful).toBeGreaterThan(mangled);
    // What this pass means and does not mean. It means bad outputs did not start
    // scoring well when the reference block changed — the ORDER is right and the
    // gap is wide. It does not mean the low score is zero: two texts about the
    // same morning share short runs of ordinary words ("the site at"), so this
    // measure has a floor above zero on any on-topic rewrite. And 1.0 is not a
    // grade — a reply can be excellent while quoting almost nothing, which is
    // why the dim is read as a delta between arms rather than as a level.
  });

  it('★ a trailing ask no longer floors a faithful reproduction at zero', () => {
    // The regression the block-selection fix is for: with the ask last, the
    // reference block used to be the trailing fragment, so an output carrying the
    // paste back word for word scored 0.00. (The everyday gate does not point
    // this dim at summarise-class turns; this guards the scorer, not that gate.)
    const trailingAsk =
      'Tom: right ive booked it and paid on my card, can everyone send me 25 by friday\nMark: sent\n\ntldr';
    const carriesItBack =
      'Tom booked it and paid on my card, and asks that everyone send me 25 by friday. Mark has already paid.';
    expect(
      scorePreservesUserText(reuse({ prompt: trailingAsk }), carriesItBack)!,
    ).toBeGreaterThan(0.5);
  });

  it('★ reads out a prompt-inclusive n-gram ban: n=3 caps the span at 2', () => {
    const userText = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
    // What a ban with noRepeatNgramSize=3 permits: never three consecutive
    // prompt tokens, so the longest common span is 2.
    const banned = 'alpha bravo zulu charlie delta zulu echo foxtrot zulu golf hotel zulu india juliet';
    // The same content unbanned: a whole clause comes back intact.
    const unbanned =
      'here is that line again: alpha bravo charlie delta echo foxtrot golf hotel india juliet, and that is all of it';

    expect(analyzePreservesUserText(userText, banned).longestSpan).toBe(2);
    expect(analyzePreservesUserText(userText, banned).score).toBeCloseTo(0.25);
    expect(analyzePreservesUserText(userText, unbanned).longestSpan).toBe(10);
    expect(analyzePreservesUserText(userText, unbanned).score).toBe(1);
  });

  it('keeps figures intact through tokenization', () => {
    expect(tokenizeForReuse('Deposit of £45, due 8 August (1,450.00 total).')).toEqual([
      'deposit', 'of', '£45', 'due', '8', 'august', '1,450.00', 'total',
    ]);
  });

  it('longestCommonTokenSpan finds the longest contiguous run', () => {
    expect(longestCommonTokenSpan(['a', 'b', 'c', 'd'], ['x', 'b', 'c', 'y'])).toBe(2);
    expect(longestCommonTokenSpan(['a', 'b'], ['c', 'd'])).toBe(0);
    expect(longestCommonTokenSpan([], ['a'])).toBe(0);
  });
});

describe('scoreFactPreservation', () => {
  /**
   * A pasted group chat with the ask tacked on the end — the shape the everyday
   * corpus's summarise-class items take. Kept self-contained so this block tests
   * the SCORER; the gate that points it at real corpus items, and the facts it
   * pulls from each of them, are pinned in `everyday-probes.test.ts`.
   */
  const PASTED_TURN = [
    'tldr',
    '',
    'Tom: the spa half day is 180, i can put the rest towards flowers',
    'Priya: nadias sister says the surprise bit is 7 not 8',
    'Tom: send me 25 by friday, revolut same number as always',
    'Mark: our last invoice came to 332,026 so keep the receipts',
  ].join('\n');

  const facts = (overrides: Partial<EvalPromptSpec> = {}): EvalPromptSpec =>
    spec({ expectFactPreservation: true, prompt: PASTED_TURN, ...overrides });

  it('is null unless the spec expects fact preservation', () => {
    expect(scoreFactPreservation(spec({ prompt: PASTED_TURN }), 'anything')).toBeNull();
  });

  it('★ pins what it pulls out of the paste — figures, a date, and the speakers', () => {
    // The denominator, written down. Read as a LIST: if a rule changes and an
    // entry moves, go and look at the paste rather than re-copying the output.
    expect(extractFacts(pastedBlockOf(PASTED_TURN)).map((f) => `${f.kind}:${f.key}`)).toEqual([
      'number:180',
      'number:7',
      'number:8',
      'number:25',
      'number:332026',
      'date:friday',
      'name:tom',
      'name:priya',
      'name:mark',
    ]);
  });

  it('★ (a) every fact survives a COMPLETE rewrite → 1.0', () => {
    // Not one clause of this is the user's phrasing. A span measure would score
    // it near zero; the facts are all here, which is the only thing being asked.
    const rephrased = [
      'Short version: the spa half day came to 180 and Tom paid for it on his card,',
      'so everyone owes Tom 25 by Friday. Priya passed on that the head count is 7, not 8.',
      'Mark wants the receipts kept because the last invoice came to 332,026.',
    ].join(' ');
    expect(scoreFactPreservation(facts(), rephrased)).toBe(1);
  });

  it('★ (b) ONE corrupted figure is a miss, not a match', () => {
    // The documented n-gram-ban corruption class: the number comes back mangled.
    // Scoring a near-miss as a hit is the one thing this dim must never do.
    const corrupted = [
      'Short version: the spa half day came to 180 and Tom paid for it on his card,',
      'so everyone owes Tom 25 by Friday. Priya passed on that the head count is 7, not 8.',
      'Mark wants the receipts kept because the last invoice came to 332,062.',
    ].join(' ');
    const analysis = analyzeFactPreservation(PASTED_TURN, corrupted);
    expect(analysis.missing.map((f) => f.key)).toEqual(['332026']);
    expect(scoreFactPreservation(facts(), corrupted)!).toBeLessThan(1);
    expect(scoreFactPreservation(facts(), corrupted)).toBeCloseTo(8 / 9, 10);
  });

  it('★ (c) a dropped entity is penalized', () => {
    const dropsPriya = [
      'Short version: the spa half day came to 180 and Tom paid for it on his card,',
      'so everyone owes Tom 25 by Friday. The head count is 7, not 8.',
      'Mark wants the receipts kept because the last invoice came to 332,026.',
    ].join(' ');
    expect(analyzeFactPreservation(PASTED_TURN, dropsPriya).missing.map((f) => f.key)).toEqual([
      'priya',
    ]);
    expect(scoreFactPreservation(facts(), dropsPriya)).toBeCloseTo(8 / 9, 10);
  });

  it('★ (d) a VERBATIM PARROT of the paste scores 1.0 — deliberately', () => {
    // This dim is one-sided on purpose. It answers "did their figures and names
    // survive", and in a parrot they trivially did. Parroting is a real failure,
    // and it is other dims' job: depthMatch (a summary as long as the thread
    // breaches the ceiling), preservesUserText's echo guard on the wording
    // items, and the judge. Teaching this dim to also score "and it explained
    // things well" would rebuild the spec bug that made span overlap useless
    // here — a dim that measures two things well measures neither.
    expect(scoreFactPreservation(facts(), pastedBlockOf(PASTED_TURN))).toBe(1);
  });

  it('scores an answer that carried nothing back at 0', () => {
    expect(scoreFactPreservation(facts(), 'Understood — I have summarised the thread.')).toBe(0);
  });

  it('★ MIRROR: the faithful rewrite beats the fluent one that quietly changed the numbers', () => {
    const faithful = 'Tom paid 180 for the spa day. Send Tom 25 by Friday. Priya says 7, not 8. Mark has the 332,026 invoice.';
    const fluent = 'Tom paid about 200 for the spa day. Send him 30 by the weekend. The count is 6. The invoice was roughly 330,000.';
    expect(scoreFactPreservation(facts(), faithful)!).toBeGreaterThan(
      scoreFactPreservation(facts(), fluent)!,
    );
    expect(scoreFactPreservation(facts(), fluent)!).toBeLessThan(0.5);
  });

  it('a reformatted figure is NOT a corruption — dropping a comma is not losing the number', () => {
    const turn = 'what does this say\n\nThe monthly rent will increase from $1,450.00 to $1,725.00.';
    const plain = 'The rent is going from 1450 a month to 1725 a month.';
    expect(scoreFactPreservation(facts({ prompt: turn }), plain)).toBe(1);
  });

  it('★ a ROUNDED figure IS a corruption — "One wrong number in their own data destroys trust"', () => {
    const turn =
      'put this into a table\n\noffice supplies 342.19, software subscriptions 1,208.00, travel 1,540.88, lunches 305.15, phone and internet 265.00';
    const rounded =
      'Office supplies 342.19, software 1,208.00, travel 1,540, lunches 305.15, phone 265.00.';
    expect(analyzeFactPreservation(turn, rounded).missing.map((f) => f.key)).toEqual(['1540.88']);
    expect(scoreFactPreservation(facts({ prompt: turn }), rounded)).toBeCloseTo(4 / 5, 10);
  });

  it('never reads a figure as present because it sits INSIDE a longer one', () => {
    const turn = 'what does this say\n\nThe deposit is 45 pounds.';
    expect(scoreFactPreservation(facts({ prompt: turn }), 'The deposit is 1450 pounds.')).toBe(0);
  });

  it('★ a mangled proper name is a miss: "Nobel Award" does not preserve "Nobel Prize"', () => {
    const turn = 'summarise this\n\nThe committee confirmed that Ada Lovelace received the Nobel Prize.';
    // Facts: the names. "Nobel Award" keeps three of the four and mangles one.
    expect(extractFacts(pastedBlockOf(turn)).map((f) => f.key)).toEqual([
      'ada',
      'lovelace',
      'nobel',
      'prize',
    ]);
    const mangled = 'Ada Lovelace was given the Nobel Award, the committee said.';
    expect(analyzeFactPreservation(turn, mangled).missing.map((f) => f.key)).toEqual(['prize']);
  });

  it('★ a lost space is a miss: "capital ofFrance" does not preserve "France"', () => {
    const turn = 'what does this say\n\nThe delegation met in France last spring.';
    expect(extractFacts(pastedBlockOf(turn)).map((f) => f.key)).toEqual(['france']);
    expect(scoreFactPreservation(facts({ prompt: turn }), 'They met in the capital ofFrance.')).toBe(0);
    expect(scoreFactPreservation(facts({ prompt: turn }), 'They met in France.')).toBe(1);
  });

  it('ignores ALL-CAPS jargon — a plain-English translation is supposed to drop it', () => {
    // "Her CT thorax demonstrated a 6mm subsolid nodule": requiring "CT" back
    // would penalize exactly the answer health-hospital-letter asks for.
    const turn = 'what does this say\n\nHer CT thorax demonstrated a 6mm nodule and TSH was normal.';
    expect(extractFacts(pastedBlockOf(turn)).map((f) => f.key)).toEqual(['6']);
  });

  it('drops capitalized sentence openers, and keeps a name that also appears mid-sentence', () => {
    const turn = 'what does this say\n\nThe review is done. Following that, Dave will sign it.';
    expect(extractFacts(pastedBlockOf(turn)).map((f) => f.key)).toEqual(['dave']);
  });

  it('is null when the paste carries no facts at all — no signal, not a perfect score', () => {
    const turn = 'does this sound rude\n\nplease send the files over when you get a chance';
    expect(scoreFactPreservation(facts({ prompt: turn }), 'a bit, yes')).toBeNull();
  });

  it('flows through scoreResult only when the spec opts in', () => {
    const output = 'Tom paid 180. Send 25 by Friday. Priya says 7, not 8. Mark has the 332,026 invoice.';
    expect(scoreResult(facts(), ctx({ output })).preservesFacts).toBe(1);
    expect(scoreResult(spec({ prompt: PASTED_TURN }), ctx({ output })).preservesFacts).toBeNull();
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
    expect(developed.depthMatch).toBeNull(); // an open ask has no ceiling to breach
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

  it('★ and the ceiling still bites on a closed ask — both directions, one instrument', () => {
    const CLOSED_ASK: EvalPromptSpec = {
      id: 'closed-ask',
      category: 'everyday-use',
      intent: 'quick',
      prompt: 'how long do you boil eggs for hard boiled',
      expectDeliverable: true,
      // What the derivation produces for a closed ask: a ceiling and NO floor.
      depthBand: { maxWords: 125 },
    };

    const direct = "About 10-12 minutes once the water's boiling, then straight into cold water.";
    const lecture = Array.from({ length: 60 }, (_, i) => `point ${i} about egg cookery history`).join('. ');

    expect(scoreResult(CLOSED_ASK, ctx({ output: direct })).depthMatch).toBe(1);
    expect(scoreResult(CLOSED_ASK, ctx({ output: lecture })).depthMatch!).toBeLessThan(0.5);
    // and nothing on a closed ask demands length
    expect(scoreResult(CLOSED_ASK, ctx({ output: direct })).answerDepth).toBeNull();
  });
});
