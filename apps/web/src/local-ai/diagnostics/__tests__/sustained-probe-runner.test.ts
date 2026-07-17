// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runner-level guarantees for the sustained probe (s32 hardening):
 *
 *   1. A probe NEVER downloads — an un-cached model is refused up front with
 *      an honest `error` record, before `loadModel` is even called. (The
 *      un-guarded path fell through to TJS's internal remote fetch: a 0.76 GB
 *      single-GET through the dev proxy that 504'd.)
 *   2. A load that never settles cannot wedge the probe — the load budget
 *      aborts it and records `error`, clearing the crash-evidence marker.
 *      Without this, an orphaned marker from a mere load failure fabricates a
 *      false `killed` record on next mount, corrupting the ONLY tab-kill
 *      signal WebKit gives us.
 *   3. The happy path still records `completed` with the marker cleared.
 *
 * `runtime/lifecycle` and `download/download` are mocked — the runner is
 * driven exactly through the seams real chat uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMarker, clearSustainedProbes, loadSustainedProbes, readMarker } from '../sustained-probe';
import type { SustainedProbeMarker } from '../sustained-probe';
import type { ModelConfig } from '../../types';
import type { TokenEvent } from '../../runtime/types';

const loadModelMock = vi.hoisted(() => vi.fn());
const generateMock = vi.hoisted(() => vi.fn());
const peekDownloadPlanMock = vi.hoisted(() => vi.fn());
const verifyMock = vi.hoisted(() => vi.fn());

vi.mock('../../runtime/lifecycle', () => ({
  loadModel: loadModelMock,
  generate: generateMock,
}));

vi.mock('../../download/download', () => ({
  peekDownloadPlan: peekDownloadPlanMock,
}));

vi.mock('../../download/storage', () => ({
  pickStorage: () => ({ verify: verifyMock }),
}));

const MODEL = { id: 'test/probe-model', sizeGB: 0.5 } as unknown as ModelConfig;

/** A plan shaped like real manifests: weights + small files TJS may skip. */
const PLAN = {
  modelId: 'test/probe-model',
  files: [
    { url: 'proxy/onnx/model_q4f16.onnx', sizeBytes: 543 * 1024 * 1024 },
    { url: 'proxy/tokenizer.json', sizeBytes: 9 * 1024 * 1024 },
    { url: 'proxy/vocab.json', sizeBytes: 2 * 1024 * 1024 },
  ],
};

/** Weights verify; small files DON'T (never downloaded — TJS never asks). */
function cacheWithWeightsOnly(): void {
  peekDownloadPlanMock.mockResolvedValue(PLAN);
  verifyMock.mockImplementation((key: { url: string }) =>
    Promise.resolve(key.url.includes('.onnx')),
  );
}

async function* tokenStream(): AsyncIterable<TokenEvent> {
  yield { kind: 'token', text: 'hello' } as TokenEvent;
  yield { kind: 'done', promptTokens: 10, completionTokens: 1 } as TokenEvent;
}

beforeEach(() => {
  clearMarker();
  clearSustainedProbes();
  loadModelMock.mockReset();
  generateMock.mockReset();
  peekDownloadPlanMock.mockReset();
  verifyMock.mockReset();
});

afterEach(() => {
  clearMarker();
  clearSustainedProbes();
  vi.useRealTimers();
});

describe('runSustainedProbe — never-download guard', () => {
  it('refuses a model whose weights are un-cached and never calls loadModel', async () => {
    peekDownloadPlanMock.mockResolvedValue(PLAN);
    verifyMock.mockResolvedValue(false);

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 2 });

    expect(record.outcome).toBe('error');
    expect(record.error).toMatch(/not.*downloaded|download/i);
    expect(loadModelMock).not.toHaveBeenCalled();
    // The refusal is persisted and leaves no orphaned marker behind.
    expect(loadSustainedProbes().at(-1)?.outcome).toBe('error');
    expect(readMarker()).toBeNull();
  });

  it('accepts a cache holding the weights even when small plan files were never downloaded', async () => {
    // Real caches are populated by TJS's actual requests, which skip several
    // manifest files (vocab.json, merges.txt, ...). Only weights gate the probe.
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1 });

    expect(record.outcome).toBe('completed');
    expect(loadModelMock).toHaveBeenCalled();
  });

  it('fails closed when no download plan resolves', async () => {
    peekDownloadPlanMock.mockResolvedValue(null);

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1 });

    expect(record.outcome).toBe('error');
    expect(loadModelMock).not.toHaveBeenCalled();
  });
});

describe('runSustainedProbe — load deadline', () => {
  // Real timers with a tiny real budget: the runner's dynamic imports resolve
  // via real module I/O, which fake-timer clock advances race past (the timer
  // would be registered only after the advance already completed).
  it('aborts a never-settling load at the budget and records an honest error (marker cleared)', async () => {
    cacheWithWeightsOnly();
    // A load that only settles when its abort signal fires — the wedge shape
    // observed in s32 (worker never posts back; only the abort path settles).
    loadModelMock.mockImplementation(
      (_model: ModelConfig, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('Load aborted')), { once: true });
        }),
    );

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 2, loadTimeoutMs: 50 });

    expect(record.outcome).toBe('error');
    expect(record.error).toMatch(/load.*budget|budget.*load/i);
    expect(record.error).not.toMatch(/tab was killed/i);
    expect(record.turnsCompleted).toBe(0);
    // The whole point: no orphaned marker ⇒ no fabricated `killed` on next mount.
    expect(readMarker()).toBeNull();
    expect(loadSustainedProbes().at(-1)?.outcome).toBe('error');
  });

  it("holds the marker at phase 'loading' with backend null while the load is pending", async () => {
    cacheWithWeightsOnly();
    // Snapshot the marker at the moment loadModel is entered — the load hasn't
    // settled, so the backend is not yet confirmed. A kill here would reconstruct
    // as a load-phase death, falling back to the WebGPU-presence hint.
    let markerDuringLoad: SustainedProbeMarker | null = null;
    loadModelMock.mockImplementation(
      (_model: ModelConfig, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          markerDuringLoad = readMarker();
          options?.signal?.addEventListener('abort', () => reject(new Error('Load aborted')), { once: true });
        }),
    );

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    await runSustainedProbe({ model: MODEL, turns: 2, loadTimeoutMs: 50 });

    expect(markerDuringLoad).not.toBeNull();
    expect(markerDuringLoad!.phase).toBe('loading');
    expect(markerDuringLoad!.backend).toBeNull();
  });

  it('passes an abort signal through to loadModel so the underlying load is actually cancelled', async () => {
    cacheWithWeightsOnly();
    let sawSignal: AbortSignal | undefined;
    loadModelMock.mockImplementation(
      (_model: ModelConfig, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sawSignal = options?.signal;
          options?.signal?.addEventListener('abort', () => reject(new Error('Load aborted')), { once: true });
        }),
    );

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    await runSustainedProbe({ model: MODEL, loadTimeoutMs: 50 });

    expect(sawSignal).toBeDefined();
    expect(sawSignal!.aborted).toBe(true);
  });

  it('propagates an already-aborted external signal to the load (abort never fires retroactively)', async () => {
    cacheWithWeightsOnly();
    let sawSignal: AbortSignal | undefined;
    loadModelMock.mockImplementation(
      (_model: ModelConfig, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sawSignal = options?.signal;
          if (options?.signal?.aborted) {
            reject(new Error('Load aborted'));
            return;
          }
          options?.signal?.addEventListener('abort', () => reject(new Error('Load aborted')), { once: true });
        }),
    );
    const external = new AbortController();
    external.abort();

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe(
      { model: MODEL, loadTimeoutMs: 60_000 },
      { signal: external.signal },
    );

    // The load was cancelled by the pre-aborted signal, not the (long) budget.
    expect(sawSignal!.aborted).toBe(true);
    expect(record.outcome).toBe('error');
    expect(readMarker()).toBeNull();
  });
});

describe('runSustainedProbe — happy path', () => {
  it('records completed with the marker cleared when load and turns succeed', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 2 });

    expect(record.outcome).toBe('completed');
    expect(record.turnsCompleted).toBe(2);
    expect(record.backend).toBe('wasm');
    expect(readMarker()).toBeNull();
    expect(loadSustainedProbes().at(-1)?.outcome).toBe('completed');
  });

  it("drives the marker phase loading → turn-in-flight → turn-complete and stamps the backend after load", async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    // Read the live marker at each progress event — the freshest evidence a tab
    // kill would leave behind. (At 'done' the marker is already cleared.)
    const snapshots: Array<{ progressPhase: string; markerPhase?: string; backend?: string | null }> = [];
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    await runSustainedProbe(
      { model: MODEL, turns: 1 },
      {
        onProgress: (p) => {
          const m = readMarker();
          snapshots.push({ progressPhase: p.phase, markerPhase: m?.phase, backend: m?.backend });
        },
      },
    );

    const loading = snapshots.find((s) => s.progressPhase === 'loading');
    expect(loading?.markerPhase).toBe('loading');
    expect(loading?.backend).toBeNull();

    const turnStart = snapshots.find((s) => s.progressPhase === 'turn-start');
    expect(turnStart?.markerPhase).toBe('turn-in-flight');
    expect(turnStart?.backend).toBe('wasm');

    const turnComplete = snapshots.find((s) => s.progressPhase === 'turn-complete');
    expect(turnComplete?.markerPhase).toBe('turn-complete');
  });
});
