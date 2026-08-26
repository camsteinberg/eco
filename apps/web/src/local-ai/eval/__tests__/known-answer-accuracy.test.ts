// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';

import { computeKnownAnswerAccuracy } from '../known-answer-accuracy';
import { KNOWN_ANSWER_PROBES } from '../known-answer-probes';
import type { EvalCategory, EvalResult, EvalRun, RubricScores } from '../types';

const IDS = KNOWN_ANSWER_PROBES.map((p) => p.id);

function scoresWith(exactness: number | null): RubricScores {
  return {
    correctStop: null,
    noRepetition: 1,
    noCannedLeakage: 1,
    noThinkLeakage: 1,
    noCjkLeak: 1,
    formatAdherence: null,
    exactness,
    instructionFollowing: null,
    appropriateUncertainty: null,
    answerDepth: null,
    depthMatch: null,
    deliversFirst: null,
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

function result(
  modelId: string,
  promptId: string,
  exactness: number | null,
  category: EvalCategory = 'known-answer',
): EvalResult {
  return {
    promptId,
    category,
    modelId,
    runtimeAdapter: 'transformers',
    output: '',
    generationOptions: {},
    scores: scoresWith(exactness),
    perf: { ttftMs: null, tokensPerSec: null, totalMs: 0, completionTokens: 0, smokePass: true },
    error: null,
  };
}

function runOf(results: EvalResult[]): EvalRun {
  return {
    schemaVersion: 1,
    runId: 'test-run',
    label: 'test',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:01:00.000Z',
    device: { profileKey: 'k', browserClass: 'b', webgpuSupport: 'w', deviceClass: 'd' },
    results,
  };
}

describe('computeKnownAnswerAccuracy', () => {
  it('reports mean and strict accuracy per model with the wrong/ambiguous ids', () => {
    const run = runOf([
      result('model-a', IDS[0]!, 1),
      result('model-a', IDS[1]!, 0),
      result('model-a', IDS[2]!, 0.5),
      result('model-a', IDS[3]!, 1),
      result('model-b', IDS[0]!, 0),
    ]);
    const [a, b] = computeKnownAnswerAccuracy(run);
    expect(a).toEqual({
      modelId: 'model-a',
      scoredCount: 4,
      accuracy: 0.625,
      strictAccuracy: 0.5,
      wrongPromptIds: [IDS[1]],
      ambiguousPromptIds: [IDS[2]],
    });
    expect(b?.accuracy).toBe(0);
    expect(b?.strictAccuracy).toBe(0);
  });

  it('ignores other categories, unknown ids, and unscored (errored) results', () => {
    const run = runOf([
      result('model-a', 'fk1', 1, 'factual-known'),
      result('model-a', 'ka-not-real', 1),
      result('model-a', IDS[0]!, null),
    ]);
    const [a] = computeKnownAnswerAccuracy(run);
    expect(a).toEqual({
      modelId: 'model-a',
      scoredCount: 0,
      accuracy: null,
      strictAccuracy: null,
      wrongPromptIds: [],
      ambiguousPromptIds: [],
    });
  });
});
