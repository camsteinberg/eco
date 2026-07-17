// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Sustained-probe runner — drives N sequential generations through the SAME
 * runtime seam real chat uses (lifecycle.loadModel + lifecycle.generate),
 * sampling memory throughout and persisting a shareable record.
 *
 * Browser-only (loads the inference worker), so it has no jsdom unit coverage —
 * the pure memory/marker logic in `sustained-probe.ts` is unit-tested instead.
 * Kept out of `sustained-probe.ts` so that module stays import-light for tests.
 */

import type { ModelConfig } from '../types';
import type { ChatMessage } from '../runtime/types';
import type { DownloadPlan } from '../download/download';
import {
  SUSTAINED_PROBE_DEFAULT_TARGET_TOKENS,
  SUSTAINED_PROBE_DEFAULT_TURNS,
  SUSTAINED_PROBE_SAMPLE_INTERVAL_MS,
  clearMarker,
  detectMemoryApis,
  detectWebGpuApi,
  measureUserAgentMemoryMB,
  nextTurnPrompt,
  peakUsedJSHeap,
  readActiveLevers,
  readMemorySample,
  recordSustainedProbe,
  updateMarker,
  writeMarker,
  type MemorySample,
  type SustainedProbeRecord,
  type SustainedProbeTurn,
} from './sustained-probe';

export type SustainedProbeConfig = {
  model: ModelConfig;
  /** Sequential turns to run (default 6). */
  turns?: number;
  /** Target tokens per turn (default ~200). */
  targetTokensPerTurn?: number;
  /**
   * Load-phase budget override (tests pass small values). Defaults to the
   * smoke gate's adaptive cold-load budget for this model + device.
   */
  loadTimeoutMs?: number;
};

export type SustainedProbeProgress =
  | { phase: 'loading' }
  | { phase: 'turn-start'; turn: number; turnsRequested: number }
  | { phase: 'turn-complete'; turn: number; turnsRequested: number; record: SustainedProbeTurn }
  | { phase: 'sample'; sample: MemorySample }
  | { phase: 'done'; record: SustainedProbeRecord };

export type SustainedProbeCallbacks = {
  onProgress?: (progress: SustainedProbeProgress) => void;
  signal?: AbortSignal;
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** A plan file counts as weights when it is ONNX-shaped or simply large —
 *  either way, a fall-through download of it is what the guard exists to
 *  prevent. 32 MiB comfortably clears every config/tokenizer file (≤ ~10 MB)
 *  while catching every weights shard in the catalog. */
const WEIGHTS_FILE_MIN_BYTES = 32 * 1024 * 1024;

function isWeightsFile(url: string, sizeBytes: number): boolean {
  return /\.onnx($|_data)/.test(url) || sizeBytes >= WEIGHTS_FILE_MIN_BYTES;
}

/**
 * True when every weights-class file in the model's download plan verifies in
 * the same storage the runtime's cache bridge reads (Cache API by default).
 * Injected plan/storage come from the runner's dynamic imports; kept as
 * parameters so tests drive it through the same seams.
 */
async function probeWeightsCached(
  model: ModelConfig,
  peekPlan: (m: ModelConfig) => Promise<DownloadPlan | null>,
  getStorage: () => { verify(key: { modelId: string; url: string }, expectedSizeBytes: number): Promise<boolean> },
): Promise<boolean> {
  try {
    const plan = await peekPlan(model);
    if (!plan) return false;
    const weights = plan.files.filter((f) => isWeightsFile(f.url, f.sizeBytes));
    if (weights.length === 0) return false;
    const storage = getStorage();
    for (const file of weights) {
      if (!(await storage.verify({ modelId: plan.modelId, url: file.url }, file.sizeBytes))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Panel-facing wrapper over the same weights-scoped check the run guard uses,
 * wired to the real plan resolver and storage. Lets the diagnostics panel show
 * weights state — and offer a download — BEFORE a run, instead of the probe
 * erroring out on a device that has no other way to stage the bytes (the
 * normal download journey is compatibility-gated, e.g. WebKit-mobile).
 */
export async function areProbeWeightsCached(model: ModelConfig): Promise<boolean> {
  const { peekDownloadPlan } = await import('../download/download');
  const { pickStorage } = await import('../download/storage');
  return probeWeightsCached(model, peekDownloadPlan, pickStorage);
}

/**
 * Run the sustained probe. Loads the model, runs `turns` generations whose
 * prompts build on prior output, samples memory every ~1s, and persists a
 * `completed` or `error` record. The crash-evidence marker is written at start
 * and cleared on any clean exit — an unclean exit (tab kill) leaves it for the
 * next mount to recover as a `killed` record.
 */
export async function runSustainedProbe(
  config: SustainedProbeConfig,
  callbacks: SustainedProbeCallbacks = {},
): Promise<SustainedProbeRecord> {
  const { model } = config;
  const turnsRequested = config.turns ?? SUSTAINED_PROBE_DEFAULT_TURNS;
  const targetTokens = config.targetTokensPerTurn ?? SUSTAINED_PROBE_DEFAULT_TARGET_TOKENS;
  const { onProgress, signal } = callbacks;

  const levers = readActiveLevers();
  const memoryApi = detectMemoryApis();
  const startedAt = new Date().toISOString();
  const start = nowMs();

  const samples: MemorySample[] = [];
  const turns: SustainedProbeTurn[] = [];
  let backend: string | null = null;
  let priorAssistant: string | null = null;
  // Conversation accumulated across turns so context/KV grow turn over turn.
  let conversation: ChatMessage[] = [];

  const takeSample = (turn: number): void => {
    const sample = readMemorySample(nowMs() - start, turn, undefined);
    samples.push(sample);
    onProgress?.({ phase: 'sample', sample });
  };

  // Crash-evidence marker: present ⇒ a probe is running; a surviving marker
  // after the tab dies is the WebKit tab-kill signal.
  writeMarker({
    startedAt,
    modelId: model.id,
    turnsRequested,
    targetTokensPerTurn: targetTokens,
    levers,
    turnsCompleted: 0,
    phase: 'loading',
    backend: null,
    webgpuApiPresent: detectWebGpuApi(),
  });

  const sampler = setInterval(() => {
    takeSample(turns.length);
  }, SUSTAINED_PROBE_SAMPLE_INTERVAL_MS);

  const finalize = (outcome: SustainedProbeRecord['outcome'], error: string | null): SustainedProbeRecord => {
    const record: SustainedProbeRecord = {
      version: 1,
      recordedAt: new Date().toISOString(),
      modelId: model.id,
      backend,
      outcome,
      turnsRequested,
      turnsCompleted: turns.filter((t) => t.error == null).length,
      targetTokensPerTurn: targetTokens,
      levers,
      crossOriginIsolated:
        typeof globalThis !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
      memoryApi,
      turns,
      samples,
      peakUsedJSHeapMB: peakUsedJSHeap(samples),
      error,
    };
    recordSustainedProbe(record);
    // Clean exit — drop the marker so the next mount doesn't read a false kill.
    clearMarker();
    onProgress?.({ phase: 'done', record });
    return record;
  };

  try {
    const { loadModel, generate } = await import('../runtime/lifecycle');
    const { peekDownloadPlan } = await import('../download/download');
    const { pickStorage } = await import('../download/storage');
    onProgress?.({ phase: 'loading' });

    // A probe never downloads WEIGHTS. Without this guard, loading an
    // un-cached model falls through to TJS's internal remote fetch — a silent
    // multi-hundred-MB single-GET (observed 504ing through the dev proxy,
    // s32). Deliberately scoped to weights-class files rather than
    // `isModelFullyCached`: the manifest plan lists files TJS never requests
    // (vocab.json, merges.txt, …), so full-plan completeness reads false on a
    // cache populated by real loads. Small config/tokenizer fall-throughs are
    // bounded and cannot distort a memory measurement; the weights are what
    // wedge. Fails closed: no plan, no weights entry, or a verify error all
    // refuse.
    if (!(await probeWeightsCached(model, peekDownloadPlan, pickStorage))) {
      return finalize(
        'error',
        'Model weights are not fully downloaded on this device — a probe run never downloads them. Use “Download weights” in this panel, then re-run.',
      );
    }

    // Load-phase deadline, same physics as the smoke gate's cold-load budget.
    // The observed wedge (s32): a load whose failure never settles the promise
    // leaves the panel at "Running…" with a LIVE crash-evidence marker — and an
    // orphaned marker fabricates a false `killed` record on next mount. The
    // deadline aborts through the same signal the adapter honors, so the load
    // settles even when the worker never reports back.
    const { defaultLoadBudgetMs } = await import('../lifecycle/smoke');
    const loadBudgetMs = config.loadTimeoutMs ?? defaultLoadBudgetMs(model);
    const loadController = new AbortController();
    const onExternalAbort = (): void => loadController.abort();
    // An already-aborted external signal must propagate too — the 'abort'
    // event never fires retroactively.
    if (signal?.aborted) loadController.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    let loadDeadlineHit = false;
    const loadTimer = setTimeout(() => {
      loadDeadlineHit = true;
      loadController.abort();
    }, loadBudgetMs);

    let adapter;
    try {
      adapter = await loadModel(model, { signal: loadController.signal });
    } catch (err) {
      if (loadDeadlineHit) {
        return finalize(
          'error',
          `Model load exceeded its ${Math.round(loadBudgetMs / 1000)}s budget and was aborted — recorded as a load error, not a tab kill.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(loadTimer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
    backend = adapter.backend;
    // Load settled — record the confirmed backend so an orphaned marker from a
    // later kill no longer needs the WebGPU-presence hint.
    updateMarker({ backend });

    takeSample(0);

    for (let turn = 0; turn < turnsRequested; turn++) {
      if (signal?.aborted) break;
      updateMarker({ phase: 'turn-in-flight' });
      onProgress?.({ phase: 'turn-start', turn, turnsRequested });

      const prompt = nextTurnPrompt(turn, priorAssistant);
      // Grow the conversation: keep prior turns so context/KV climb turn over turn.
      const messages: ChatMessage[] = [...conversation, { role: 'user', content: prompt }];

      const turnStart = nowMs();
      let firstTokenAt: number | null = null;
      let text = '';
      let promptTokens: number | null = null;
      let completionTokens: number | null = null;
      let turnError: string | null = null;

      try {
        for await (const event of generate(messages, { maxTokens: targetTokens, signal })) {
          if (event.kind === 'token') {
            firstTokenAt ??= nowMs();
            text += event.text;
          } else if (event.kind === 'done') {
            promptTokens = event.promptTokens ?? null;
            completionTokens = event.completionTokens ?? null;
          } else {
            turnError = event.reason;
          }
        }
      } catch (err) {
        turnError = err instanceof Error ? err.message : String(err);
      }

      const elapsed = nowMs() - turnStart;
      const ttftMs = firstTokenAt != null ? Math.round(firstTokenAt - turnStart) : null;
      const tokensPerSecond =
        completionTokens != null && elapsed > 0 ? Math.round((completionTokens / elapsed) * 1000 * 10) / 10 : null;

      const turnRecord: SustainedProbeTurn = {
        turn,
        promptTokens,
        completionTokens,
        cumulativeContextTokens: promptTokens,
        ttftMs,
        tokensPerSecond,
        error: turnError,
      };
      turns.push(turnRecord);

      // Record the assistant reply so the next turn continues from it.
      priorAssistant = text;
      conversation = [...messages, { role: 'assistant', content: text }];

      // A truer cross-realm number, sampled once per turn (it is slow).
      const uaMB = await measureUserAgentMemoryMB();
      const postTurn = readMemorySample(nowMs() - start, turn + 1, undefined);
      samples.push({ ...postTurn, measuredUAMB: uaMB });

      updateMarker({ turnsCompleted: turn + 1, phase: 'turn-complete' });
      onProgress?.({ phase: 'turn-complete', turn, turnsRequested, record: turnRecord });

      if (turnError) break; // a failed turn ends the run — later turns can't build on it
    }

    const anyError = turns.some((t) => t.error != null);
    return finalize(anyError ? 'error' : 'completed', anyError ? 'A turn failed during the sustained run.' : null);
  } catch (err) {
    return finalize('error', err instanceof Error ? err.message : String(err));
  } finally {
    clearInterval(sampler);
  }
}

