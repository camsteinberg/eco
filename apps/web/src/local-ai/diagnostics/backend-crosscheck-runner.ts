// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Backend cross-check runner — drives the WebGPU/WASM comparison through the
 * SAME runtime seam real chat uses (`lifecycle.loadModel` + `lifecycle.generate`).
 *
 * See `backend-crosscheck.ts` for what this is catching and why the comparison
 * is shaped the way it is. This file is the driver only.
 *
 * ## Run shape
 *
 *   1. load on WebGPU  → generate (arm A1)
 *   2. unload, reload on WebGPU → generate (arm A2)
 *   3. unload, reload with `forceWasm` → generate (arm B)
 *
 * (A1, A2) is the same-backend NOISE FLOOR; (B, A1) is the cross-backend
 * comparison, with the WASM arm as the reference. The reload between A1 and A2
 * is deliberate: it makes the noise-floor pair an apples-to-apples control for
 * the cross-backend pair — same unload, same fresh session, same cold-ish load,
 * with ONLY the backend differing. A same-session repeat would understate
 * variance and flatter the threshold.
 *
 * ## Backend forcing
 *
 * Per-run, not page-level. `LoadOptions.forceWasm` already threads from
 * `loadModel` → `TransformersAdapter.load` → the inference worker, and explicit
 * caller intent beats the `?eco-force-wasm` URL override — so passing an
 * explicit `false` for the WebGPU arms keeps the run honest even on a page that
 * was opened with the force flag set. A page-level force could not express
 * "both backends in one run" at all.
 *
 * Each arm then VERIFIES the backend it actually got (`adapter.backend`) rather
 * than assuming the request was honoured: a device with no usable WebGPU
 * silently serves both arms on WASM, and comparing WASM against WASM would
 * produce a confident, meaningless "consistent". That case is reported as an
 * error, not a pass.
 *
 * ## Guards
 *
 *   - Transformers.js models only (see the scope note in `backend-crosscheck.ts`).
 *   - Weights must already be cached — a diagnostics run never downloads
 *     hundreds of megabytes as a side effect. Same rule, and the same helper,
 *     as the sustained probe.
 *
 * Browser-only (it loads the inference worker), so there is no jsdom unit
 * coverage here; the pure comparison logic in `backend-crosscheck.ts` is
 * unit-tested instead, and the live run is demonstrated by hand.
 */

import type { ModelConfig } from '../types';
import type { ChatMessage, RuntimeBackend } from '../runtime/types';
import {
  CROSS_CHECK_MAX_TOKENS,
  CROSS_CHECK_PROMPT,
  compareOutputs,
  explainWasmLoadFailure,
  judgeCrossCheck,
  measureSimilarity,
  recordBackendCrossCheck,
  type BackendCrossCheckRecord,
} from './backend-crosscheck';
import { areProbeWeightsCached } from './sustained-probe-runner';

export type BackendCrossCheckConfig = {
  model: ModelConfig;
  /** Override the fixed prompt. Defaults to `CROSS_CHECK_PROMPT`. */
  prompt?: string;
  /** Override the token cap. Defaults to `CROSS_CHECK_MAX_TOKENS`. */
  maxTokens?: number;
  /** Load-phase budget override. Defaults to the smoke gate's adaptive budget. */
  loadTimeoutMs?: number;
};

/** Which generation is in flight. */
export type CrossCheckArm = 'webgpu' | 'webgpu-repeat' | 'wasm';

export type BackendCrossCheckProgress =
  | { phase: 'loading'; arm: CrossCheckArm }
  | { phase: 'generating'; arm: CrossCheckArm }
  | { phase: 'arm-complete'; arm: CrossCheckArm; backend: RuntimeBackend | null; ms: number }
  | { phase: 'done'; record: BackendCrossCheckRecord };

export type BackendCrossCheckCallbacks = {
  onProgress?: (progress: BackendCrossCheckProgress) => void;
  signal?: AbortSignal;
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** One arm: load with the requested backend, generate greedily, unload. */
async function runArm(
  arm: CrossCheckArm,
  model: ModelConfig,
  messages: ChatMessage[],
  maxTokens: number,
  forceWasm: boolean,
  loadBudgetMs: number,
  callbacks: BackendCrossCheckCallbacks,
): Promise<{ text: string; backend: RuntimeBackend | null; ms: number }> {
  const { loadModel, generate, unloadActive } = await import('../runtime/lifecycle');
  const { onProgress, signal } = callbacks;

  // A previous arm's adapter must be gone before the next load: loadModel
  // no-ops when the SAME model is already active, which would silently serve
  // the WASM arm from the still-loaded WebGPU session.
  await unloadActive().catch(() => undefined);

  onProgress?.({ phase: 'loading', arm });

  // Same load-deadline discipline as the sustained probe: a load that never
  // settles must fail by deadline rather than hang the panel forever.
  const loadController = new AbortController();
  const onExternalAbort = (): void => loadController.abort();
  if (signal?.aborted) loadController.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  let loadDeadlineHit = false;
  const loadTimer = setTimeout(() => {
    loadDeadlineHit = true;
    loadController.abort();
  }, loadBudgetMs);

  let backend: RuntimeBackend | null;
  try {
    // `forceWasm` is passed EXPLICITLY on both arms (including `false`) so the
    // adapter uses caller intent instead of falling back to ?eco-force-wasm.
    const adapter = await loadModel(model, { forceWasm, signal: loadController.signal });
    backend = adapter.backend;
  } catch (err) {
    if (loadDeadlineHit) {
      throw new Error(
        `The ${arm} arm's model load exceeded its ${Math.round(loadBudgetMs / 1000)}s budget and was aborted.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(loadTimer);
    signal?.removeEventListener('abort', onExternalAbort);
  }

  onProgress?.({ phase: 'generating', arm });

  const start = nowMs();
  let text = '';
  let generationError: string | null = null;
  // temperature 0 ⇒ `do_sample: false` in the worker (greedy/argmax). Nothing
  // else is set, so no per-model sampling profile, repetition penalty or
  // n-gram ban can differ between the arms and confound the comparison.
  for await (const event of generate(messages, { maxTokens, temperature: 0, signal })) {
    if (event.kind === 'token') text += event.text;
    else if (event.kind === 'error') generationError = event.reason;
  }
  const ms = Math.round(nowMs() - start);

  if (generationError) {
    throw new Error(`The ${arm} arm failed to generate: ${generationError}`);
  }

  onProgress?.({ phase: 'arm-complete', arm, backend, ms });
  return { text, backend, ms };
}

/**
 * Run the backend cross-check for one model. Always resolves with a record —
 * failures come back as `outcome: 'error'` with a readable reason rather than
 * throwing, matching the sustained probe.
 */
export async function runBackendCrossCheck(
  config: BackendCrossCheckConfig,
  callbacks: BackendCrossCheckCallbacks = {},
): Promise<BackendCrossCheckRecord> {
  const { model } = config;
  const prompt = config.prompt ?? CROSS_CHECK_PROMPT;
  const maxTokens = config.maxTokens ?? CROSS_CHECK_MAX_TOKENS;
  const { onProgress } = callbacks;

  const outputs = { webgpu: '', webgpuRepeat: '', wasm: '' };
  const timings: BackendCrossCheckRecord['timings'] = {
    webgpuMs: null,
    webgpuRepeatMs: null,
    wasmMs: null,
  };
  let webgpuBackend: RuntimeBackend | null = null;
  let wasmBackend: RuntimeBackend | null = null;

  const finalize = (
    outcome: BackendCrossCheckRecord['outcome'],
    fields: Partial<BackendCrossCheckRecord>,
  ): BackendCrossCheckRecord => {
    const record: BackendCrossCheckRecord = {
      version: 1,
      recordedAt: new Date().toISOString(),
      modelId: model.id,
      prompt,
      maxTokens,
      outcome,
      verdict: null,
      summary: '',
      webgpuBackend,
      wasmBackend,
      noiseFloor: null,
      cross: null,
      timings,
      outputs,
      error: null,
      ...fields,
    };
    recordBackendCrossCheck(record);
    onProgress?.({ phase: 'done', record });
    return record;
  };

  // ── Scope guard: this failure class, and this comparison, are ONNX-only ──
  if (model.runtime !== 'transformers') {
    return finalize('error', {
      error:
        `${model.friendlyName} runs on the ${model.runtime} runtime, which has no WASM lane to compare against — ` +
        'the backend cross-check covers the Transformers.js/ONNX runtime only.',
    });
  }

  try {
    // ── Weights guard: a diagnostics run never downloads weights ──
    if (!(await areProbeWeightsCached(model))) {
      return finalize('error', {
        error:
          'Model weights are not fully downloaded on this device — a cross-check run never downloads them. ' +
          'Download the model first, then re-run.',
      });
    }

    const { defaultLoadBudgetMs } = await import('../lifecycle/smoke');
    const loadBudgetMs = config.loadTimeoutMs ?? defaultLoadBudgetMs(model);
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

    // ── Arm A1: WebGPU ──
    const a1 = await runArm('webgpu', model, messages, maxTokens, false, loadBudgetMs, callbacks);
    outputs.webgpu = a1.text;
    timings.webgpuMs = a1.ms;
    webgpuBackend = a1.backend;
    if (a1.backend !== 'webgpu') {
      return finalize('error', {
        error:
          `This device served the WebGPU arm on "${a1.backend ?? 'unknown'}" instead. Both arms would run on the ` +
          'same backend, so there is nothing to cross-check here — the comparison needs a device with a usable WebGPU adapter.',
      });
    }

    // ── Arm A2: WebGPU again, after a full reload — the noise floor ──
    const a2 = await runArm('webgpu-repeat', model, messages, maxTokens, false, loadBudgetMs, callbacks);
    outputs.webgpuRepeat = a2.text;
    timings.webgpuRepeatMs = a2.ms;

    // The same-backend noise floor is now known, and it is worth keeping even if
    // the WASM arm never runs: "these two WebGPU generations agreed exactly" is
    // real evidence on its own, and losing it to a WASM-side failure would throw
    // away the only measurement some models can currently produce.
    const noiseFloor = measureSimilarity(a1.text, a2.text);

    // ── Arm B: WASM — the reference ──
    let b: { text: string; backend: RuntimeBackend | null; ms: number };
    try {
      b = await runArm('wasm', model, messages, maxTokens, true, loadBudgetMs, callbacks);
    } catch (err) {
      // The likeliest failure by far is the CPU EP lacking a kernel the WebGPU EP
      // has, which is structural rather than a quality signal — say so plainly
      // instead of surfacing a bare ORT "ERROR_CODE: 9".
      const raw = err instanceof Error ? err.message : String(err);
      return finalize('error', { noiseFloor, error: explainWasmLoadFailure(raw) ?? raw });
    }
    outputs.wasm = b.text;
    timings.wasmMs = b.ms;
    wasmBackend = b.backend;
    if (b.backend !== 'wasm') {
      return finalize('error', {
        noiseFloor,
        error:
          `The forced-WASM arm reported backend "${b.backend ?? 'unknown'}" — the force did not take, so the ` +
          'comparison would be WebGPU against WebGPU.',
      });
    }

    // Leave the runtime clean: the next thing that loads a model should not
    // inherit this run's WASM session.
    const { unloadActive } = await import('../runtime/lifecycle');
    await unloadActive().catch(() => undefined);

    const cross = compareOutputs(prompt, b.text, a1.text);
    const judged = judgeCrossCheck(noiseFloor, cross);

    return finalize('completed', {
      noiseFloor,
      cross,
      verdict: judged.verdict,
      summary: judged.summary,
    });
  } catch (err) {
    return finalize('error', { error: err instanceof Error ? err.message : String(err) });
  }
}
