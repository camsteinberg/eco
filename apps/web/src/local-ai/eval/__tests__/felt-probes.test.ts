// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Durable felt probe set — structural invariants.
 *
 * These probes are deliberately small and user-job-based. They graduate real
 * felt failure classes into the default eval pool without turning the harness
 * into an unbounded capture dump or a Gemma-only overfit suite.
 */

import { describe, expect, it } from 'vitest';
import { inferChatIntent } from '../../../lib/chat-intent';
import { FELT_PROBES } from '../felt-probes';
import { EVAL_PROMPTS } from '../prompts';
import { SHAPE_PROBES, SHAPE_RESEARCH_ARMS } from '../shape-probes';
import type { EvalPromptSpec } from '../types';

const EXPECTED_FELT_IDS = [
  'felt-exact-one-word',
  'felt-warm-one-sentence',
  'felt-current-weather-honesty',
  'felt-followup-three-bullets',
  'felt-code-only-typescript',
  'felt-brief-fact-no-lecture',
  'felt-teach-not-thin',
  'felt-multiturn-first-step',
  'felt-greeting-hello-no-echo',
  'felt-greeting-hi-no-echo',
  'felt-thanks-no-echo',
  'felt-identity-what-are-you',
  'felt-identity-data-location',
  'felt-identity-name',
  'felt-identity-not-chatgpt',
] as const;

const IDENTITY_PROBE_IDS = [
  'felt-identity-what-are-you',
  'felt-identity-data-location',
  'felt-identity-name',
  'felt-identity-not-chatgpt',
] as const;

const SOCIAL_PROBE_IDS = [
  'felt-greeting-hello-no-echo',
  'felt-greeting-hi-no-echo',
  'felt-thanks-no-echo',
] as const;

const CONDITIONAL_SCORING_FIELDS: Array<keyof EvalPromptSpec> = [
  'expectedAnswers',
  'forbiddenAnswers',
  'exactReply',
  'maxSentences',
  'requireLineCount',
  'forbidBullets',
  'requireCodeBlock',
  'requireOnlyCodeBlock',
  'requireBulletLines',
  'requireJsonKeys',
  'expectDecline',
  'minWords',
  'depthBand',
];

describe('FELT_PROBES', () => {
  it('is non-empty, curated, and stable', () => {
    expect(FELT_PROBES.map((p) => p.id)).toEqual([...EXPECTED_FELT_IDS]);
    expect(FELT_PROBES.length).toBeGreaterThan(0);
    expect(FELT_PROBES.length).toBeLessThanOrEqual(16);
  });

  it('uses unique ids across the entire default prompt pool and research arms', () => {
    const ids = [...EVAL_PROMPTS, ...SHAPE_PROBES, ...SHAPE_RESEARCH_ARMS, ...FELT_PROBES].map(
      (p) => p.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps intent labels in lockstep with the live router unless explicitly forced', () => {
    for (const probe of FELT_PROBES) {
      if (probe.forcedIntent) continue;
      expect(
        inferChatIntent(probe.prompt, { hasPriorTurns: (probe.history?.length ?? 0) > 0 }),
        `${probe.id} ("${probe.prompt}") routes differently than its spec.intent — re-derive the label or mark forcedIntent`,
      ).toBe(probe.intent);
    }
  });

  it('documents user value and carries judge-backed scoring signals', () => {
    for (const probe of FELT_PROBES) {
      expect(probe.notes, probe.id).toContain('User job:');
      expect(probe.notes?.trim().length, probe.id).toBeGreaterThan(80);
      expect(probe.judge ?? [], probe.id).toContain('taskFit');
      expect(
        CONDITIONAL_SCORING_FIELDS.some((field) => probe[field] !== undefined),
        `${probe.id} should expose at least one automated scoring signal beyond always-on leakage/stop checks`,
      ).toBe(true);
    }
  });

  it('keeps automated-check fields well-formed', () => {
    for (const probe of FELT_PROBES) {
      if (probe.expectedAnswers !== undefined) expect(probe.expectedAnswers.length, probe.id).toBeGreaterThan(0);
      if (probe.forbiddenAnswers !== undefined) expect(probe.forbiddenAnswers.length, probe.id).toBeGreaterThan(0);
      if (probe.requireJsonKeys !== undefined) expect(probe.requireJsonKeys.length, probe.id).toBeGreaterThan(0);
      if (probe.judge !== undefined) expect(probe.judge.length, probe.id).toBeGreaterThan(0);

      if (probe.maxSentences !== undefined) {
        expect(Number.isInteger(probe.maxSentences), probe.id).toBe(true);
        expect(probe.maxSentences, probe.id).toBeGreaterThan(0);
      }
      if (probe.requireLineCount !== undefined) {
        expect(Number.isInteger(probe.requireLineCount), probe.id).toBe(true);
        expect(probe.requireLineCount, probe.id).toBeGreaterThan(0);
      }
      if (probe.minWords !== undefined) {
        expect(Number.isInteger(probe.minWords), probe.id).toBe(true);
        expect(probe.minWords, probe.id).toBeGreaterThan(0);
      }
      if (probe.depthBand !== undefined) {
        const { minWords, maxWords } = probe.depthBand;
        if (minWords !== undefined) expect(minWords, probe.id).toBeGreaterThan(0);
        if (maxWords !== undefined) expect(maxWords, probe.id).toBeGreaterThan(0);
        if (minWords !== undefined && maxWords !== undefined) {
          expect(minWords, probe.id).toBeLessThanOrEqual(maxWords);
        }
      }
    }
  });

  it('covers the Phase 2 user-job battery without duplicating the generic prompt set', () => {
    const byId = new Map(FELT_PROBES.map((p) => [p.id, p]));

    expect(byId.get('felt-exact-one-word')).toMatchObject({ exactReply: 'yellow' });
    expect(byId.get('felt-warm-one-sentence')).toMatchObject({ maxSentences: 1, forbidBullets: true });
    expect(byId.get('felt-current-weather-honesty')).toMatchObject({ expectDecline: true });
    expect(byId.get('felt-followup-three-bullets')).toMatchObject({
      requireLineCount: 3,
      requireBulletLines: true,
    });
    expect(byId.get('felt-code-only-typescript')).toMatchObject({
      requireCodeBlock: true,
      requireOnlyCodeBlock: true,
    });
    expect(byId.get('felt-brief-fact-no-lecture')).toMatchObject({ expectedAnswers: ['origin private file system'] });
    expect(byId.get('felt-teach-not-thin')).toMatchObject({ minWords: 120 });
    expect(byId.get('felt-multiturn-first-step')?.history?.length).toBeGreaterThan(0);
  });

  it('identity probes guard the on-device/private facts via judge + forbidden invented ids', () => {
    const byId = new Map(FELT_PROBES.map((p) => [p.id, p]));
    for (const id of IDENTITY_PROBE_IDS) {
      const probe = byId.get(id);
      expect(probe, id).toBeDefined();
      // Judge on claim truth — never a whole-answer regex.
      expect(probe!.judge, id).toContain('taskFit');
      // Every identity probe carries the forbidden invented-identity guard…
      expect(probe!.forbiddenAnswers?.length, id).toBeGreaterThan(0);
      // …and an over-answer net (identity questions deserve a short reply).
      expect(probe!.depthBand?.maxWords, id).toBeGreaterThan(0);
    }
    // The data-location probe judges the claim, not the token: "server" is NOT
    // forbidden (a correct denial legitimately contains it).
    expect(byId.get('felt-identity-data-location')!.forbiddenAnswers).not.toContain('server');
    // The not-ChatGPT probe does NOT forbid gpt/chatgpt — a correct denial
    // repeats them.
    const notChatGpt = byId.get('felt-identity-not-chatgpt')!;
    expect(notChatGpt.forbiddenAnswers).not.toContain('gpt');
    expect(notChatGpt.forbiddenAnswers).not.toContain('chatgpt');
  });

  it('greeting/social probes assert no instruction-echo and route to quick', () => {
    const byId = new Map(FELT_PROBES.map((p) => [p.id, p]));
    for (const id of SOCIAL_PROBE_IDS) {
      const probe = byId.get(id);
      expect(probe, id).toBeDefined();
      // Routes as a bare social turn → quick (lockstep with the live router).
      expect(probe!.intent, id).toBe('quick');
      // Names the Gemma-LiteRT quick-hint fragments the reply must not parrot.
      expect(probe!.forbiddenAnswers, id).toContain('answer directly and briefly');
      // An echoed instruction is long — depthBand.maxWords is the over-shoot net.
      expect(probe!.depthBand?.maxWords, id).toBeGreaterThan(0);
    }
  });
});
