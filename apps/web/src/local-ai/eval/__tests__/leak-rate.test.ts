// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { computeLeakRate } from '../leak-rate';
import { CONVERSATION_INTEGRITY_PROBES } from '../conversation-integrity-probe';
import type { EvalCategory, EvalResult, EvalRun, RubricScores } from '../types';

const PROBE_IDS = CONVERSATION_INTEGRITY_PROBES.map((p) => p.id);

/** RubricScores with everything null except the always-computed dims + honorsRuledOut. */
function scoresWith(honorsRuledOut: number | null): RubricScores {
  return {
    correctStop: null,
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
    deliversFirst: null,
    preservesUserText: null,
    preservesUserRegister: null,
    preservesFacts: null,
    preservesHistoryFacts: null,
    honorsRuledOut,
    deliversAskedArtifact: null,
    noUnfilledSlots: null,
    noInventedTime: null,
    deliversUnburied: null,
    coherence: null,
    taskFit: null,
  };
}

function result(
  modelId: string,
  promptId: string,
  honorsRuledOut: number | null,
  category: EvalCategory = 'conversation-integrity',
): EvalResult {
  return {
    promptId,
    category,
    modelId,
    runtimeAdapter: 'transformers',
    output: '',
    generationOptions: {},
    scores: scoresWith(honorsRuledOut),
    perf: { ttftMs: null, tokensPerSec: null, totalMs: 0, completionTokens: 0, smokePass: true },
    error: null,
  };
}

function runOf(results: EvalResult[]): EvalRun {
  return {
    schemaVersion: 1,
    runId: 'test-run',
    label: 'test',
    startedAt: '2026-08-13T00:00:00.000Z',
    finishedAt: '2026-08-13T00:01:00.000Z',
    device: { profileKey: 'k', browserClass: 'b', webgpuSupport: 'w', deviceClass: 'd' },
    results,
  };
}

describe('computeLeakRate', () => {
  it('reports leak-rate = 1 - mean(honorsRuledOut) and any-leak-rate per model', () => {
    // model-a: [1, 0, 0.5] over three probes → mean honored 0.5, leakRate 0.5,
    // two probes leaked at all (0 and 0.5) → anyLeakRate 2/3.
    const run = runOf([
      result('model-a', PROBE_IDS[0]!, 1),
      result('model-a', PROBE_IDS[1]!, 0),
      result('model-a', PROBE_IDS[2]!, 0.5),
    ]);
    const [a] = computeLeakRate(run);
    expect(a?.modelId).toBe('model-a');
    expect(a?.scoredProbeCount).toBe(3);
    expect(a?.leakRate).toBeCloseTo(0.5, 10);
    expect(a?.anyLeakRate).toBeCloseTo(2 / 3, 10);
    expect(a?.leakedProbeIds).toEqual([PROBE_IDS[1], PROBE_IDS[2]]);
  });

  it('reports a clean model as leak-rate 0', () => {
    const run = runOf([
      result('clean', PROBE_IDS[0]!, 1),
      result('clean', PROBE_IDS[1]!, 1),
    ]);
    const [m] = computeLeakRate(run);
    expect(m?.leakRate).toBe(0);
    expect(m?.anyLeakRate).toBe(0);
    expect(m?.leakedProbeIds).toEqual([]);
  });

  it('reports a fully-leaking model as leak-rate 1', () => {
    const run = runOf([result('leaky', PROBE_IDS[0]!, 0), result('leaky', PROBE_IDS[1]!, 0)]);
    const [m] = computeLeakRate(run);
    expect(m?.leakRate).toBe(1);
    expect(m?.anyLeakRate).toBe(1);
  });

  it('excludes null honorsRuledOut (e.g. an error result) from the mean rather than counting it clean', () => {
    // A load failure scores null; if it counted as clean it would flatter the rate.
    const run = runOf([
      result('m', PROBE_IDS[0]!, 0),
      result('m', PROBE_IDS[1]!, null),
    ]);
    const [m] = computeLeakRate(run);
    expect(m?.scoredProbeCount).toBe(1);
    expect(m?.leakRate).toBe(1);
  });

  it('yields null rates when a model has no scored integrity probe', () => {
    const run = runOf([result('m', PROBE_IDS[0]!, null)]);
    const [m] = computeLeakRate(run);
    expect(m?.scoredProbeCount).toBe(0);
    expect(m?.leakRate).toBeNull();
    expect(m?.anyLeakRate).toBeNull();
  });

  it('ignores non-integrity results (other categories and unknown ids)', () => {
    const run = runOf([
      result('m', PROBE_IDS[0]!, 0),
      result('m', 'cap-a1', 1, 'capability-probe'),
      result('m', 'not-a-real-ci-id', 1, 'conversation-integrity'),
    ]);
    const [m] = computeLeakRate(run);
    // Only the one real integrity probe counts.
    expect(m?.scoredProbeCount).toBe(1);
    expect(m?.leakRate).toBe(1);
  });

  it('returns one entry per model, in first-seen order', () => {
    const run = runOf([
      result('second', PROBE_IDS[0]!, 1),
      result('first', PROBE_IDS[1]!, 1),
    ]);
    // "second" appears first in the results, so it leads.
    expect(computeLeakRate(run).map((m) => m.modelId)).toEqual(['second', 'first']);
  });

  it('returns [] when the run has no integrity results at all', () => {
    const run = runOf([result('m', 'cap-a1', 1, 'capability-probe')]);
    expect(computeLeakRate(run)).toEqual([]);
  });
});
