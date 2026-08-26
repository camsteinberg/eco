// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { inferChatIntent } from '../../../lib/chat-intent';
import { KNOWN_ANSWER_PROBES, KNOWN_ANSWER_PROBE_IDS } from '../known-answer-probes';
import { scoreExactness } from '../rubric';

describe('known-answer probe set', () => {
  it('is a real set: every entry is known-answer with a non-empty expectedAnswers', () => {
    expect(KNOWN_ANSWER_PROBES.length).toBeGreaterThanOrEqual(30);
    for (const spec of KNOWN_ANSWER_PROBES) {
      expect(spec.category).toBe('known-answer');
      expect(spec.prompt.trim().length).toBeGreaterThan(0);
      expect(spec.expectedAnswers && spec.expectedAnswers.length).toBeGreaterThan(0);
    }
  });

  it('has unique ka-prefixed ids that match the exported id set', () => {
    const ids = KNOWN_ANSWER_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ka-[a-z0-9-]+$/);
    expect(KNOWN_ANSWER_PROBE_IDS).toEqual(new Set(ids));
  });

  it('cannot be passed by parroting the prompt: each prompt scored as a reply gets 0', () => {
    for (const spec of KNOWN_ANSWER_PROBES) {
      expect(scoreExactness(spec, spec.prompt), `${spec.id} leaks its answer in the prompt`).toBe(0);
    }
  });

  it('keeps intent in lockstep with the live router', () => {
    for (const spec of KNOWN_ANSWER_PROBES) {
      expect(spec.intent, `${spec.id} routes differently than its spec.intent`).toBe(
        inferChatIntent(spec.prompt),
      );
    }
  });

  it('never forbids a value that is also expected', () => {
    for (const spec of KNOWN_ANSWER_PROBES) {
      const expected = new Set(spec.expectedAnswers);
      for (const f of spec.forbiddenAnswers ?? []) expect(expected.has(f)).toBe(false);
    }
  });

  it('scores the replies the first real read produced the way a person would', () => {
    const byId = new Map(KNOWN_ANSWER_PROBES.map((p) => [p.id, p]));
    const train = byId.get('ka-time-1')!;
    expect(scoreExactness(train, 'It arrives at 4:05pm.')).toBe(1);
    expect(scoreExactness(train, 'Your train arrives at 4:05 PM')).toBe(1);
    expect(scoreExactness(train, 'It arrives at 16:05.')).toBe(1);
    expect(scoreExactness(train, "It's 10:00 PM.")).toBe(0);
    expect(scoreExactness(train, 'The train arrives at 12:42 AM.')).toBe(0);

    const apr = byId.get('ka-money-7')!;
    expect(scoreExactness(apr, 'APR stands for Annual Percentage Rate — the yearly cost of borrowing.')).toBe(1);
    expect(scoreExactness(apr, 'APR is the Annual Percentage Ratio applied to your income.')).toBe(0);
    expect(
      scoreExactness(apr, 'APR (Annual Percentage Rate, sometimes misread as Annual Percentage Ratio)'),
    ).toBe(0.5);

    const ball = byId.get('ka-money-6')!;
    expect(scoreExactness(ball, 'The ball costs $0.05.')).toBe(1);
    expect(scoreExactness(ball, 'The ball costs $0.10.')).toBe(0);

    const tip = byId.get('ka-money-2')!;
    expect(scoreExactness(tip, 'A 20% tip on $84 is $16.80.')).toBe(1);
    expect(scoreExactness(tip, 'That would be $16.')).toBe(0);
  });
});
