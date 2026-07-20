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
import type { DownloadPlan, PlanFileVerifier } from '../download/download';
import {
  SUSTAINED_PROBE_DEFAULT_TARGET_TOKENS,
  SUSTAINED_PROBE_DEFAULT_TURNS,
  SUSTAINED_PROBE_SAMPLE_INTERVAL_MS,
  SUSTAINED_PROBE_UA_MEASURE_TIMEOUT_MS,
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
  type SustainedProbeContextMode,
  type SustainedProbeHeartbeat,
  type SustainedProbeRecord,
  type SustainedProbeTurn,
} from './sustained-probe';

export type SustainedProbeConfig = {
  model: ModelConfig;
  /** Sequential turns to run (default 6). */
  turns?: number;
  /** Target tokens per turn (default ~200). */
  targetTokensPerTurn?: number;
  /** How context evolves across turns (default 'growing'). See the type doc. */
  contextMode?: SustainedProbeContextMode;
  /**
   * Inter-turn idle pause in ms (default 0 = back-to-back turns). Applied after
   * every turn except the last; abort-aware so a stop settles promptly. The
   * tested mitigation for WebKit's on-idle allocation collection and the
   * iPhone's pressure-GC-loses-to-back-to-back per-turn climb.
   */
  cooldownMs?: number;
  /**
   * Post-run idle hold in seconds (default 0 = end immediately, the prior
   * behavior). Runs ONLY after a fully clean run, with the crash-evidence
   * marker alive in phase 'idle-observe' ticking survival seconds — so the s37
   * iOS idle-kill (tab killed ~5s after a successful run quiesces) leaves a
   * tombstone carrying its time-to-kill instead of vanishing unrecorded.
   */
  idleObserveSeconds?: number;
  /**
   * Activity kept up during the idle-observe window (default 'none'). 'raf' =
   * near-zero-cost requestAnimationFrame ticks; 'compute' = short CPU bursts
   * (~15ms every 250ms). Discriminates whether ANY apparent activity defers
   * the iOS idle-kill or only real work does.
   */
  heartbeat?: SustainedProbeHeartbeat;
  /**
   * Tear the model down (unloadActive → worker.terminate — a FORCIBLE wasm-heap
   * free, not GC-dependent) before entering the observe window (default false;
   * meaningful only with idleObserveSeconds > 0). The s37 discriminator after
   * heartbeats failed: survival opens the unload-on-idle product lane; a kill
   * anyway proves the WebContent process retains the footprint past worker
   * termination — the airtight upstream case.
   */
  teardownBeforeObserve?: boolean;
  /**
   * Load-phase budget override (tests pass small values). Defaults to the
   * smoke gate's adaptive cold-load budget for this model + device.
   */
  loadTimeoutMs?: number;
  /**
   * Per-turn UA-memory measure deadline (tests pass small values). Defaults to
   * SUSTAINED_PROBE_UA_MEASURE_TIMEOUT_MS. On timeout the turn's UA sample is
   * null and the record is flagged, so the workload never waits on a
   * rate-limited measurement.
   */
  uaMeasureTimeoutMs?: number;
};

export type SustainedProbeProgress =
  | { phase: 'loading' }
  | { phase: 'turn-start'; turn: number; turnsRequested: number }
  | { phase: 'turn-complete'; turn: number; turnsRequested: number; record: SustainedProbeTurn }
  | { phase: 'idle-observe'; second: number; total: number }
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

/**
 * Idle for `ms`, resolving early (never rejecting) if `signal` aborts — a stop
 * must settle the pause promptly, and the loop's top-of-iteration abort check
 * then breaks the run. A zero/negative pause is a no-op (no timer scheduled).
 */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Keep the process looking busy during the idle-observe window. Returns a stop
 * function; every mode is safe to stop twice. The intensities are deliberate:
 * 'raf' is the cheapest thing that still registers as rendering activity, and
 * 'compute' is bounded (~15ms burst every 250ms ≈ 6% of one core) so the
 * heartbeat can never become the memory/thermal signal it exists to probe.
 */
function startHeartbeat(mode: SustainedProbeHeartbeat): () => void {
  if (mode === 'raf' && typeof requestAnimationFrame === 'function') {
    let live = true;
    let sink = 0;
    const tick = (): void => {
      if (!live) return;
      sink = (sink + 1) % 1_000_003;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      live = false;
      void sink;
    };
  }
  if (mode === 'compute') {
    let acc = 0;
    const timer = setInterval(() => {
      const deadline = nowMs() + 15;
      while (nowMs() < deadline) acc += Math.sqrt(acc + 1);
    }, 250);
    return () => {
      clearInterval(timer);
      void acc;
    };
  }
  return () => {};
}

/**
 * Race the (slow, Chromium rate-limited) UA-memory measure against a deadline.
 * On timeout, return `{ mb: null, timedOut: true }` so the turn proceeds
 * immediately rather than blocking on a measurement that can stall for minutes.
 * The `measure` seam defaults to the real function; tests drive it.
 */
async function measureUAWithTimeout(
  timeoutMs: number,
  measure: () => Promise<number | null> = measureUserAgentMemoryMB,
): Promise<{ mb: number | null; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ mb: null; timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ mb: null, timedOut: true }), timeoutMs);
  });
  try {
    const measured = measure().then((mb) => ({ mb, timedOut: false as const }));
    return await Promise.race([measured, deadline]);
  } catch {
    // A measure rejection is already swallowed inside measureUserAgentMemoryMB,
    // but stay null-safe if a test seam throws.
    return { mb: null, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  getStorage: () => PlanFileVerifier,
): Promise<boolean> {
  try {
    const plan = await peekPlan(model);
    if (!plan) return false;
    const weights = plan.files.filter((f) => isWeightsFile(f.url, f.sizeBytes));
    if (weights.length === 0) return false;
    const storage = getStorage();
    for (const file of weights) {
      // Same estimate-aware rule as download.ts verifyPlanFile: a heuristic
      // estimate size is a progress figure, never an integrity criterion — check
      // intactness (or presence) for an estimate-flagged file, exact
      // byte-equality for a reviewed size. Fails closed.
      const key = { modelId: plan.modelId, url: file.url };
      let ok: boolean;
      if (file.sizeIsEstimate !== true) {
        ok = await storage.verify(key, file.sizeBytes);
      } else if (storage.verifyIntact) {
        ok = await storage.verifyIntact(key);
      } else if (storage.has) {
        ok = await storage.has(key);
      } else {
        ok = false;
      }
      if (!ok) return false;
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
  const contextMode = config.contextMode ?? 'growing';
  const cooldownMs = config.cooldownMs ?? 0;
  const idleObserveSeconds = config.idleObserveSeconds ?? 0;
  const heartbeat = config.heartbeat ?? 'none';
  const teardownBeforeObserve = config.teardownBeforeObserve === true && idleObserveSeconds > 0;
  const uaMeasureTimeoutMs = config.uaMeasureTimeoutMs ?? SUSTAINED_PROBE_UA_MEASURE_TIMEOUT_MS;
  const { onProgress, signal } = callbacks;

  const levers = readActiveLevers();
  const memoryApi = detectMemoryApis();
  const startedAt = new Date().toISOString();
  const start = nowMs();

  const samples: MemorySample[] = [];
  const turns: SustainedProbeTurn[] = [];
  let uaMeasureTimedOut = false;
  // Seconds of the idle-observe window survived — mirrors the marker's
  // per-second tick so the final record and a tombstone tell the same story.
  let idleSurvivedSeconds = 0;
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
    contextMode,
    cooldownMs,
    // Observe-cell fields only when the cell asked for them — legacy cells
    // keep legacy-shaped markers, and killed-record reconstruction copies
    // exactly what is here (the #41 cell-naming invariant).
    ...(idleObserveSeconds > 0 ? { idleObserveSeconds, heartbeat } : {}),
    ...(teardownBeforeObserve ? { teardownBeforeObserve: true } : {}),
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
      contextMode,
      cooldownMs,
      ...(idleObserveSeconds > 0 ? { idleObserveSeconds, idleObservedSeconds: idleSurvivedSeconds, heartbeat } : {}),
      ...(teardownBeforeObserve ? { teardownBeforeObserve: true } : {}),
      crossOriginIsolated:
        typeof globalThis !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
      memoryApi,
      turns,
      samples,
      peakUsedJSHeapMB: peakUsedJSHeap(samples),
      error,
      // Only stamped when it actually happened, so a null UA column is
      // explainable; absent otherwise keeps clean records clean.
      ...(uaMeasureTimedOut ? { uaMeasureTimedOut: true } : {}),
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

      // 'fresh' re-sends the SAME opening prompt with no accumulated
      // conversation every turn — flat context/KV — so that surviving here while
      // 'growing' dies indicts context growth, and dying at the same turn count
      // indicts a per-turn accumulation (e.g. engine buffers). See the type doc.
      const prompt = contextMode === 'fresh' ? nextTurnPrompt(0, null) : nextTurnPrompt(turn, priorAssistant);
      const messages: ChatMessage[] =
        contextMode === 'fresh'
          ? [{ role: 'user', content: prompt }]
          : [...conversation, { role: 'user', content: prompt }];

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

      // Record the assistant reply so the next turn continues from it. Skipped
      // in 'fresh' mode, where every turn restarts from the same opening prompt.
      if (contextMode !== 'fresh') {
        priorAssistant = text;
        conversation = [...messages, { role: 'assistant', content: text }];
      }

      // A truer cross-realm number, sampled once per turn (it is slow, and
      // Chromium can rate-limit it into a multi-minute stall on a late turn) —
      // so it races a deadline: a timeout records null and lets the turn proceed.
      const ua = await measureUAWithTimeout(uaMeasureTimeoutMs);
      if (ua.timedOut) uaMeasureTimedOut = true;
      const postTurn = readMemorySample(nowMs() - start, turn + 1, undefined);
      samples.push({ ...postTurn, measuredUAMB: ua.mb });

      updateMarker({ turnsCompleted: turn + 1, phase: 'turn-complete' });
      onProgress?.({ phase: 'turn-complete', turn, turnsRequested, record: turnRecord });

      if (turnError) break; // a failed turn ends the run — later turns can't build on it

      // Inter-turn idle pause (strictly between turns — never after the last).
      // The marker already reads phase 'turn-complete', so a kill during the
      // pause reconstructs honestly as a between-turns death.
      if (cooldownMs > 0 && turn < turnsRequested - 1) {
        await abortableDelay(cooldownMs, signal);
      }
    }

    const anyError = turns.some((t) => t.error != null);

    // Post-run idle-observe hold: quiesce on purpose, with the marker ALIVE.
    // The s37 iPhone finding is that iOS kills the tab ~5s after a successful
    // run goes idle — but a normal completion clears the marker first, so that
    // kill left no tombstone. Here the marker stays in phase 'idle-observe',
    // ticking survived seconds, and finalize() only clears it if we outlive
    // the window. Clean runs only: an errored run has nothing to observe.
    if (idleObserveSeconds > 0 && !anyError && !signal?.aborted) {
      updateMarker({ phase: 'idle-observe', idleObservedSeconds: 0 });
      onProgress?.({ phase: 'idle-observe', second: 0, total: idleObserveSeconds });

      // Teardown BEFORE the hold: worker.terminate() forcibly frees the wasm
      // heap (not GC-laziness-dependent), so what remains resident afterwards
      // is what the ENGINE retains. The marker is already in 'idle-observe' at
      // 0s — a kill during teardown itself reconstructs honestly as 0s survived
      // in a teardown-labeled cell. A post-teardown sample bookmarks the level
      // the hold starts from (on engines that expose a memory API).
      if (teardownBeforeObserve) {
        const { unloadActive } = await import('../runtime/lifecycle');
        await unloadActive().catch(() => undefined);
        samples.push(readMemorySample(nowMs() - start, turns.length, undefined));
      }

      const stopHeartbeat = startHeartbeat(heartbeat);
      try {
        for (let second = 1; second <= idleObserveSeconds; second++) {
          await abortableDelay(1_000, signal);
          if (signal?.aborted) break;
          idleSurvivedSeconds = second;
          updateMarker({ idleObservedSeconds: second });
          onProgress?.({ phase: 'idle-observe', second, total: idleObserveSeconds });
        }
      } finally {
        stopHeartbeat();
      }
      // One post-observe UA measure: on engines that expose it, this is the
      // idle-settle number (did quiescence actually reclaim anything?).
      const ua = await measureUAWithTimeout(uaMeasureTimeoutMs);
      if (ua.timedOut) uaMeasureTimedOut = true;
      const postObserve = readMemorySample(nowMs() - start, turns.length, undefined);
      samples.push({ ...postObserve, measuredUAMB: ua.mb });
    }

    return finalize(anyError ? 'error' : 'completed', anyError ? 'A turn failed during the sustained run.' : null);
  } catch (err) {
    return finalize('error', err instanceof Error ? err.message : String(err));
  } finally {
    clearInterval(sampler);
  }
}

