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
import type { EvalPromptSpec, RubricContext } from '../types';

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
