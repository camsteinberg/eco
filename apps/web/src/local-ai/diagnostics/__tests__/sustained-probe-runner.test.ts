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
import { clearMarker, clearSustainedProbes, loadSustainedProbes, nextTurnPrompt, readMarker } from '../sustained-probe';
import type { SustainedProbeMarker } from '../sustained-probe';
import type { ModelConfig } from '../../types';
import type { ChatMessage, TokenEvent } from '../../runtime/types';

const loadModelMock = vi.hoisted(() => vi.fn());
const generateMock = vi.hoisted(() => vi.fn());
const unloadActiveMock = vi.hoisted(() => vi.fn());
const peekDownloadPlanMock = vi.hoisted(() => vi.fn());
const verifyMock = vi.hoisted(() => vi.fn());
const verifyIntactMock = vi.hoisted(() => vi.fn());
// The per-turn UA-memory measure is mocked at its real seam so the timeout race
// can be exercised: the default delegates to the real (jsdom-null) behavior, and
// a single test overrides it with a never-settling promise to trip the timeout.
const measureUAMock = vi.hoisted(() => vi.fn());

vi.mock('../../runtime/lifecycle', () => ({
  loadModel: loadModelMock,
  generate: generateMock,
  unloadActive: unloadActiveMock,
}));

vi.mock('../sustained-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sustained-probe')>();
  return { ...actual, measureUserAgentMemoryMB: measureUAMock };
});

vi.mock('../../download/download', () => ({
  peekDownloadPlan: peekDownloadPlanMock,
}));

vi.mock('../../download/storage', () => ({
  pickStorage: () => ({ verify: verifyMock, verifyIntact: verifyIntactMock }),
}));

// The webllm gate consults WebLLM's own cache (not Eco storage) via this helper.
const webllmModelInCacheMock = vi.hoisted(() => vi.fn());
vi.mock('../../runtime/webllm-cache-bridge', () => ({
  webllmModelInCache: webllmModelInCacheMock,
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
  unloadActiveMock.mockReset();
  unloadActiveMock.mockResolvedValue(undefined);
  peekDownloadPlanMock.mockReset();
  verifyMock.mockReset();
  verifyIntactMock.mockReset();
  // Default: mirror the real jsdom behavior (no UA-memory API ⇒ null).
  measureUAMock.mockReset();
  measureUAMock.mockResolvedValue(null);
  webllmModelInCacheMock.mockReset();
});

afterEach(() => {
  clearMarker();
  clearSustainedProbes();
  vi.useRealTimers();
});

const WEBLLM_MODEL = { id: 'candidate/qwen2-0.5b-webllm', sizeGB: 0.3, runtime: 'webllm' } as unknown as ModelConfig;

describe('runSustainedProbe — webllm cache gate', () => {
  it('refuses a webllm model whose weights are not in WebLLM cache (consults webllmModelInCache, not Eco storage)', async () => {
    webllmModelInCacheMock.mockResolvedValue(false);

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: WEBLLM_MODEL, turns: 2 });

    expect(record.outcome).toBe('error');
    expect(record.error).toMatch(/WebLLM cache/i);
    expect(webllmModelInCacheMock).toHaveBeenCalledWith(WEBLLM_MODEL);
    expect(loadModelMock).not.toHaveBeenCalled();
    // The Eco-storage plan path is NOT used for a webllm model.
    expect(peekDownloadPlanMock).not.toHaveBeenCalled();
    expect(readMarker()).toBeNull();
  });

  it('runs a webllm model when its weights ARE in WebLLM cache', async () => {
    webllmModelInCacheMock.mockResolvedValue(true);
    loadModelMock.mockResolvedValue({ backend: 'webgpu' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: WEBLLM_MODEL, turns: 1 });

    expect(record.outcome).toBe('completed');
    expect(loadModelMock).toHaveBeenCalled();
  });
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

describe('runSustainedProbe — estimate-size weights honor intactness', () => {
  // A heuristic-fallback plan flags its weights as estimate sizes. The probe
  // must gate on intactness (verifyIntact), NOT byte-equality against the
  // estimate — otherwise a correctly-stored weight fails the guard forever.
  const ESTIMATE_PLAN = {
    modelId: 'test/probe-model',
    files: [{ url: 'proxy/onnx/model_q4f16.onnx', sizeBytes: 999, sizeIsEstimate: true }],
  };

  it('accepts an estimate-size plan whose weights are intact even when byte-equality would refuse', async () => {
    peekDownloadPlanMock.mockResolvedValue(ESTIMATE_PLAN);
    verifyMock.mockResolvedValue(false); // byte-equality against the estimate would refuse
    verifyIntactMock.mockResolvedValue(true); // but the weight is intact
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1 });

    expect(record.outcome).toBe('completed');
    expect(loadModelMock).toHaveBeenCalled();
  });

  it('refuses an estimate-size plan when a weights entry is not intact', async () => {
    peekDownloadPlanMock.mockResolvedValue(ESTIMATE_PLAN);
    verifyIntactMock.mockResolvedValue(false);

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

describe('runSustainedProbe — context mode', () => {
  // 'fresh' re-sends the same opening prompt with no accumulated conversation
  // every turn; 'growing' (default) keeps prior turns so context/KV climb. The
  // discriminator between context-growth kills and per-turn accumulation kills.
  it('fresh mode sends exactly the turn-0 prompt, alone, on every turn', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 3, contextMode: 'fresh' });

    expect(generateMock).toHaveBeenCalledTimes(3);
    const turn0Prompt = nextTurnPrompt(0, null);
    for (const call of generateMock.mock.calls) {
      const messages = call[0] as ChatMessage[];
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ role: 'user', content: turn0Prompt });
    }
    expect(record.contextMode).toBe('fresh');
    expect(loadSustainedProbes().at(-1)?.contextMode).toBe('fresh');
  });

  it('growing mode (default) accumulates prior turns into the next turn’s messages', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 2 });

    // Turn 2's messages carry turn 1's user prompt + assistant reply ('hello').
    const secondTurn = generateMock.mock.calls[1]?.[0] as ChatMessage[];
    expect(secondTurn.length).toBeGreaterThan(1);
    expect(secondTurn[0]).toEqual({ role: 'user', content: nextTurnPrompt(0, null) });
    expect(secondTurn[1]).toEqual({ role: 'assistant', content: 'hello' });
    expect(record.contextMode).toBe('growing');
  });

  it('stamps the configured contextMode onto the start marker', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    let markerMode: string | undefined;
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    await runSustainedProbe(
      { model: MODEL, turns: 1, contextMode: 'fresh' },
      {
        onProgress: (p) => {
          if (p.phase === 'loading') markerMode = readMarker()?.contextMode;
        },
      },
    );
    expect(markerMode).toBe('fresh');
  });
});

describe('runSustainedProbe — inter-turn cooldown', () => {
  // WebKit's per-activity allocation storm collects on IDLE; an inter-turn pause
  // is the testable mitigation. Real timers + tiny budgets: fake-timer advances
  // race the runner's real dynamic-import I/O (the s32 gotcha).
  it('waits the configured cooldown between turns', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    const callTimes: number[] = [];
    generateMock.mockImplementation(() => {
      callTimes.push(Date.now());
      return tokenStream();
    });

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    await runSustainedProbe({ model: MODEL, turns: 3, cooldownMs: 40 });

    expect(callTimes).toHaveLength(3);
    // Two gaps, each ≥ ~cooldown (timer resolution slack tolerated).
    expect(callTimes[1]! - callTimes[0]!).toBeGreaterThanOrEqual(25);
    expect(callTimes[2]! - callTimes[1]!).toBeGreaterThanOrEqual(25);
  });

  it('does not pause after the last turn (cooldown is strictly inter-turn)', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const start = Date.now();
    await runSustainedProbe({ model: MODEL, turns: 1, cooldownMs: 500 });
    // A single turn has no inter-turn gap, so the 500ms cooldown never runs.
    expect(Date.now() - start).toBeLessThan(400);
  });

  it('aborts promptly mid-cooldown instead of waiting out the full pause', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const controller = new AbortController();
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const start = Date.now();
    // A 10s cooldown that must NOT be waited out: abort the moment turn 0
    // completes, mid-cooldown, and the run should settle right away.
    const record = await runSustainedProbe(
      { model: MODEL, turns: 3, cooldownMs: 10_000 },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'turn-complete') controller.abort();
        },
      },
    );
    expect(Date.now() - start).toBeLessThan(2_000);
    // Only the first turn ran; the second never started (aborted in cooldown).
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(record.turnsCompleted).toBe(1);
  });

  it('records the configured cooldownMs and stamps it onto the start marker', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    let markerCooldown: number | undefined;
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe(
      { model: MODEL, turns: 1, cooldownMs: 5000 },
      {
        onProgress: (p) => {
          if (p.phase === 'loading') markerCooldown = readMarker()?.cooldownMs;
        },
      },
    );
    expect(markerCooldown).toBe(5000);
    expect(record.cooldownMs).toBe(5000);
    expect(loadSustainedProbes().at(-1)?.cooldownMs).toBe(5000);
  });
});

describe('runSustainedProbe — post-run idle-observe', () => {
  // The s37 iPhone finding: iOS kills the tab ~5s after a SUCCESSFUL run goes
  // quiescent — but a normal completion clears the marker first, so that kill
  // left no tombstone. The observe hold quiesces ON PURPOSE with the marker
  // alive in phase 'idle-observe', ticking survived seconds. These tests pin
  // the evidence contract. Real timers, 1s windows (the tick is 1s).
  async function* errorStream(): AsyncIterable<TokenEvent> {
    yield { kind: 'error', reason: 'boom' } as unknown as TokenEvent;
  }

  it('holds after a clean run with the marker alive in phase idle-observe, then records the survived window', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const snapshots: Array<{ second: number; markerPhase?: string; markerSeconds?: number }> = [];
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe(
      { model: MODEL, turns: 1, idleObserveSeconds: 1 },
      {
        onProgress: (p) => {
          if (p.phase === 'idle-observe') {
            const m = readMarker();
            snapshots.push({ second: p.second, markerPhase: m?.phase, markerSeconds: m?.idleObservedSeconds });
          }
        },
      },
    );

    // Entry (second 0) and the tick (second 1), each with the marker live —
    // a kill at any point during the hold leaves a truthful tombstone.
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(snapshots[0]).toMatchObject({ second: 0, markerPhase: 'idle-observe', markerSeconds: 0 });
    expect(snapshots.at(-1)).toMatchObject({ second: 1, markerPhase: 'idle-observe', markerSeconds: 1 });

    expect(record.outcome).toBe('completed');
    expect(record.idleObserveSeconds).toBe(1);
    expect(record.idleObservedSeconds).toBe(1);
    expect(record.heartbeat).toBe('none');
    // Outliving the window is a clean exit — no orphaned marker.
    expect(readMarker()).toBeNull();
    expect(loadSustainedProbes().at(-1)?.idleObservedSeconds).toBe(1);
  });

  it('stamps the observe cell (window + heartbeat) onto the start marker', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    let markerWindow: number | undefined;
    let markerHeartbeat: string | undefined;
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe(
      { model: MODEL, turns: 1, idleObserveSeconds: 1, heartbeat: 'raf' },
      {
        onProgress: (p) => {
          if (p.phase === 'loading') {
            const m = readMarker();
            markerWindow = m?.idleObserveSeconds;
            markerHeartbeat = m?.heartbeat;
          }
        },
      },
    );
    expect(markerWindow).toBe(1);
    expect(markerHeartbeat).toBe('raf');
    expect(record.heartbeat).toBe('raf');
  });

  it('skips the observe hold when a turn errored (nothing to observe)', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => errorStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const start = Date.now();
    const record = await runSustainedProbe({ model: MODEL, turns: 1, idleObserveSeconds: 30 });

    // The 30s window never ran.
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(record.outcome).toBe('error');
    // The cell config is still stamped (it names what was requested) with an
    // honest zero survival — outcome 'error' explains it.
    expect(record.idleObserveSeconds).toBe(30);
    expect(record.idleObservedSeconds).toBe(0);
  });

  it('aborts promptly mid-observe and records the seconds survived so far', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const controller = new AbortController();
    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const start = Date.now();
    const record = await runSustainedProbe(
      { model: MODEL, turns: 1, idleObserveSeconds: 30 },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === 'idle-observe' && p.second === 1) controller.abort();
        },
      },
    );

    // Did NOT wait out the 30s window.
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(record.outcome).toBe('completed');
    expect(record.idleObservedSeconds).toBe(1);
    expect(readMarker()).toBeNull();
  });

  it('leaves the observe fields absent when no window was requested', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1 });

    expect(record.idleObserveSeconds).toBeUndefined();
    expect(record.idleObservedSeconds).toBeUndefined();
    expect(record.heartbeat).toBeUndefined();
  });

  it('tears the model down before the hold when teardownBeforeObserve is set, with the marker already in idle-observe', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());
    // Snapshot the marker at the moment of teardown: it must ALREADY be in
    // phase 'idle-observe' carrying the teardown flag, so a kill during the
    // teardown itself reconstructs as a 0s-survived teardown-cell death.
    let markerAtTeardown: SustainedProbeMarker | null = null;
    unloadActiveMock.mockImplementation(() => {
      markerAtTeardown = readMarker();
      return Promise.resolve(undefined);
    });

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({
      model: MODEL,
      turns: 1,
      idleObserveSeconds: 1,
      teardownBeforeObserve: true,
    });

    expect(unloadActiveMock).toHaveBeenCalledTimes(1);
    expect(markerAtTeardown).not.toBeNull();
    expect(markerAtTeardown!.phase).toBe('idle-observe');
    expect(markerAtTeardown!.teardownBeforeObserve).toBe(true);
    expect(record.outcome).toBe('completed');
    expect(record.teardownBeforeObserve).toBe(true);
    expect(record.idleObservedSeconds).toBe(1);
  });

  it('does not tear down when the flag is unset', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1, idleObserveSeconds: 1 });

    expect(unloadActiveMock).not.toHaveBeenCalled();
    expect(record.teardownBeforeObserve).toBeUndefined();
  });

  it('ignores the teardown flag when no observe window was requested', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1, teardownBeforeObserve: true });

    expect(unloadActiveMock).not.toHaveBeenCalled();
    expect(record.teardownBeforeObserve).toBeUndefined();
  });
});

describe('runSustainedProbe — UA-measure timeout', () => {
  // measureUserAgentSpecificMemory() is Chromium rate-limited and can stall a
  // LATE turn for minutes; the instrument must never block the workload it
  // measures. A stalled measure records null for that turn and flags the record.
  it('records null and flags the record when the UA measure stalls past its timeout', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());
    // A never-settling measure — the exact rate-limited-stall shape.
    measureUAMock.mockReturnValueOnce(new Promise<number | null>(() => {}));

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const start = Date.now();
    const record = await runSustainedProbe({ model: MODEL, turns: 1, uaMeasureTimeoutMs: 30 });

    // Did NOT wait out a multi-minute stall — the timeout let the turn proceed.
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(record.outcome).toBe('completed');
    expect(record.turnsCompleted).toBe(1);
    expect(record.uaMeasureTimedOut).toBe(true);
    // The stalled turn's UA sample is null, not a hung value.
    const lastSample = record.samples.at(-1);
    expect(lastSample?.measuredUAMB).toBeNull();
  });

  it('leaves the flag unset when the UA measure resolves within its timeout', async () => {
    cacheWithWeightsOnly();
    loadModelMock.mockResolvedValue({ backend: 'wasm' });
    generateMock.mockImplementation(() => tokenStream());
    measureUAMock.mockResolvedValue(123);

    const { runSustainedProbe } = await import('../sustained-probe-runner');
    const record = await runSustainedProbe({ model: MODEL, turns: 1, uaMeasureTimeoutMs: 10_000 });

    expect(record.uaMeasureTimedOut).toBeUndefined();
    expect(record.samples.at(-1)?.measuredUAMB).toBe(123);
  });
});
