// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPairs,
  clearPairwiseSessions,
  exportPairwiseSession,
  loadPairwiseSessions,
  orderForJudge,
  savePairwiseSession,
  sessionIdFor,
  tally,
  verdictFromSide,
  type Pair,
  type PairwiseSession,
} from '../pairwise';
import type { EvalPromptSpec, EvalResult, EvalRun, EvalRunDevice, RubricScores } from '../types';

const STORAGE_KEY = 'eco-local-ai-pairwise-v1';

const DEVICE: EvalRunDevice = {
  profileKey: 'chromium|high-memory-laptop|webgpu',
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceClass: 'high-memory-laptop',
};

const SCORES: RubricScores = {
  correctStop: 1,
  noRepetition: 1,
  noThinkLeakage: 1,
  noCjkLeak: 1,
  exactness: 1,
  answerDepth: 1,
  deliversFirst: null,
  preservesHistoryFacts: null,
  honorsRuledOut: null,
  coherence: null,
  taskFit: null,
};

function result(overrides: Partial<EvalResult> & Pick<EvalResult, 'promptId' | 'modelId'>): EvalResult {
  return {
    category: 'factual-known',
    runtimeAdapter: 'transformers',
    output: 'a reply',
    generationOptions: {},
    scores: { ...SCORES },
    perf: { ttftMs: 10, tokensPerSec: 5, totalMs: 100, completionTokens: 4, smokePass: true },
    error: null,
    ...overrides,
  };
}

function run(runId: string, label: string, results: EvalResult[]): EvalRun {
  return {
    schemaVersion: 1,
    runId,
    label,
    startedAt: '2026-09-04T00:00:00.000Z',
    finishedAt: '2026-09-04T00:01:00.000Z',
    device: DEVICE,
    results,
  };
}

function session(overrides?: Partial<PairwiseSession>): PairwiseSession {
  return {
    schemaVersion: 1,
    sessionId: 'run-1:model-a|run-1:model-b|cam',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
    judge: 'cam',
    armA: { runId: 'run-1', modelId: 'model-a' },
    armB: { runId: 'run-1', modelId: 'model-b' },
    verdicts: {},
    excludedCount: 0,
    revealedEarly: false,
    ...overrides,
  };
}

describe('buildPairs', () => {
  const armA = { runId: 'run-1', modelId: 'model-a' };
  const armB = { runId: 'run-1', modelId: 'model-b' };

  it('pairs prompts present in both arms', () => {
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a', output: 'A one' }),
        result({ promptId: 'p1', modelId: 'model-b', output: 'B one' }),
        result({ promptId: 'p2', modelId: 'model-a', output: 'A two' }),
        result({ promptId: 'p2', modelId: 'model-b', output: 'B two' }),
      ]),
    ];
    const { pairs, excluded } = buildPairs(runs, armA, armB);
    expect(pairs.map((p) => p.promptId)).toEqual(['p1', 'p2']);
    expect(pairs[0]).toMatchObject({ pairId: 'p1#1', outputA: 'A one', outputB: 'B one' });
    expect(excluded).toEqual([]);
  });

  it('excludes a prompt missing from one arm, and counts it', () => {
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a' }),
        result({ promptId: 'p1', modelId: 'model-b' }),
        result({ promptId: 'p2', modelId: 'model-a' }),
      ]),
    ];
    const { pairs, excluded } = buildPairs(runs, armA, armB);
    expect(pairs).toHaveLength(1);
    expect(excluded).toEqual([{ pairId: 'p2#1', promptId: 'p2', reason: 'missing-in-arm' }]);
  });

  it('excludes a pair where either arm errored', () => {
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a', error: 'timeout', output: '' }),
        result({ promptId: 'p1', modelId: 'model-b' }),
      ]),
    ];
    const { pairs, excluded } = buildPairs(runs, armA, armB);
    expect(pairs).toHaveLength(0);
    expect(excluded[0]?.reason).toBe('error');
  });

  it('excludes a pair where either output is empty or whitespace', () => {
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a', output: '   ' }),
        result({ promptId: 'p1', modelId: 'model-b', output: 'fine' }),
      ]),
    ];
    const { excluded } = buildPairs(runs, armA, armB);
    expect(excluded[0]?.reason).toBe('empty-output');
  });

  it('pairs the same model across two runs (a settings comparison)', () => {
    const runs = [
      run('run-1', 'before', [result({ promptId: 'p1', modelId: 'model-a', output: 'before' })]),
      run('run-2', 'after', [result({ promptId: 'p1', modelId: 'model-a', output: 'after' })]),
    ];
    const { pairs } = buildPairs(runs, { runId: 'run-1', modelId: 'model-a' }, { runId: 'run-2', modelId: 'model-a' });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ outputA: 'before', outputB: 'after' });
  });

  it('keys replicates apart by sampleIndex', () => {
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a', sampleIndex: 1, output: 'a1' }),
        result({ promptId: 'p1', modelId: 'model-a', sampleIndex: 2, output: 'a2' }),
        result({ promptId: 'p1', modelId: 'model-b', sampleIndex: 1, output: 'b1' }),
        result({ promptId: 'p1', modelId: 'model-b', sampleIndex: 2, output: 'b2' }),
      ]),
    ];
    const { pairs } = buildPairs(runs, armA, armB);
    expect(pairs.map((p) => p.pairId)).toEqual(['p1#1', 'p1#2']);
  });

  it('takes prompt text and history from the supplied specs', () => {
    const spec: EvalPromptSpec = {
      id: 'p1',
      category: 'conversation',
      intent: 'quick',
      prompt: 'what did I say?',
      history: [{ role: 'user', content: 'my cat is called Ada' }],
    };
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a' }),
        result({ promptId: 'p1', modelId: 'model-b' }),
      ]),
    ];
    const { pairs } = buildPairs(runs, armA, armB, [spec]);
    expect(pairs[0]?.promptText).toBe('what did I say?');
    expect(pairs[0]?.history).toHaveLength(1);
  });

  it('leaves prompt text null when no spec matches', () => {
    const runs = [
      run('run-1', 'baseline', [
        result({ promptId: 'p1', modelId: 'model-a' }),
        result({ promptId: 'p1', modelId: 'model-b' }),
      ]),
    ];
    const { pairs } = buildPairs(runs, armA, armB, []);
    expect(pairs[0]?.promptText).toBeNull();
    expect(pairs[0]?.history).toEqual([]);
  });

  it('returns nothing when an arm names a run that is not persisted', () => {
    const runs = [run('run-1', 'baseline', [result({ promptId: 'p1', modelId: 'model-a' })])];
    const { pairs, excluded } = buildPairs(runs, armA, { runId: 'missing', modelId: 'model-b' });
    expect(pairs).toEqual([]);
    expect(excluded).toHaveLength(1);
  });
});

describe('orderForJudge', () => {
  function pair(pairId: string): Pair {
    return { pairId, promptId: pairId.split('#')[0] ?? '', promptText: 'q', history: [], outputA: 'A', outputB: 'B' };
  }

  it('is deterministic for the same pair id', () => {
    const first = orderForJudge(pair('p1#1'));
    const second = orderForJudge(pair('p1#1'));
    expect(second.leftIsA).toBe(first.leftIsA);
    expect(second.left).toBe(first.left);
  });

  it('is roughly balanced over 200 pair ids', () => {
    let leftIsA = 0;
    for (let i = 0; i < 200; i += 1) {
      if (orderForJudge(pair(`prompt-${String(i)}#1`)).leftIsA) leftIsA += 1;
    }
    expect(leftIsA).toBeGreaterThan(70);
    expect(leftIsA).toBeLessThan(130);
  });

  it('exposes no arm-identifying field to the judge', () => {
    const view = orderForJudge(pair('p1#1'));
    expect(Object.keys(view).sort()).toEqual(
      ['history', 'left', 'leftIsA', 'pairId', 'promptId', 'promptText', 'right'],
    );
    expect(JSON.stringify(view)).not.toContain('modelId');
    expect(JSON.stringify(view)).not.toContain('runId');
    expect(JSON.stringify(view)).not.toContain('label');
  });

  it('maps a clicked side back to the right arm', () => {
    const view = orderForJudge(pair('p1#1'));
    const winner = view.leftIsA ? 'A' : 'B';
    expect(verdictFromSide(view, 'left')).toBe(winner);
    expect(verdictFromSide(view, 'right')).toBe(winner === 'A' ? 'B' : 'A');
    expect(verdictFromSide(view, 'tie')).toBe('tie');
  });
});

describe('tally', () => {
  function pairsFor(ids: string[]): Pair[] {
    return ids.map((id) => ({ pairId: id, promptId: id, promptText: null, history: [], outputA: 'a', outputB: 'b' }));
  }

  it('counts wins, ties and undecided pairs', () => {
    const pairs = pairsFor(['p1', 'p2', 'p3', 'p4']);
    const t = tally(session({ verdicts: { p1: 'A', p2: 'A', p3: 'B' }, excludedCount: 2 }), pairs);
    expect(t).toMatchObject({ pairs: 4, decided: 3, winsA: 2, winsB: 1, ties: 0, excluded: 2 });
  });

  it('splits ties in the win rate', () => {
    const pairs = pairsFor(['p1', 'p2', 'p3', 'p4']);
    const t = tally(session({ verdicts: { p1: 'A', p2: 'B', p3: 'tie', p4: 'tie' } }), pairs);
    expect(t.winRateA).toBeCloseTo(0.5, 10);
  });

  it('reports no rate or interval before any verdict', () => {
    const t = tally(session(), pairsFor(['p1']));
    expect(t.winRateA).toBeNull();
    expect(t.interval).toBeNull();
  });

  it('brackets the point estimate with a Wilson 95% interval', () => {
    // 8 of 10 for A: Wilson is [0.490, 0.943] to three places.
    const ids = Array.from({ length: 10 }, (_, i) => `p${String(i)}`);
    const verdicts = Object.fromEntries(ids.map((id, i) => [id, i < 8 ? 'A' : 'B'] as const));
    const t = tally(session({ verdicts }), pairsFor(ids));
    expect(t.winRateA).toBeCloseTo(0.8, 10);
    expect(t.interval?.lo).toBeCloseTo(0.4902, 3);
    expect(t.interval?.hi).toBeCloseTo(0.9433, 3);
  });

  it('keeps a unanimous interval inside [0, 1]', () => {
    const ids = ['p1', 'p2', 'p3'];
    const verdicts = Object.fromEntries(ids.map((id) => [id, 'A'] as const));
    const t = tally(session({ verdicts }), pairsFor(ids));
    expect(t.interval?.lo).toBeGreaterThan(0);
    expect(t.interval?.hi).toBe(1);
  });
});

describe('storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('round-trips a session', () => {
    const s = session({ verdicts: { p1: 'A' } });
    savePairwiseSession(s);
    const loaded = loadPairwiseSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ sessionId: s.sessionId, verdicts: { p1: 'A' } });
  });

  it('upserts by sessionId rather than appending', () => {
    savePairwiseSession(session({ verdicts: { p1: 'A' } }));
    savePairwiseSession(session({ verdicts: { p1: 'A', p2: 'tie' } }));
    const loaded = loadPairwiseSessions();
    expect(loaded).toHaveLength(1);
    expect(Object.keys(loaded[0]?.verdicts ?? {})).toHaveLength(2);
  });

  it('keeps separate records per (arms, judge)', () => {
    savePairwiseSession(session());
    savePairwiseSession(session({ sessionId: sessionIdFor(session().armA, session().armB, 'sam'), judge: 'sam' }));
    expect(loadPairwiseSessions()).toHaveLength(2);
  });

  it('self-heals a malformed payload', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    expect(loadPairwiseSessions()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('drops a record with an unknown verdict value', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...session(), verdicts: { p1: 'maybe' } }]));
    expect(loadPairwiseSessions()).toEqual([]);
  });

  it('clears every session', () => {
    savePairwiseSession(session());
    clearPairwiseSessions();
    expect(loadPairwiseSessions()).toEqual([]);
  });

  it('writes its own key, never the eval-run key', () => {
    savePairwiseSession(session());
    expect(localStorage.getItem('eco-local-ai-eval-v1')).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('exports pretty JSON carrying the session and its tally', () => {
    const s = session({ verdicts: { p1: 'A' } });
    const pairs: Pair[] = [{ pairId: 'p1', promptId: 'p1', promptText: null, history: [], outputA: 'a', outputB: 'b' }];
    const parsed: unknown = JSON.parse(exportPairwiseSession(s, pairs));
    expect(parsed).toMatchObject({ schemaVersion: 1, session: { judge: 'cam' }, tally: { winsA: 1 } });
    expect(exportPairwiseSession(s, pairs)).toContain('\n  ');
  });

  it('derives a stable, case-insensitive session id', () => {
    const a = { runId: 'run-1', modelId: 'model-a' };
    const b = { runId: 'run-2', modelId: 'model-b' };
    expect(sessionIdFor(a, b, ' Cam ')).toBe(sessionIdFor(a, b, 'cam'));
    expect(sessionIdFor(a, b, 'cam')).not.toBe(sessionIdFor(b, a, 'cam'));
  });
});
