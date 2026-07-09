// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Eval-harness fixed prompt set — structural invariants.
 *
 * These guard the shape of EVAL_PROMPTS so a later harness can rely on it:
 * unique ids, valid enums, full category coverage, and well-formed
 * automated-check inputs.
 */

import { describe, expect, it } from 'vitest';
import type { ChatIntent } from '../../../lib/chat-intent';
import { EVAL_PROMPTS } from '../prompts';
import type { EvalCategory } from '../types';

const CATEGORIES: EvalCategory[] = [
  'factual-known',
  'math',
  'reasoning',
  'code',
  'summarization',
  'instruction-following',
  'uncertainty',
  'stop-behavior',
  'conversation',
  'format-json',
  'richness',
];

const INTENTS: ChatIntent[] = [
  'quick',
  'explain',
  'deep',
  'code',
  'writing',
  'file',
  'research',
];

const GEMMA_FAIR_SHOT_PROBE_IDS = ['if4', 'if5', 'if6', 'st2', 'rich5'] as const;

describe('EVAL_PROMPTS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(EVAL_PROMPTS)).toBe(true);
    expect(EVAL_PROMPTS.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = EVAL_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only uses valid categories', () => {
    for (const p of EVAL_PROMPTS) {
      expect(CATEGORIES).toContain(p.category);
    }
  });

  it('only uses valid intents', () => {
    for (const p of EVAL_PROMPTS) {
      expect(INTENTS).toContain(p.intent);
    }
  });

  it('covers every category at least once', () => {
    const present = new Set(EVAL_PROMPTS.map((p) => p.category));
    for (const c of CATEGORIES) {
      expect(present).toContain(c);
    }
  });

  it('has a non-empty prompt string for every spec', () => {
    for (const p of EVAL_PROMPTS) {
      expect(typeof p.prompt).toBe('string');
      expect(p.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it('has non-empty arrays where automated-check arrays are present', () => {
    for (const p of EVAL_PROMPTS) {
      if (p.expectedAnswers !== undefined) expect(p.expectedAnswers.length).toBeGreaterThan(0);
      if (p.forbiddenAnswers !== undefined) expect(p.forbiddenAnswers.length).toBeGreaterThan(0);
      if (p.requireJsonKeys !== undefined) expect(p.requireJsonKeys.length).toBeGreaterThan(0);
      if (p.judge !== undefined) expect(p.judge.length).toBeGreaterThan(0);
    }
  });

  it('has positive-integer counts where present', () => {
    for (const p of EVAL_PROMPTS) {
      if (p.maxSentences !== undefined) {
        expect(Number.isInteger(p.maxSentences)).toBe(true);
        expect(p.maxSentences).toBeGreaterThan(0);
      }
      if (p.requireLineCount !== undefined) {
        expect(Number.isInteger(p.requireLineCount)).toBe(true);
        expect(p.requireLineCount).toBeGreaterThan(0);
      }
      if (p.minWords !== undefined) {
        expect(Number.isInteger(p.minWords)).toBe(true);
        expect(p.minWords).toBeGreaterThan(0);
      }
    }
  });

  it('only lists valid judge dimensions', () => {
    for (const p of EVAL_PROMPTS) {
      for (const dim of p.judge ?? []) {
        expect(['coherence', 'taskFit']).toContain(dim);
      }
    }
  });

  it('includes final-gate probes for Gemma-relevant concise and stop behavior', () => {
    const byId = new Map(EVAL_PROMPTS.map((p) => [p.id, p]));

    for (const id of GEMMA_FAIR_SHOT_PROBE_IDS) {
      expect(byId.has(id), id).toBe(true);
    }

    expect(byId.get('if4')).toMatchObject({
      category: 'instruction-following',
      intent: 'quick',
      exactReply: 'yellow',
    });
    expect(byId.get('if5')).toMatchObject({
      category: 'instruction-following',
      intent: 'quick',
      forbidBullets: true,
      judge: ['taskFit'],
    });
    expect(byId.get('if6')).toMatchObject({
      category: 'instruction-following',
      intent: 'quick',
      maxSentences: 1,
      judge: ['taskFit'],
    });
    expect(byId.get('st2')).toMatchObject({
      category: 'stop-behavior',
      intent: 'quick',
      exactReply: 'DONE',
    });
    expect(byId.get('rich5')).toMatchObject({
      category: 'richness',
      intent: 'deep',
      requireLineCount: 3,
      judge: ['taskFit', 'coherence'],
    });
  });
});
