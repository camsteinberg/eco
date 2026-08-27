// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shared runtime types.
 *
 * Two adapter implementations (Transformers.js v4 + WebLLM) conform to
 * RuntimeAdapter so lifecycle.ts can drive either uniformly.
 */

import type { ModelConfig, ModelRuntime } from '../types';
import type { CjkSuppressionTelemetry } from './cjk-suppression';
import type { KvReuseTelemetry } from './kv-cache';

// ─── Conversation shape ────────────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

// ─── Lifecycle event callback ─────────────────────────────────────────────────

/**
 * Phases the adapters can emit during load and generate. Smoke.ts
 * subscribes to capture structured diagnostics; production callers
 * pass undefined.
 */
export type LifecyclePhase =
  | 'runtime-import'
  | 'webgpu-probe'
  | 'load-start'
  | 'load-finish'
  | 'load-fail'
  | 'first-token'
  | 'generation-complete'
  | 'generation-fail';

export type LifecycleEvent = {
  phase: LifecyclePhase;
  /** Wall-clock timestamp (performance.now() if available, else Date.now()). */
  at: number;
  /** Optional human-readable note (e.g. runtime version). */
  note?: string;
  /** Error detail when phase is a failure. */
  error?: { message: string; name?: string };
};

export type OnLifecycleEvent = (event: LifecycleEvent) => void;

// ─── Adapter contract ──────────────────────────────────────────────────────

export type LoadOptions = {
  /** Force WASM regardless of WebGPU availability. */
  forceWasm?: boolean;
  /** Progress callback fired during model weight loading. 0..1. */
  onLoadProgress?: (progress: number) => void;
  /** AbortSignal cancels load partway through. */
  signal?: AbortSignal;
  /** Optional lifecycle event callback for diagnostic capture. */
  onLifecycleEvent?: OnLifecycleEvent;
};

export type GenerateOptions = {
  /** Maximum tokens to generate (default: 512). */
  maxTokens?: number;
  /** Sampling temperature (default: 0.7). 0 = greedy/argmax (the Transformers
   *  worker maps this to `do_sample:false`; the LiteRT adapter to
   *  SamplerType.GREEDY) — used by the eval harness's reproducible arm. */
  temperature?: number;
  /** The full per-model sampling profile. HONORED since the #4 Phase-1
   *  sampling-plumbing fix: the Transformers worker forwards top_p/top_k/
   *  repetition_penalty/no_repeat_ngram_size into GenerationConfig
   *  (transformers-generate-args.ts); the LiteRT adapter maps temperature/topK/
   *  topP onto its sampler params (no repetition/ngram knob). WebLLM relies on
   *  MLC's own defaults. Each key is emitted only when set, so a greedy or
   *  unprofiled call stays clean. */
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  noRepeatNgramSize?: number;
  /** AbortSignal cancels generation between tokens. */
  signal?: AbortSignal;
  /** Optional lifecycle event callback for diagnostic capture. */
  onLifecycleEvent?: OnLifecycleEvent;
};

export type TokenEvent =
  | { kind: 'token'; text: string; seq?: number }
  | { kind: 'done'; promptTokens?: number; completionTokens?: number; tokenizerName?: string; kvReuse?: KvReuseTelemetry; cjkSuppression?: CjkSuppressionTelemetry; maxInterTokenGapMs?: number | null }
  | { kind: 'error'; reason: string; code?: AdapterErrorCode };

export type AdapterErrorCode =
  | 'webgpu-unavailable'
  | 'oom'
  | 'device-lost'
  | 'init-failed'
  /** The weight files are no longer on this device and could not be fetched
   *  (evicted by the browser, then loaded offline or with the host unreachable).
   *  Not a crash: never cools the model down; the fix is a re-download once online. */
  | 'model-files-missing'
  | 'generation-failed'
  | 'timeout'
  | 'aborted'
  | 'cooldown-active'
  | 'gpu-busy-other-tab'
  | 'template-missing';

export type RuntimeBackend = 'webgpu' | 'wasm';

/**
 * The observable result of a completed model load. Carries the execution
 * provider the load ACTUALLY resolved to (`RuntimeAdapter.backend`) — a
 * `forceWasm: false` request can still fall back to WASM, and the resolved
 * value is what the evidence ledger and diagnostics need to record. `null`
 * when the adapter can't report a backend.
 */
export type LoadResult = {
  backend: RuntimeBackend | null;
};

export type RuntimeAdapter = {
  /** The runtime this adapter speaks. */
  readonly runtime: ModelRuntime;
  /** True if a model is currently loaded and ready to generate. */
  readonly isLoaded: boolean;
  /** The backend the loaded model is using, or null when unloaded. */
  readonly backend: RuntimeBackend | null;
  /** The model currently loaded, or null when unloaded. */
  readonly activeModel: ModelConfig | null;

  load(model: ModelConfig, options?: LoadOptions): Promise<void>;
  generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<TokenEvent>;
  unload(): Promise<void>;
  /**
   * Optional: true if `model`'s weights are already retrievable by this
   * adapter's OWN storage, independent of Eco's `Storage` seam. Lets a
   * caller (the sustained probe) recognize a runtime with a private cache
   * — e.g. WebLLM's `webllm/model` Cache API namespace — without every
   * caller needing to know that namespace exists. Adapters backed by
   * Eco's own storage (Transformers, LiteRT) don't need this; the probe
   * already checks Eco's storage directly for them.
   */
  weightsCached?(model: ModelConfig): Promise<boolean>;
};

// ─── Adapter errors ────────────────────────────────────────────────────────

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly recoverable: boolean;
  constructor(message: string, code: AdapterErrorCode, recoverable = true) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.recoverable = recoverable;
  }
}
