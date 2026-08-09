// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildJudgeSkeleton,
  clearEvalRuns,
  exportEvalRuns,
  getEvalRun,
  normalizeImportedEvalRuns,
  getEvalRunsByLabel,
  loadEvalRuns,
  MAX_RUNS,
  saveEvalRun,
  setJudgeScores,
} from '../storage';
import { buildScorecard } from '../aggregate';
import type { EvalResult, EvalRun, EvalRunConfigFingerprint, EvalRunDevice, RubricScores } from '../types';

const STORAGE_KEY = 'eco-local-ai-eval-v1';

const DEVICE: EvalRunDevice = {
  profileKey: 'chromium|high-memory-laptop|webgpu',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

const CONFIG: EvalRunConfigFingerprint = {
  messageTopology: 'production-user-turn-hints',
  samplingMode: 'sampled',
  samplesPerProbe: 1,
  maxTokensCap: 512,
  perGenerationTimeoutMs: 60_000,
  includeResearchArms: false,
  promptCount: 1,
  promptSetHash: 'hash-a',
  compositionEra: 'wave2.6-stage1-user-turn-hints',
  harnessVersion: 2,
};

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

function makeRun(overrides?: Partial<EvalRun>): EvalRun {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    label: 'baseline',
    startedAt: '2026-06-05T00:00:00.000Z',
    finishedAt: '2026-06-05T00:01:00.000Z',
    device: DEVICE,
    results: [makeResult()],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('saveEvalRun + loadEvalRuns', () => {
  it('roundtrips a single run', () => {
    const run = makeRun();
    saveEvalRun(run);
    const loaded = loadEvalRuns();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.runId).toBe('run-1');
    expect(loaded[0]!.label).toBe('baseline');
    expect(loaded[0]!.results).toHaveLength(1);
    expect(loaded[0]!.results[0]!.scores.exactness).toBe(1);
  });

  it('appends runs in insertion order', () => {
    saveEvalRun(makeRun({ runId: 'a' }));
    saveEvalRun(makeRun({ runId: 'b' }));
    saveEvalRun(makeRun({ runId: 'c' }));
    expect(loadEvalRuns().map((r) => r.runId)).toEqual(['a', 'b', 'c']);
  });
});

describe(`FIFO eviction at MAX_RUNS (${String(MAX_RUNS)})`, () => {
  it('evicts oldest runs past the cap', () => {
    for (let i = 0; i < MAX_RUNS + 5; i++) {
      saveEvalRun(makeRun({ runId: `run-${i}` }));
    }
    const loaded = loadEvalRuns();
    expect(loaded).toHaveLength(MAX_RUNS);
    // Oldest 5 evicted → first remaining is run-5.
    expect(loaded[0]!.runId).toBe('run-5');
    expect(loaded[MAX_RUNS - 1]!.runId).toBe(`run-${MAX_RUNS + 4}`);
  });
});

describe('self-heal on malformed storage', () => {
  it('returns [] and clears the key on malformed JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(loadEvalRuns()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('returns [] and clears when storage is a non-array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    expect(loadEvalRuns()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('filters out entries that fail validation', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        makeRun({ runId: 'valid' }),
        { schemaVersion: 1, runId: 'missing-fields' }, // no label/results
        { schemaVersion: 2, runId: 'wrong-version', label: 'x', results: [] }, // wrong version
        makeRun({ runId: 'also-valid' }),
      ]),
    );
    const loaded = loadEvalRuns();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((r) => r.runId)).toEqual(['valid', 'also-valid']);
  });

  it('keeps legacy runs without topology and roundtrips new topology-stamped runs', () => {
    const legacy = makeRun({ runId: 'legacy' });
    const stamped = makeRun({ runId: 'stamped', config: CONFIG });
    localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy, stamped]));

    const loaded = loadEvalRuns();
    expect(loaded.map((r) => r.runId)).toEqual(['legacy', 'stamped']);
    expect(loaded[0]!.config).toBeUndefined();
    expect(loaded[1]!.config?.messageTopology).toBe('production-user-turn-hints');
  });

  it('does not reject the stored run set when a run has an invalid topology value', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        makeRun({ runId: 'valid' }),
        makeRun({
          runId: 'invalid-topology',
          config: { ...CONFIG, messageTopology: 'not-a-topology' } as unknown as EvalRunConfigFingerprint,
        }),
      ]),
    );

    expect(loadEvalRuns().map((r) => r.runId)).toEqual(['valid', 'invalid-topology']);
  });

  it('filters out runs with malformed device metadata before diagnostics UI can dereference it', () => {
    const noDevice = { ...makeRun({ runId: 'no-device' }) } as Record<string, unknown>;
    delete noDevice.device;
    const partialDevice = {
      ...makeRun({ runId: 'partial-device' }),
      device: { profileKey: 'legacy-only' },
    };
    const nullDevice = { ...makeRun({ runId: 'null-device' }), device: null };

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        makeRun({ runId: 'valid' }),
        noDevice,
        partialDevice,
        nullDevice,
        makeRun({ runId: 'also-valid' }),
      ]),
    );

    const loaded = loadEvalRuns();
    expect(loaded.map((r) => r.runId)).toEqual(['valid', 'also-valid']);
    expect(loaded.every((r) => typeof r.device.deviceClass === 'string')).toBe(true);
  });

  it('drops malformed results but keeps the good results', () => {
    // A result missing `perf` would crash buildScorecard at `r.perf.ttftMs`.
    // Missing identities would group under `undefined` and poison judge skeletons.
    const good = makeResult({ promptId: 'good', modelId: 'm' });
    const noPerf = { ...makeResult({ promptId: 'bad-perf', modelId: 'm' }) } as Record<string, unknown>;
    delete noPerf.perf;
    const noScores = { ...makeResult({ promptId: 'bad-scores', modelId: 'm' }) } as Record<string, unknown>;
    delete noScores.scores;
    const noIdentity = { ...makeResult({ promptId: 'bad-identity', modelId: 'm' }) } as Record<string, unknown>;
    delete noIdentity.modelId;
    const badCategory = { ...makeResult({ promptId: 'bad-category', modelId: 'm' }), category: 'other' };
    const badRuntime = { ...makeResult({ promptId: 'bad-runtime', modelId: 'm' }), runtimeAdapter: 'other' };

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([makeRun({
        runId: 'r',
        results: [good, noPerf, noScores, noIdentity, badCategory, badRuntime] as unknown as EvalResult[],
      })]),
    );

    const run = getEvalRun('r')!;
    // Malformed results dropped; only the good one remains.
    expect(run.results).toHaveLength(1);
    expect(run.results[0]!.promptId).toBe('good');

    // The surviving run feeds buildScorecard without throwing.
    expect(() => buildScorecard(run)).not.toThrow();
    const card = buildScorecard(run);
    expect(card.models).toHaveLength(1);
    expect(card.models[0]!.promptCount).toBe(1);
  });
});

describe('getEvalRun + getEvalRunsByLabel', () => {
  it('returns a run by id, or null when absent', () => {
    saveEvalRun(makeRun({ runId: 'x' }));
    saveEvalRun(makeRun({ runId: 'y' }));
    expect(getEvalRun('y')!.runId).toBe('y');
    expect(getEvalRun('missing')).toBeNull();
  });

  it('returns all runs matching a label', () => {
    saveEvalRun(makeRun({ runId: 'a', label: 'baseline' }));
    saveEvalRun(makeRun({ runId: 'b', label: 'after-phase-1' }));
    saveEvalRun(makeRun({ runId: 'c', label: 'baseline' }));
    const baseline = getEvalRunsByLabel('baseline');
    expect(baseline.map((r) => r.runId)).toEqual(['a', 'c']);
    expect(getEvalRunsByLabel('nope')).toEqual([]);
  });
});

describe('setJudgeScores', () => {
  it('mutates the matching result and persists, returning true', () => {
    saveEvalRun(
      makeRun({
        runId: 'r',
        results: [
          makeResult({ promptId: 'p1', modelId: 'm-a' }),
          makeResult({ promptId: 'p2', modelId: 'm-a' }),
          makeResult({ promptId: 'p1', modelId: 'm-b' }),
        ],
      }),
    );
    const ok = setJudgeScores('r', [
      { promptId: 'p1', modelId: 'm-a', coherence: 4, taskFit: 5 },
      { promptId: 'p1', modelId: 'm-b', coherence: 2 },
    ]);
    expect(ok).toBe(true);

    const run = getEvalRun('r')!;
    const a = run.results.find((x) => x.promptId === 'p1' && x.modelId === 'm-a')!;
    expect(a.scores.coherence).toBe(4);
    expect(a.scores.taskFit).toBe(5);
    // Untouched result stays null.
    const a2 = run.results.find((x) => x.promptId === 'p2' && x.modelId === 'm-a')!;
    expect(a2.scores.coherence).toBeNull();
    // Partial update (only coherence) leaves taskFit alone.
    const b = run.results.find((x) => x.promptId === 'p1' && x.modelId === 'm-b')!;
    expect(b.scores.coherence).toBe(2);
    expect(b.scores.taskFit).toBeNull();
  });

  it('returns false when the run does not exist', () => {
    expect(setJudgeScores('nope', [{ promptId: 'p', modelId: 'm', coherence: 3 }])).toBe(false);
  });

  it('ignores non-finite and out-of-range judge scores so they cannot poison judgeAverages', () => {
    saveEvalRun(makeRun({ runId: 'r', results: [makeResult({ promptId: 'p1', modelId: 'm' })] }));
    const ok = setJudgeScores('r', [
      { promptId: 'p1', modelId: 'm', coherence: NaN, taskFit: 99 },
      { promptId: 'p1', modelId: 'm', coherence: 0, taskFit: 4 },
    ]);
    expect(ok).toBe(true);
    const result = getEvalRun('r')!.results[0]!;
    // NaN / 0 / 99 rejected (stay null); the valid taskFit is written.
    expect(result.scores.coherence).toBeNull();
    expect(result.scores.taskFit).toBe(4);
  });

  it('uses sampleIndex when provided so repeated samples can be judged separately', () => {
    saveEvalRun(
      makeRun({
        runId: 'r',
        results: [
          makeResult({ promptId: 'p1', modelId: 'm', sampleIndex: 1 }),
          makeResult({ promptId: 'p1', modelId: 'm', sampleIndex: 2 }),
        ],
      }),
    );

    const ok = setJudgeScores('r', [
      { promptId: 'p1', modelId: 'm', sampleIndex: 2, taskFit: 3 },
    ]);
    expect(ok).toBe(true);

    const run = getEvalRun('r')!;
    expect(run.results[0]!.scores.taskFit).toBeNull();
    expect(run.results[1]!.scores.taskFit).toBe(3);
  });
});

describe('clearEvalRuns', () => {
  it('removes all runs', () => {
    saveEvalRun(makeRun({ runId: 'a' }));
    saveEvalRun(makeRun({ runId: 'b' }));
    expect(loadEvalRuns()).toHaveLength(2);
    clearEvalRuns();
    expect(loadEvalRuns()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('exportEvalRuns', () => {
  it('returns a pretty-printed JSON envelope', () => {
    saveEvalRun(makeRun({ runId: 'export-me' }));
    const json = exportEvalRuns();
    expect(json).toContain('\n'); // pretty-printed
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      dumpedAt: string;
      runs: EvalRun[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.dumpedAt).toBe('string');
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0]!.runId).toBe('export-me');
  });

  it('returns an empty runs array when nothing stored', () => {
    const parsed = JSON.parse(exportEvalRuns()) as { runs: EvalRun[] };
    expect(parsed.runs).toEqual([]);
  });
});

describe('normalizeImportedEvalRuns', () => {
  it('normalizes an export envelope object', () => {
    const run = makeRun({ runId: 'object-envelope' });

    const result = normalizeImportedEvalRuns({
      schemaVersion: 1,
      dumpedAt: '2026-06-17T00:00:00.000Z',
      runs: [run],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.runId).toBe('object-envelope');
  });

  it('normalizes a stringified export envelope', () => {
    const run = makeRun({ runId: 'string-envelope' });

    const result = normalizeImportedEvalRuns(
      JSON.stringify({
        schemaVersion: 1,
        dumpedAt: '2026-06-17T00:00:00.000Z',
        runs: [run],
      }),
    );

    expect(result.map((r) => r.runId)).toEqual(['string-envelope']);
  });

  it('normalizes a double-stringified export envelope', () => {
    const run = makeRun({ runId: 'double-string-envelope' });
    const envelope = JSON.stringify({
      schemaVersion: 1,
      dumpedAt: '2026-06-17T00:00:00.000Z',
      runs: [run],
    });

    const result = normalizeImportedEvalRuns(JSON.stringify(envelope));

    expect(result.map((r) => r.runId)).toEqual(['double-string-envelope']);
  });

  it('filters malformed runs using the existing structural guard', () => {
    const good = makeRun({ runId: 'good' });

    const result = normalizeImportedEvalRuns({
      schemaVersion: 1,
      dumpedAt: '2026-06-17T00:00:00.000Z',
      runs: [
        good,
        { schemaVersion: 1, runId: 'missing-fields' },
        { schemaVersion: 2, runId: 'wrong-schema', label: 'x', results: [] },
      ],
    });

    expect(result.map((r) => r.runId)).toEqual(['good']);
  });

  it('rejects malformed JSON clearly', () => {
    expect(() => normalizeImportedEvalRuns('{nope')).toThrow(/valid JSON/i);
  });

  it('rejects a wrong export schema clearly', () => {
    expect(() =>
      normalizeImportedEvalRuns({ schemaVersion: 2, dumpedAt: '2026-06-17T00:00:00.000Z', runs: [] }),
    ).toThrow(/schemaVersion must be 1/i);
  });

  it('rejects an envelope without a runs array clearly', () => {
    expect(() => normalizeImportedEvalRuns({ schemaVersion: 1, dumpedAt: 'x', captures: [] })).toThrow(
      /runs array/i,
    );
  });
});

describe('buildJudgeSkeleton', () => {
  it('emits one entry per judge-marked result that still needs filling', () => {
    const run = makeRun({
      results: [
        // judge-marked + unfilled → included.
        makeResult({ promptId: 'r1', modelId: 'A', judge: ['taskFit'], scores: makeScores({ taskFit: null }) }),
        makeResult({ promptId: 'r1', modelId: 'B', judge: ['taskFit'], scores: makeScores({ taskFit: null }) }),
        // not judge-marked → skipped.
        makeResult({ promptId: 'fk1', modelId: 'A' }),
      ],
    });
    const skeleton = buildJudgeSkeleton(run);
    expect(skeleton).toEqual([
      { promptId: 'r1', modelId: 'A', needs: ['taskFit'] },
      { promptId: 'r1', modelId: 'B', needs: ['taskFit'] },
    ]);
  });

  it('skips a result whose only requested dim is already filled', () => {
    const run = makeRun({
      results: [
        makeResult({ promptId: 'r1', modelId: 'A', judge: ['taskFit'], scores: makeScores({ taskFit: 4 }) }),
      ],
    });
    expect(buildJudgeSkeleton(run)).toEqual([]);
  });

  it('reports only the still-unfilled dims when a probe requested two', () => {
    const run = makeRun({
      results: [
        makeResult({
          promptId: 'as3',
          modelId: 'A',
          judge: ['taskFit', 'coherence'],
          scores: makeScores({ taskFit: 5, coherence: null }),
        }),
      ],
    });
    expect(buildJudgeSkeleton(run)).toEqual([
      { promptId: 'as3', modelId: 'A', needs: ['coherence'] },
    ]);
  });

  it('carries sampleIndex into skeleton rows for multi-sample runs', () => {
    const run = makeRun({
      results: [
        makeResult({
          promptId: 'r1',
          modelId: 'A',
          sampleIndex: 2,
          judge: ['taskFit'],
          scores: makeScores({ taskFit: null }),
        }),
      ],
    });
    expect(buildJudgeSkeleton(run)).toEqual([
      { promptId: 'r1', modelId: 'A', sampleIndex: 2, needs: ['taskFit'] },
    ]);
  });

  it('returns [] when no result requested judging (e.g. an old run)', () => {
    const run = makeRun({ results: [makeResult({ judge: undefined })] });
    expect(buildJudgeSkeleton(run)).toEqual([]);
  });
});
