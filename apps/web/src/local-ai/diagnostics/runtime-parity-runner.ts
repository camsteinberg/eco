// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runtime parity runner — drives the cross-runtime comparison through the
 * real adapter path (lifecycle.loadModel + lifecycle.generate).
 *
 * See `runtime-parity.ts` for what this is answering and how the comparison
 * is shaped. This file is the driver only.
 *
 * ## Run shape
 *
 *   1. Load model A (WebGPU), generate all 12 prompts greedy, unload.
 *   2. Load model B (WebGPU), generate all 12 prompts greedy, unload.
 *   3. (Optional) Load model A on WASM, generate all 12 prompts, unload.
 *      This gives a within-runtime baseline — how much does the SAME model
 *      differ between its own WebGPU and WASM backends? If A-vs-B diverges
 *      less than A-WebGPU-vs-A-WASM, the cross-runtime gap is noise.
 *
 * ## Guards
 *
 *   - Both models' weights must already be cached (diagnostics never download).
 *   - No runtime restriction: unlike the backend cross-check (Transformers.js
 *     only), this lane deliberately accepts any runtime — comparing a
 *     Transformers.js model against a WebLLM model is the primary use case.
 *
 * Browser-only (loads the inference worker). Pure comparison logic is
 * unit-tested in `runtime-parity.ts`; the runner is demonstrated by hand.
 */

import type { ModelConfig } from '../types';
import type { ChatMessage } from '../runtime/types';
import {
  PARITY_PROMPTS,
  RUNTIME_PARITY_MAX_TOKENS,

  compareParityOutputs,
  recordRuntimeParity,
  type PromptOutput,
  type RuntimeParityRecord,
} from './runtime-parity';
import { areProbeWeightsCached } from './sustained-probe-runner';

// ─── Config & callbacks ───────────────────────────────────────────────────

export type RuntimeParityConfig = {
  modelA: ModelConfig;
  modelB: ModelConfig;
  /** Include the optional WASM baseline arm for model A. Default false. */
  includeWasmBaseline?: boolean;
  /** Load-phase budget override in ms. */
  loadTimeoutMs?: number;
};

export type ParityArm = 'runtime-a' | 'runtime-b' | 'wasm-baseline';

export type RuntimeParityProgress =
  | { phase: 'loading'; arm: ParityArm; promptIndex: number; promptCount: number }
  | { phase: 'generating'; arm: ParityArm; promptIndex: number; promptCount: number }
  | { phase: 'prompt-complete'; arm: ParityArm; promptIndex: number; promptCount: number; ms: number }
  | { phase: 'arm-complete'; arm: ParityArm; totalMs: number }
  | { phase: 'done'; record: RuntimeParityRecord };

export type RuntimeParityCallbacks = {
  onProgress?: (progress: RuntimeParityProgress) => void;
  signal?: AbortSignal;
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Generate all prompts on a loaded model. The model must already be loaded
 * via lifecycle.loadModel before calling this.
 */
async function generateAllPrompts(
  arm: ParityArm,
  maxTokens: number,
  callbacks: RuntimeParityCallbacks,
): Promise<PromptOutput[]> {
  const { generate } = await import('../runtime/lifecycle');
  const { signal, onProgress } = callbacks;
  const outputs: PromptOutput[] = [];

  for (let i = 0; i < PARITY_PROMPTS.length; i++) {
    const prompt = PARITY_PROMPTS[i]!;
    if (signal?.aborted) throw new Error('Aborted');

    onProgress?.({ phase: 'generating', arm, promptIndex: i, promptCount: PARITY_PROMPTS.length });

    const messages: ChatMessage[] = [{ role: 'user', content: prompt.text }];
    const start = nowMs();
    let text = '';
    let generationError: string | null = null;

    for await (const event of generate(messages, { maxTokens, temperature: 0, signal })) {
      if (event.kind === 'token') text += event.text;
      else if (event.kind === 'error') generationError = event.reason;
    }

    const ms = Math.round(nowMs() - start);
    if (generationError) {
      throw new Error(`Prompt "${prompt.id}" failed on ${arm}: ${generationError}`);
    }

    const { analyzeOutput } = await import('./backend-crosscheck');
    outputs.push({
      promptId: prompt.id,
      text,
      quality: analyzeOutput(prompt.text, text),
      ms,
    });

    onProgress?.({ phase: 'prompt-complete', arm, promptIndex: i, promptCount: PARITY_PROMPTS.length, ms });
  }

  return outputs;
}

/**
 * Load a model, generate all prompts, unload. Returns the per-prompt outputs
 * and wall-clock total.
 */
async function runArm(
  arm: ParityArm,
  model: ModelConfig,
  maxTokens: number,
  forceWasm: boolean,
  loadBudgetMs: number,
  callbacks: RuntimeParityCallbacks,
): Promise<{ outputs: PromptOutput[]; totalMs: number }> {
  const { loadModel, unloadActive } = await import('../runtime/lifecycle');
  const { signal, onProgress } = callbacks;

  await unloadActive().catch(() => undefined);

  onProgress?.({ phase: 'loading', arm, promptIndex: 0, promptCount: PARITY_PROMPTS.length });

  const loadController = new AbortController();
  const onExternalAbort = (): void => loadController.abort();
  if (signal?.aborted) loadController.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  let loadDeadlineHit = false;
  const loadTimer = setTimeout(() => {
    loadDeadlineHit = true;
    loadController.abort();
  }, loadBudgetMs);

  try {
    await loadModel(model, { forceWasm, signal: loadController.signal });
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

  const armStart = nowMs();
  const outputs = await generateAllPrompts(arm, maxTokens, callbacks);
  const totalMs = Math.round(nowMs() - armStart);

  onProgress?.({ phase: 'arm-complete', arm, totalMs });

  return { outputs, totalMs };
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Run the runtime parity comparison. Always resolves with a record —
 * failures come back as `outcome: 'error'` rather than throwing.
 */
export async function runRuntimeParity(
  config: RuntimeParityConfig,
  callbacks: RuntimeParityCallbacks = {},
): Promise<RuntimeParityRecord> {
  const { modelA, modelB, includeWasmBaseline = false } = config;
  const maxTokens = RUNTIME_PARITY_MAX_TOKENS;
  const { onProgress } = callbacks;

  const timings: RuntimeParityRecord['timings'] = {
    runtimeAMs: null,
    runtimeBMs: null,
    wasmBaselineMs: null,
  };

  const finalize = (
    outcome: RuntimeParityRecord['outcome'],
    fields: Partial<RuntimeParityRecord>,
  ): RuntimeParityRecord => {
    const record: RuntimeParityRecord = {
      version: 1,
      recordedAt: new Date().toISOString(),
      modelIdA: modelA.id,
      modelIdB: modelB.id,
      includesWasmBaseline: includeWasmBaseline,
      outcome,
      verdict: null,
      summary: '',
      result: null,
      wasmBaseline: null,
      timings,
      error: null,
      ...fields,
    };
    recordRuntimeParity(record);
    onProgress?.({ phase: 'done', record });
    return record;
  };

  try {
    // ── Weights guard ──
    if (!(await areProbeWeightsCached(modelA))) {
      return finalize('error', {
        error: `Model A (${modelA.friendlyName}) weights are not downloaded — a parity run never downloads them.`,
      });
    }
    if (!(await areProbeWeightsCached(modelB))) {
      return finalize('error', {
        error: `Model B (${modelB.friendlyName}) weights are not downloaded — a parity run never downloads them.`,
      });
    }

    const { defaultLoadBudgetMs } = await import('../lifecycle/smoke');
    const loadBudgetMs = config.loadTimeoutMs ?? Math.max(
      defaultLoadBudgetMs(modelA),
      defaultLoadBudgetMs(modelB),
    );

    // ── Arm A: runtime A on WebGPU ──
    const armA = await runArm('runtime-a', modelA, maxTokens, false, loadBudgetMs, callbacks);
    timings.runtimeAMs = armA.totalMs;

    // ── Arm B: runtime B on WebGPU ──
    const armB = await runArm('runtime-b', modelB, maxTokens, false, loadBudgetMs, callbacks);
    timings.runtimeBMs = armB.totalMs;

    const result = compareParityOutputs(armA.outputs, armB.outputs);

    // ── Optional WASM baseline: model A on WASM ──
    let wasmBaseline = null;
    if (includeWasmBaseline) {
      try {
        const armWasm = await runArm('wasm-baseline', modelA, maxTokens, true, loadBudgetMs, callbacks);
        timings.wasmBaselineMs = armWasm.totalMs;
        wasmBaseline = compareParityOutputs(armA.outputs, armWasm.outputs);
      } catch (err) {
        // WASM failure is not fatal — the A-vs-B comparison is still valid.
        // Record the error in the summary instead.
        const msg = err instanceof Error ? err.message : String(err);
        wasmBaseline = null;
        return finalize('completed', {
          result,
          wasmBaseline: null,
          verdict: result.verdict,
          summary: `${result.summary} (WASM baseline failed: ${msg})`,
        });
      }
    }

    // Leave runtime clean.
    const { unloadActive } = await import('../runtime/lifecycle');
    await unloadActive().catch(() => undefined);

    return finalize('completed', {
      result,
      wasmBaseline,
      verdict: result.verdict,
      summary: result.summary,
    });
  } catch (err) {
    return finalize('error', { error: err instanceof Error ? err.message : String(err) });
  }
}
