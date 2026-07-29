// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  AUTOMATED_DIMENSIONS,
  buildScorecard,
  compareModels,
  diffScorecards,
  getScorecardConfigWarnings,
  median,
} from '../aggregate';
import type {
  EvalResult,
  EvalRun,
  EvalRunDevice,
  RubricScores,
} from '../types';

const DEVICE: EvalRunDevice = {
  profileKey: 'chromium|high-memory-laptop|webgpu',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

const CONFIG = {
  messageTopology: 'production-user-turn-hints' as const,
  samplingMode: 'sampled' as const,
  samplesPerProbe: 1,
  maxTokensCap: 512,
  perGenerationTimeoutMs: 60_000,
  includeResearchArms: false,
  promptCount: 2,
  promptSetHash: 'hash-a',
  compositionEra: 'wave2.6-stage1-user-turn-hints',
  harnessVersion: 2,
};

/**
 * A rubric scores object with every dim non-null except the judge dims,
 * `depthMatch`, `deliversFirst` and `preservesUserText` (null = not-applicable,
 * like a probe without a depthBand or without `expectDeliverable` — keeps the
 * hand-computed means below stable); override per test.
 */
function makeScores(overrides?: Partial<RubricScores>): RubricScores {
  return {
    correctStop: 1,
    noRepetition: 1,
    noCannedLeakage: 1,
    noThinkLeakage: 1,
    noCjkLeak: 1,
    formatAdherence: 1,
    exactness: 1,
    instructionFollowing: 1,
    appropriateUncertainty: 1,
    answerDepth: 1,
    depthMatch: null,
    deliversFirst: null,
    preservesUserText: null,
    coherence: null,
    taskFit: null,
    ...overrides,
  };
}

function makeResult(overrides?: Partial<EvalResult>): EvalResult {
  return {
    promptId: 'p1',
    category: 'factual-known',
    modelId: 'local/qwen3-0.6b',
    runtimeAdapter: 'transformers',
    output: 'hi',
    generationOptions: { temperature: 0.7, maxTokens: 256 },
    scores: makeScores(),
    perf: { ttftMs: 100, tokensPerSec: 20, totalMs: 500, completionTokens: 10, smokePass: true },
    error: null,
    ...overrides,
  };
}

function makeRun(results: EvalResult[], overrides?: Partial<EvalRun>): EvalRun {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    label: 'baseline',
    startedAt: '2026-06-05T00:00:00.000Z',
    finishedAt: '2026-06-05T00:01:00.000Z',
    device: DEVICE,
    results,
    ...overrides,
  };
}

describe('median', () => {
  it('returns null on empty', () => {
    expect(median([])).toBeNull();
  });

  it('returns the middle element for odd length', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('returns the mean of the two middle elements for even length', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('handles a single element', () => {
    expect(median([42])).toBe(42);
  });
});

describe('AUTOMATED_DIMENSIONS', () => {
  it('lists the 13 automated dims and excludes the judge dims', () => {
    expect(AUTOMATED_DIMENSIONS).toEqual([
      'correctStop',
      'noRepetition',
      'noCannedLeakage',
      'noThinkLeakage',
      'noCjkLeak',
      'formatAdherence',
      'exactness',
      'instructionFollowing',
      'appropriateUncertainty',
      'answerDepth',
      'depthMatch',
      // Spec-gated (`expectDeliverable` / `expectUserTextReuse`), so they are
      // null for every probe set that predates them and existing composites are
      // unchanged by their arrival.
      'deliversFirst',
      'preservesUserText',
    ]);
    expect(AUTOMATED_DIMENSIONS).not.toContain('coherence');
    expect(AUTOMATED_DIMENSIONS).not.toContain('taskFit');
  });
});

describe('buildScorecard — composite math', () => {
  it('computes compositeScore as the mean of per-result composites (hand fixture)', () => {
    // Result A: all 10 automated dims = 1.0 → composite 1.0
    // Result B: 4 dims = 0.5, 6 dims = 1.0 → composite (4*0.5 + 6*1.0)/10 = 8/10
    // Model composite = mean(1.0, 8/10) = 9/10
    const a = makeResult({ promptId: 'a', scores: makeScores() });
    const b = makeResult({
      promptId: 'b',
      scores: makeScores({
        correctStop: 0.5,
        noRepetition: 0.5,
        noCannedLeakage: 0.5,
        noThinkLeakage: 0.5,
      }),
    });
    const card = buildScorecard(makeRun([a, b]));
    expect(card.models).toHaveLength(1);
    expect(card.models[0]!.compositeScore).toBeCloseTo(9 / 10, 10);
  });

  it('computes a per-result composite over only the non-null automated dims', () => {
    // One result, formatAdherence/exactness/instructionFollowing/appropriateUncertainty null.
    // Applicable automated dims: correctStop, noRepetition, noCannedLeakage,
    // noThinkLeakage, noCjkLeak, answerDepth = all 1.0
    // composite = 1.0
    const r = makeResult({
      scores: makeScores({
        formatAdherence: null,
        exactness: null,
        instructionFollowing: null,
        appropriateUncertainty: null,
      }),
    });
    const card = buildScorecard(makeRun([r]));
    expect(card.models[0]!.compositeScore).toBeCloseTo(1.0, 10);
  });

  it('skips a result with zero applicable automated dims from the composite mean', () => {
    // Result A: composite 0.5 (all automated = 0.5)
    // Result B: every automated dim null → no applicable dims → skipped
    // Model composite = mean(0.5) = 0.5
    //
    // Note: 4 dims (noRepetition/noCannedLeakage/noThinkLeakage/noCjkLeak) are typed
    // non-null in RubricScores, so a *well-typed* result can never have zero
    // applicable dims — but the runtime guard must still defend against
    // malformed data that lands via storage. We force that shape with a cast.
    const a = makeResult({
      promptId: 'a',
      scores: makeScores({
        correctStop: 0.5,
        noRepetition: 0.5,
        noCannedLeakage: 0.5,
        noThinkLeakage: 0.5,
        noCjkLeak: 0.5,
        formatAdherence: 0.5,
        exactness: 0.5,
        instructionFollowing: 0.5,
        appropriateUncertainty: 0.5,
        answerDepth: 0.5,
      }),
    });
    const allNullScores = {
      correctStop: null,
      noRepetition: null,
      noCannedLeakage: null,
      noThinkLeakage: null,
      noCjkLeak: null,
      formatAdherence: null,
      exactness: null,
      instructionFollowing: null,
      appropriateUncertainty: null,
      answerDepth: null,
      coherence: null,
      taskFit: null,
    } as unknown as RubricScores;
    const b = makeResult({ promptId: 'b', scores: allNullScores });
    const card = buildScorecard(makeRun([a, b]));
    expect(card.models[0]!.compositeScore).toBeCloseTo(0.5, 10);
  });
});

describe('buildScorecard — dimensionAverages null skipping', () => {
  it('averages a dim only over results where it is non-null', () => {
    // exactness: 1.0, null, 0.0 → mean over non-null = mean(1.0, 0.0) = 0.5
    const results = [
      makeResult({ promptId: 'a', scores: makeScores({ exactness: 1 }) }),
      makeResult({ promptId: 'b', scores: makeScores({ exactness: null }) }),
      makeResult({ promptId: 'c', scores: makeScores({ exactness: 0 }) }),
    ];
    const card = buildScorecard(makeRun(results));
    expect(card.models[0]!.dimensionAverages.exactness).toBeCloseTo(0.5, 10);
  });

  it('reports null for a dim that is null in every result', () => {
    const results = [
      makeResult({ promptId: 'a', scores: makeScores({ formatAdherence: null }) }),
      makeResult({ promptId: 'b', scores: makeScores({ formatAdherence: null }) }),
    ];
    const card = buildScorecard(makeRun(results));
    expect(card.models[0]!.dimensionAverages.formatAdherence).toBeNull();
  });

  it('reports per-dimension and composite spread when repeated samples vary', () => {
    const results = [
      makeResult({
        promptId: 'p1',
        sampleIndex: 1,
        scores: makeScores({ correctStop: 1, exactness: 1 }),
      }),
      makeResult({
        promptId: 'p1',
        sampleIndex: 2,
        scores: makeScores({ correctStop: 0, exactness: 0 }),
      }),
    ];
    const model = buildScorecard(makeRun(results)).models[0]!;
    expect(model.dimensionStdDev.correctStop).toBeCloseTo(0.5, 10);
    expect(model.dimensionStdDev.exactness).toBeCloseTo(0.5, 10);
    expect(model.compositeStdDev).toBeGreaterThan(0);
  });
});

describe('buildScorecard — robustness against malformed scores (no NaN)', () => {
  it('excludes an undefined/missing dim from a mean instead of producing NaN', () => {
    // A malformed `scores` that survived JSON.parse: `exactness` is absent
    // (=== undefined), not an explicit null. A plain `v !== null` filter would
    // let it through and the mean would become NaN. It must be excluded.
    const goodScores = makeScores({ exactness: 1 });
    const malformed = makeScores({ exactness: 1 });
    // Delete the dim entirely so reading it yields `undefined`.
    delete (malformed as unknown as Record<string, unknown>).exactness;

    const results = [
      makeResult({ promptId: 'a', scores: goodScores }),
      makeResult({ promptId: 'b', scores: malformed }),
    ];
    const card = buildScorecard(makeRun(results));
    const model = card.models[0]!;

    // exactness averaged over only the finite value (1) → 1, never NaN.
    expect(model.dimensionAverages.exactness).toBe(1);
    expect(Number.isNaN(model.dimensionAverages.exactness)).toBe(false);
    // compositeScore stays a finite number across both results.
    expect(Number.isFinite(model.compositeScore)).toBe(true);
    expect(Number.isNaN(model.compositeScore)).toBe(false);
  });

  it('drops a NaN judge score from judgeAverages', () => {
    const results = [
      makeResult({ promptId: 'a', scores: makeScores({ coherence: 4 }) }),
      makeResult({ promptId: 'b', scores: makeScores({ coherence: NaN }) }),
    ];
    const card = buildScorecard(makeRun(results));
    // Only the finite 4 counts → mean 4, not NaN.
    expect(card.models[0]!.judgeAverages.coherence).toBe(4);
  });
});

describe('buildScorecard — perf, judge, grouping', () => {
  it('computes median perf over non-null and a smokePassRate fraction', () => {
    const results = [
      makeResult({
        promptId: 'a',
        perf: { ttftMs: 100, tokensPerSec: 10, totalMs: 1, completionTokens: 1, smokePass: true },
      }),
      makeResult({
        promptId: 'b',
        perf: { ttftMs: 300, tokensPerSec: 30, totalMs: 1, completionTokens: 1, smokePass: false },
      }),
      makeResult({
        promptId: 'c',
        perf: { ttftMs: null, tokensPerSec: null, totalMs: 1, completionTokens: 0, smokePass: false },
      }),
    ];
    const card = buildScorecard(makeRun(results));
    const perf = card.models[0]!.perf;
    expect(perf.medianTtftMs).toBe(200); // median(100, 300)
    expect(perf.medianTokensPerSec).toBe(20); // median(10, 30)
    expect(perf.smokePassRate).toBeCloseTo(1 / 3, 10);
  });

  it('reports null perf medians when no result has a value', () => {
    const r = makeResult({
      perf: { ttftMs: null, tokensPerSec: null, totalMs: 1, completionTokens: 0, smokePass: false },
    });
    const card = buildScorecard(makeRun([r]));
    expect(card.models[0]!.perf.medianTtftMs).toBeNull();
    expect(card.models[0]!.perf.medianTokensPerSec).toBeNull();
  });

  it('averages judge dims over non-null and reports null when unjudged', () => {
    const results = [
      makeResult({ promptId: 'a', scores: makeScores({ coherence: 4, taskFit: null }) }),
      makeResult({ promptId: 'b', scores: makeScores({ coherence: 2, taskFit: null }) }),
    ];
    const card = buildScorecard(makeRun(results));
    expect(card.models[0]!.judgeAverages.coherence).toBeCloseTo(3, 10); // mean(4, 2)
    expect(card.models[0]!.judgeAverages.taskFit).toBeNull();
  });

  it('groups results by modelId into separate scorecards', () => {
    const results = [
      makeResult({ promptId: 'a', modelId: 'm-a' }),
      makeResult({ promptId: 'b', modelId: 'm-b' }),
      makeResult({ promptId: 'c', modelId: 'm-a' }),
    ];
    const card = buildScorecard(makeRun(results));
    expect(card.models).toHaveLength(2);
    const ids = card.models.map((m) => m.modelId).sort();
    expect(ids).toEqual(['m-a', 'm-b']);
    const mA = card.models.find((m) => m.modelId === 'm-a')!;
    expect(mA.promptCount).toBe(2);
  });

  it('carries run metadata onto the scorecard', () => {
    const card = buildScorecard(makeRun([makeResult()]));
    expect(card.runId).toBe('run-1');
    expect(card.label).toBe('baseline');
    expect(card.device).toEqual(DEVICE);
  });
});

describe('getScorecardConfigWarnings', () => {
  it('returns [] for matching device and config fingerprints', () => {
    const before = buildScorecard(makeRun([makeResult()], { config: CONFIG }));
    const after = buildScorecard(makeRun([makeResult()], { config: CONFIG }));

    expect(getScorecardConfigWarnings(before, after)).toEqual([]);
  });

  it('warns when comparing exploratory non-matching run fingerprints', () => {
    const before = buildScorecard(makeRun([makeResult()], { config: CONFIG }));
    const after = buildScorecard(
      makeRun([makeResult()], {
        device: { ...DEVICE, profileKey: 'firefox|high-memory-laptop|webgpu', browserClass: 'firefox' },
        config: {
          ...CONFIG,
          messageTopology: 'system-front-hints',
          samplingMode: 'greedy',
          promptSetHash: 'hash-b',
          maxTokensCap: 1024,
        },
      }),
    );

    expect(getScorecardConfigWarnings(before, after)).toEqual([
      'Device profile changed (chromium|high-memory-laptop|webgpu → firefox|high-memory-laptop|webgpu).',
      'Browser class changed (chromium → firefox).',
      'Message topology changed (production-user-turn-hints → system-front-hints).',
      'Sampling mode changed (sampled → greedy).',
      'Max token cap changed (512 → 1024).',
      'Prompt set hash changed (hash-a → hash-b).',
    ]);
  });

  it('warns when comparing production topology with Gemma-native topology', () => {
    const before = buildScorecard(makeRun([makeResult()], { config: CONFIG }));
    const after = buildScorecard(
      makeRun([makeResult()], {
        config: {
          ...CONFIG,
          messageTopology: 'gemma-native-user-contract',
        },
      }),
    );

    expect(getScorecardConfigWarnings(before, after)).toEqual([
      'Message topology changed (production-user-turn-hints → gemma-native-user-contract).',
    ]);
  });

  it('warns instead of throwing when imported scorecards have missing or malformed device fingerprints', () => {
    const before = {
      ...buildScorecard(makeRun([makeResult()], { config: CONFIG })),
      device: undefined,
    } as unknown as ReturnType<typeof buildScorecard>;
    const after = {
      ...buildScorecard(makeRun([makeResult()], { config: CONFIG })),
      device: null,
    } as unknown as ReturnType<typeof buildScorecard>;

    expect(() => getScorecardConfigWarnings(before, after)).not.toThrow();
    expect(getScorecardConfigWarnings(before, after)).toEqual([
      'One or both runs are missing or malformed device fingerprints; treat deltas as exploratory.',
    ]);
  });

  it('keeps diffs usable when legacy scorecards have incomplete device metadata', () => {
    const before = {
      ...buildScorecard(makeRun([
        makeResult({ modelId: 'm', scores: makeScores({ exactness: 0.5 }) }),
      ], { config: CONFIG })),
      device: { profileKey: 'legacy-profile-only' },
    } as unknown as ReturnType<typeof buildScorecard>;
    const after = buildScorecard(makeRun([
      makeResult({ modelId: 'm', scores: makeScores({ exactness: 1 }) }),
    ], { config: CONFIG }));

    const diff = diffScorecards(before, after);

    expect(diff.configWarnings).toEqual([
      'One or both runs are missing or malformed device fingerprints; treat deltas as exploratory.',
      'Device profile changed (legacy-profile-only → chromium|high-memory-laptop|webgpu).',
    ]);
    expect(diff.models).toHaveLength(1);
    expect(diff.models[0]!.dimensionDeltas.exactness).toBeCloseTo(0.5, 10);
  });
});

describe('diffScorecards', () => {
  it('computes after-before deltas only for models present in both', () => {
    const before = buildScorecard(
      makeRun(
        [
          makeResult({ modelId: 'shared', scores: makeScores({ exactness: 0.5 }) }),
          makeResult({ promptId: 'only-before', modelId: 'before-only' }),
        ],
        { runId: 'r-before', label: 'baseline' },
      ),
    );
    const after = buildScorecard(
      makeRun(
        [
          makeResult({ modelId: 'shared', scores: makeScores({ exactness: 1 }) }),
          makeResult({ promptId: 'only-after', modelId: 'after-only' }),
        ],
        { runId: 'r-after', label: 'after-phase-1' },
      ),
    );
    const diff = diffScorecards(before, after);
    expect(diff.beforeLabel).toBe('baseline');
    expect(diff.afterLabel).toBe('after-phase-1');
    expect(diff.configWarnings).toEqual(['One or both runs are missing config fingerprints; treat deltas as exploratory.']);
    expect(diff.models).toHaveLength(1);
    const shared = diff.models[0]!;
    expect(shared.modelId).toBe('shared');
    // exactness before 0.5, after 1.0 → delta 0.5
    expect(shared.dimensionDeltas.exactness).toBeCloseTo(0.5, 10);
    // composite before lower than after → positive
    expect(shared.compositeDelta).toBeGreaterThan(0);
  });

  it('reports a null dim delta when either side is null', () => {
    const before = buildScorecard(
      makeRun([makeResult({ modelId: 'm', scores: makeScores({ exactness: null }) })]),
    );
    const after = buildScorecard(
      makeRun([makeResult({ modelId: 'm', scores: makeScores({ exactness: 1 }) })]),
    );
    const diff = diffScorecards(before, after);
    expect(diff.models[0]!.dimensionDeltas.exactness).toBeNull();
  });

  it('computes perf deltas', () => {
    const before = buildScorecard(
      makeRun([
        makeResult({
          modelId: 'm',
          perf: { ttftMs: 100, tokensPerSec: 10, totalMs: 1, completionTokens: 1, smokePass: true },
        }),
      ]),
    );
    const after = buildScorecard(
      makeRun([
        makeResult({
          modelId: 'm',
          perf: { ttftMs: 60, tokensPerSec: 25, totalMs: 1, completionTokens: 1, smokePass: true },
        }),
      ]),
    );
    const diff = diffScorecards(before, after);
    expect(diff.models[0]!.perfDelta.medianTtftMs).toBe(-40);
    expect(diff.models[0]!.perfDelta.medianTokensPerSec).toBe(15);
    expect(diff.models[0]!.perfDelta.smokePassRate).toBe(0);
  });
});

describe('compareModels', () => {
  it('throws a clear error when a model id is absent from the run', () => {
    const run = makeRun([makeResult({ modelId: 'present' })]);
    expect(() => compareModels(run, 'present', 'missing')).toThrow(/missing/);
    expect(() => compareModels(run, 'nope', 'present')).toThrow(/nope/);
  });

  it('computes A/B deltas between two models in one run', () => {
    const run = makeRun([
      makeResult({ promptId: 'p', modelId: 'A', scores: makeScores({ exactness: 0.4 }) }),
      makeResult({ promptId: 'p', modelId: 'B', scores: makeScores({ exactness: 0.9 }) }),
    ]);
    const cmp = compareModels(run, 'A', 'B');
    expect(cmp.a.modelId).toBe('A');
    expect(cmp.b.modelId).toBe('B');
    // delta = b - a → exactness 0.9 - 0.4 = 0.5
    expect(cmp.dimensionDeltas.exactness).toBeCloseTo(0.5, 10);
    expect(cmp.compositeDelta).toBeCloseTo(cmp.b.compositeScore - cmp.a.compositeScore, 10);
  });
});
