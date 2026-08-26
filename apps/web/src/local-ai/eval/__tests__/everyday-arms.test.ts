// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Everyday-use A/B arms — unit tests.
 *
 * The load-bearing ones are the drift guard (an arm that silently no-ops
 * measures nothing while looking like it measured something) and the
 * control-arm enforcement (a treatment-vs-treatment delta reads like evidence
 * and is not).
 */

import { describe, expect, it } from 'vitest';

import { getOnDeviceSystemPrompt } from '../../../lib/system-prompt';
import { getGenerationProfile } from '../../../lib/chat-intent';
import {
  EVERYDAY_ARMS,
  EVERYDAY_CONTROL_ARM_ID,
  applyEverydayArmOptions,
  compareEverydayArms,
  getEverydayArm,
} from '../everyday-arms';
import type {
  EvalEverydayArmId,
  EvalMessageTopology,
  EvalRun,
  RubricScores,
} from '../types';

const STARTER_350M = 'candidate/lfm2.5-350m-onnx';

// ─── the arm table ─────────────────────────────────────────────────────────

describe('the arm table', () => {
  it('has a control cell that changes nothing', () => {
    const control = getEverydayArm(EVERYDAY_CONTROL_ARM_ID);
    expect(control.ngramBan).toBe('as-shipped');
  });

  it('has exactly the expected arms with distinct ids', () => {
    expect(EVERYDAY_ARMS.map((a) => a.id)).toEqual([
      'control',
      'ngram-off',
    ]);
    expect(new Set(EVERYDAY_ARMS.map((a) => a.id)).size).toBe(EVERYDAY_ARMS.length);
  });

  it('throws on an unknown arm rather than silently measuring the control', () => {
    expect(() => getEverydayArm('nope' as EvalEverydayArmId)).toThrow(/unknown everyday arm/);
  });
});

// ─── shipped prompt drift guard ───────────────────────────────────────────

describe('the shipped prompt', () => {
  it('★ drift guard: the shipped prompt contains the open-vs-closed posture', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain('let the question decide');
  });

  it('★ does NOT contain the old elaboration push', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toContain('then add the context, reasons, or practical details');
    expect(prompt).not.toContain('deserves a thorough, well-developed reply');
  });

  it('★ does NOT command brevity — the axis is open vs closed, not short vs long', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/\b(brief|briefly|short|shorter|concise|terse|succinct|minimal)\b/i);
    expect(prompt).toContain('an open question');
    expect(prompt).toContain('invitation to say more');
  });

  it('★ does not reintroduce the phrasing the 1.2B literalized into an H1', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/lead with the answer/i);
  });

  it('★ does NOT contain the word "answer" (document-mode regression guard)', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).not.toMatch(/\banswer\b/i);
  });

  it('keeps the identity sentence and the user-instruction clause verbatim', () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain(
      'You are Eco, a private AI — a compact open model running entirely on this device; conversations stay with the user.',
    );
    expect(prompt).toContain(
      'When the user gives explicit format or length instructions, follow them exactly.',
    );
  });
});

// ─── the n-gram ban arm ──────────────────────────────────────────────────

describe('the n-gram ban arm', () => {
  // ★ THIS ARM IS SPENT, and that is the thing worth asserting now. It existed to
  // settle one question — whether the starter's prompt-inclusive n-gram ban should
  // come off — and a real-model A/B (n=10, 490 generations per arm) answered yes.
  // So `ngram-off` and `control` now hand this model IDENTICAL options.
  it('★ the starter no longer carries the ban, so this arm has nothing left to toggle', () => {
    const profile = getGenerationProfile('quick', true, STARTER_350M, {
      allowValidationModel: true,
    });
    expect(profile.noRepeatNgramSize).toBeUndefined();
  });

  it('drops the ban on the off arm and keeps every other knob', () => {
    const options = { temperature: 0.45, maxTokens: 1024, topP: 0.86, repetitionPenalty: 1.08, noRepeatNgramSize: 3 };
    const off = applyEverydayArmOptions(options, getEverydayArm('ngram-off'));

    expect(off.noRepeatNgramSize).toBeUndefined();
    // repetitionPenalty in particular must survive: it is the loop guard that
    // has to hold the line once the ban is gone.
    expect(off.repetitionPenalty).toBe(1.08);
    expect(off).toEqual({ temperature: 0.45, maxTokens: 1024, topP: 0.86, repetitionPenalty: 1.08 });
  });

  it('leaves options untouched on the control arm', () => {
    const options = { temperature: 0.45, noRepeatNgramSize: 3 };
    expect(applyEverydayArmOptions(options, getEverydayArm('control'))).toEqual(options);
  });
});

// ─── the mandatory control arm ─────────────────────────────────────────────

function scores(): RubricScores {
  return {
    correctStop: 1,
    noRepetition: 1,
    noCannedLeakage: 1,
    noThinkLeakage: 1,
    noCjkLeak: 1,
    formatAdherence: null,
    exactness: null,
    instructionFollowing: null,
    appropriateUncertainty: null,
    answerDepth: null,
    depthMatch: null,
    deliversFirst: 1,
    preservesUserText: null,
    preservesUserRegister: null,
    preservesFacts: null,
    preservesHistoryFacts: null,
    honorsRuledOut: null,
    deliversAskedArtifact: null,
    noUnfilledSlots: null,
    noInventedTime: null,
    deliversUnburied: null,
    coherence: null,
    taskFit: null,
  };
}

function runFor(
  armId: EvalEverydayArmId | undefined,
  runId: string,
  samplingMode: 'greedy' | 'sampled' = 'sampled',
  _messageTopology: EvalMessageTopology = 'production-user-turn-hints',
): EvalRun {
  return {
    schemaVersion: 1,
    runId,
    label: armId ?? 'unstamped',
    startedAt: '2026-07-28T00:00:00.000Z',
    finishedAt: '2026-07-28T00:10:00.000Z',
    device: {
      profileKey: 'k',
      browserClass: 'chromium',
      webgpuSupport: 'yes',
      deviceClass: 'desktop',
    },
    config: {
      messageTopology: _messageTopology,
      samplingMode,
      samplesPerProbe: 1,
      maxTokensCap: 512,
      perGenerationTimeoutMs: 60_000,
      includeResearchArms: false,
      promptCount: 1,
      promptSetHash: 'hash',
      compositionEra: 'wave2.6-stage1-user-turn-hints',
      harnessVersion: 1,
      ...(armId ? { everydayArm: armId } : {}),
    },
    results: [
      {
        promptId: 'everyday-factual-01',
        category: 'everyday-use',
        modelId: STARTER_350M,
        runtimeAdapter: 'transformers',
        output: 'About 10-12 minutes, then into cold water.',
        generationOptions: { temperature: 0 },
        scores: scores(),
        perf: { ttftMs: 10, tokensPerSec: 10, totalMs: 100, completionTokens: 10, smokePass: true },
        error: null,
      },
    ],
  };
}

describe('★ compareEverydayArms refuses to report without a control', () => {
  it('diffs each treatment against the control when one is present', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control'),
      runFor('ngram-off', 'r-ngram'),
    ]);

    expect(comparison.problems).toEqual([]);
    expect(comparison.controlRunId).toBe('r-control');
    expect(comparison.deltas).toHaveLength(1);
    expect(comparison.deltas[0]?.armId).toBe('ngram-off');
    expect(comparison.deltas[0]?.diff.models[0]?.modelId).toBe(STARTER_350M);
  });

  it('★ refuses two treatments with no control — the +43% TTFT mistake, prevented', () => {
    const comparison = compareEverydayArms([
      runFor('ngram-off', 'r-a'),
      runFor('ngram-off', 'r-b'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/no control-arm run present/);
  });

  it('refuses two runs both claiming the control', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-a'),
      runFor('control', 'r-b'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/claim the control arm/);
  });

  it('refuses a run carrying no arm stamp', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control'),
      runFor(undefined, 'r-unstamped'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/carries no everydayArm stamp/);
  });

  it('refuses an empty set rather than returning an empty comparison', () => {
    expect(compareEverydayArms([]).problems.join(' ')).toMatch(/no control-arm run present/);
  });

  it('★ refuses an n-gram arm run under greedy decode, where the switch cannot act', () => {
    const comparison = compareEverydayArms([
      runFor('control', 'r-control', 'greedy'),
      runFor('ngram-off', 'r-ngram', 'greedy'),
    ]);

    expect(comparison.deltas).toEqual([]);
    expect(comparison.problems.join(' ')).toMatch(/n-gram switch cannot be measured here/);
  });
});
