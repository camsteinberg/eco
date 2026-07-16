// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Transformers.js v4 adapter.
 *
 * Owns a singleton worker that loads a TJS pipeline and streams tokens
 * back. The adapter sits in the main thread; the worker is the only
 * file that actually imports `@huggingface/transformers`. Worker source
 * lives at `workers/local-ai-transformers-worker.ts`.
 *
 * Storage bridge: the worker is told to use a customCache built over the
 * download `Storage` abstraction. Pre-downloaded weights are reused — no
 * re-fetch from Hugging Face.
 *
 * Worker factory is injected so tests can replace the real Worker with a
 * mock that emits events on a controllable schedule. In production,
 * `setWorkerFactory` is called once on app boot.
 *
 * AbortController gap: TJS v4 does not expose a native abort API. The
 * worker checks a per-generation `abort` message and stops emitting
 * tokens. Cancellation is best-effort — already-in-flight ONNX compute
 * cannot be interrupted; the adapter just stops surfacing its output.
 */

import { isCjkSuppressionEnabled } from '../../lib/local-model-generation-profiles';
import type { ModelConfig } from '../types';
import {
  AdapterError,
  type ChatMessage,
  type GenerateOptions,
  type LoadOptions,
  type RuntimeAdapter,
  type RuntimeBackend,
  type TokenEvent,
} from './types';
import type { SystemRoleSupport } from './chat-template-adapter';
import type { CjkSuppressionTelemetry } from './cjk-suppression';
import type { KvReuseTelemetry } from './kv-cache';
import type { Storage } from '../download/storage';
import {
  readForcedWasm,
  readForcedOrtArtifact,
  readForcedThreads,
  readForcedOrtArena,
  readForcedOrtMemPattern,
  readForcedOrtGraphOpt,
  type OrtGraphOptLevel,
} from '../device/profile';
import type { OrtArtifact } from './ort-artifact';

// ─── Worker message protocol ───────────────────────────────────────────────

/**
 * Structured-cloneable subset of GenerateOptions. AbortSignal and callback
 * functions are NOT cloneable and must NEVER cross the postMessage boundary.
 * Abort is handled by a separate {type:'abort'} message; lifecycle events
 * are captured on the main-thread side of the adapter.
 */
export type WorkerGenerateOptions = Omit<GenerateOptions, 'signal' | 'onLifecycleEvent'>;

export type WorkerInbound =
  | {
      type: 'init';
      modelId: string;
      hfId: string;
      dtype: 'q4' | 'q4f16' | 'q2f16';
      modelFriendlyName: string;
      forceWasm?: boolean;
      /**
       * Force a specific onnxruntime-web WASM artifact (measurement lever). When
       * present the worker points `env.backends.onnx.wasm.wasmPaths` at the
       * same-origin `/ort/` variant; when absent it sets nothing (today's
       * default resolution — byte-for-byte unchanged).
       */
      ortArtifact?: OrtArtifact;
      /**
       * Force the onnxruntime-web WASM thread-pool size (measurement lever).
       * Clamped to hardwareConcurrency in the worker. Absent ⇒ set nothing
       * (ort's crossOriginIsolated-keyed default).
       */
      numThreads?: number;
      /**
       * ORT session-option measurement levers (A-3 load-peak matrix). Present
       * fields become `session_options` on TJS `from_pretrained`, which flows
       * verbatim into `InferenceSession.create`; when ALL are absent the worker
       * passes no session_options at all — today's stock-ORT default,
       * byte-for-byte unchanged.
       */
      ortArena?: boolean;
      ortMemPattern?: boolean;
      ortGraphOpt?: OrtGraphOptLevel;
      storageBridgeId: string;
      externalDataChunks?: Record<string, number>;
      revision?: string;
      cjkSuppression?: boolean;
      skipModelProgressPreflight?: boolean;
    }
  | { type: 'generate'; generationId: string; messages: ChatMessage[]; options?: WorkerGenerateOptions; systemRoleStrategy?: SystemRoleSupport }
  | { type: 'abort'; generationId: string }
  | { type: 'unload' };

export type WorkerOutbound =
  | { type: 'ready'; backend: RuntimeBackend }
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'token'; generationId: string; text: string; seq: number }
  | { type: 'done'; generationId: string; promptTokens?: number; completionTokens?: number; tokenizerName?: string; kvReuse?: KvReuseTelemetry; cjkSuppression?: CjkSuppressionTelemetry }
  | { type: 'error'; generationId?: string; code: ErrorCode; message: string; details?: Record<string, unknown> };

type ErrorCode = 'webgpu-unavailable' | 'oom' | 'device-lost' | 'init-failed' | 'generation-failed' | 'timeout' | 'template-missing';

// ─── Worker DI seam ─────────────────────────────────────────────────────────

/**
 * Minimal Worker-like interface so tests can substitute a fake without
 * touching the real Worker constructor (which fetches a JS file in jsdom
 * and explodes).
 */
export type WorkerLike = {
  postMessage(message: WorkerInbound, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerOutbound>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<WorkerOutbound>) => void): void;
  terminate(): void;
};

export type WorkerFactory = () => WorkerLike;

let workerFactory: WorkerFactory | null = null;

/**
 * Register the worker factory. Called once at app boot with a
 * `() => new Worker(new URL('../../../workers/local-ai-transformers-worker.ts', import.meta.url), { type: 'module' })`
 * style factory. Tests pass a fake.
 */
export function setWorkerFactory(factory: WorkerFactory | null): void {
  workerFactory = factory;
}

export function hasWorkerFactory(): boolean {
  return workerFactory != null;
}

// ─── Storage-bridge registry ───────────────────────────────────────────────

/**
 * The worker can't share heap with the main thread, so it can't directly
 * call the download `Storage`. Bridge: the main thread registers a
 * `Storage` under a stable id; the worker is told to use a Cache API
 * name and the main thread had already populated that cache via the
 * download pipeline.
 *
 * The download pipeline writes through `CacheApiStorage` (just the
 * browser Cache API). The worker can open the SAME cache by name — both
 * threads share the Cache API origin. So the "bridge id" we pass is the
 * cache name; the worker constructs its own CacheApiStorage handle.
 *
 * For OPFS storage, this won't work — workers can't share OPFS handles.
 * For v1.0, `pickStorage({preferOpfs: false})` defaults to Cache API,
 * so the OPFS+worker combination is a documented gap for post-v1.0.
 */
export function getCacheBridgeId(model: ModelConfig): string {
  return `eco-local-ai-${sanitizeForCacheName(model.id)}`;
}

function sanitizeForCacheName(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function shouldSkipModelProgressPreflight(model: ModelConfig): boolean {
  const artifact = model.artifact;
  if (!artifact) return false;

  const identity = `${model.id} ${artifact.hfId}`.toLowerCase();
  const isQwen35 = identity.includes('qwen3.5') || identity.includes('qwen3_5');
  if (!isQwen35) return false;

  const files = artifact.files.map((file) => file.toLowerCase());
  const hasDecoder = files.some((file) => /(^|\/)decoder_model_merged(?:_|\.onnx)/.test(file));
  const hasEmbed = files.some((file) => /(^|\/)embed_tokens(?:_|\.onnx)/.test(file));
  const hasVision = files.some((file) => /(^|\/)vision_encoder(?:_|\.onnx)/.test(file));
  return hasDecoder && hasEmbed && !hasVision;
}

/** Error codes that represent permanent failures — retrying won't help. */
const NON_RECOVERABLE_CODES: ReadonlySet<ErrorCode> = new Set(['init-failed', 'template-missing']);

// ─── Adapter ────────────────────────────────────────────────────────────────

export type TransformersAdapterOptions = {
  storage: Storage;
  /** Override the worker factory for this instance. Defaults to the registered factory. */
  workerFactory?: WorkerFactory;
  /** Override the random id generator. Tests pass deterministic ids. */
  generateId?: () => string;
};

/** Safe timestamp: performance.now() if available, else Date.now(). */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export class TransformersAdapter implements RuntimeAdapter {
  readonly runtime = 'transformers' as const;

  private worker: WorkerLike | null = null;
  private workerListener: ((event: MessageEvent<WorkerOutbound>) => void) | null = null;
  private currentModel: ModelConfig | null = null;
  private currentBackend: RuntimeBackend | null = null;
  private currentGeneration: { id: string; controller: AsyncGenerationController } | null = null;
  private readonly options: TransformersAdapterOptions;

  constructor(options: TransformersAdapterOptions) {
    this.options = options;
  }

  get isLoaded(): boolean {
    return this.currentModel !== null && this.worker !== null;
  }

  get backend(): RuntimeBackend | null {
    return this.currentBackend;
  }

  get activeModel(): ModelConfig | null {
    return this.currentModel;
  }

  async load(model: ModelConfig, options?: LoadOptions): Promise<void> {
    const emit = options?.onLifecycleEvent;

    if (this.worker) {
      await this.unload();
    }

    const factory = this.options.workerFactory ?? workerFactory;
    if (!factory) {
      throw new AdapterError(
        'No Transformers.js worker factory registered. Call setWorkerFactory at app boot.',
        'init-failed',
        false,
      );
    }

    emit?.({ phase: 'runtime-import', at: now(), note: 'transformers-worker-factory' });

    this.worker = factory();
    this.currentModel = model;

    emit?.({ phase: 'load-start', at: now(), note: model.id });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const handler = (event: MessageEvent<WorkerOutbound>): void => {
        const msg = event.data;
        if (msg.type === 'ready') {
          this.currentBackend = msg.backend;
          settled = true;
          emit?.({ phase: 'load-finish', at: now(), note: `backend=${msg.backend}` });
          resolve();
          return;
        }
        if (msg.type === 'progress' && options?.onLoadProgress) {
          const fraction = msg.total > 0 ? Math.max(0, Math.min(1, msg.loaded / msg.total)) : 0;
          options.onLoadProgress(fraction);
          return;
        }
        if (msg.type === 'error') {
          settled = true;
          emit?.({
            phase: 'load-fail',
            at: now(),
            error: { message: msg.message, name: msg.code },
          });
          reject(new AdapterError(msg.message, msg.code, !NON_RECOVERABLE_CODES.has(msg.code)));
        }
      };

      this.workerListener = handler;
      this.worker!.addEventListener('message', handler);

      // An externally-aborted load is NOT a crash: 'aborted' (unlike
      // 'init-failed') never records a crash cooldown. Misclassifying this
      // locked fresh-profile users out of setup for 5 minutes after a slow
      // cold load hit the smoke deadline (prod, 2026-06-09).
      if (options?.signal) {
        if (options.signal.aborted) {
          if (!settled) reject(new AdapterError('Load aborted', 'aborted', true));
          return;
        }
        options.signal.addEventListener('abort', () => {
          if (!settled) reject(new AdapterError('Load aborted', 'aborted', true));
        }, { once: true });
      }

      const hfId = model.artifact?.hfId;
      if (!hfId) {
        reject(new AdapterError(
          `Catalog model "${model.id}" is missing artifact.hfId — cannot resolve TJS model path. Fix catalog-data.json.`,
          'init-failed',
          false,
        ));
        return;
      }

      const externalDataChunks = getOnnxExternalDataChunks(model);
      this.worker!.postMessage({
        type: 'init',
        modelId: model.id,
        hfId,
        dtype: dtypeFromFormat(model.format),
        modelFriendlyName: model.friendlyName,
        // Explicit caller intent wins; otherwise the ?eco-force-wasm override
        // applies so the CPU path can be exercised on any device.
        forceWasm: options?.forceWasm ?? (readForcedWasm() || undefined),
        // Measurement levers (?eco-force-ort-artifact / ?eco-force-threads /
        // ?eco-force-ort-{arena,mem-pattern,graph-opt}), read on the main
        // thread and threaded across the worker boundary — absent ⇒ the worker
        // sets nothing and today's defaults stand.
        ortArtifact: readForcedOrtArtifact() ?? undefined,
        numThreads: readForcedThreads() ?? undefined,
        ortArena: readForcedOrtArena() ?? undefined,
        ortMemPattern: readForcedOrtMemPattern() ?? undefined,
        ortGraphOpt: readForcedOrtGraphOpt() ?? undefined,
        storageBridgeId: getCacheBridgeId(model),
        externalDataChunks: Object.keys(externalDataChunks).length > 0 ? externalDataChunks : undefined,
        revision: model.artifact?.revision,
        // Per-model policy from the generation-profiles module: the worker
        // pre-scans the vocab for CJK token ids and gates per-generation on
        // the conversation (runtime/cjk-suppression.ts).
        cjkSuppression: isCjkSuppressionEnabled(model.id) ? true : undefined,
        skipModelProgressPreflight: shouldSkipModelProgressPreflight(model) ? true : undefined,
      });
    });
  }

  async *generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<TokenEvent> {
    if (!this.worker || !this.currentModel) {
      throw new AdapterError('Not loaded', 'init-failed', false);
    }

    const emit = options?.onLifecycleEvent;
    let firstTokenEmitted = false;

    const generateId = this.options.generateId ?? defaultGenerateId;
    const generationId = generateId();
    const controller = new AsyncGenerationController(generationId);
    this.currentGeneration = { id: generationId, controller };

    const onMessage = (event: MessageEvent<WorkerOutbound>): void => {
      const msg = event.data;
      if (msg.type === 'token' && msg.generationId === generationId) {
        if (!firstTokenEmitted) {
          firstTokenEmitted = true;
          emit?.({ phase: 'first-token', at: now() });
        }
        controller.push({ kind: 'token', text: msg.text, seq: msg.seq });
        return;
      }
      if (msg.type === 'done' && msg.generationId === generationId) {
        emit?.({ phase: 'generation-complete', at: now() });
        controller.push({
          kind: 'done',
          promptTokens: msg.promptTokens,
          completionTokens: msg.completionTokens,
          tokenizerName: msg.tokenizerName,
          kvReuse: msg.kvReuse,
          cjkSuppression: msg.cjkSuppression,
        });
        controller.close();
        return;
      }
      if (msg.type === 'error' && (msg.generationId === generationId || msg.generationId === undefined)) {
        emit?.({
          phase: 'generation-fail',
          at: now(),
          error: { message: msg.message, name: msg.code },
        });
        controller.push({ kind: 'error', reason: msg.message, code: msg.code });
        controller.close();
      }
    };

    this.worker.addEventListener('message', onMessage);

    const onAbort = (): void => {
      this.worker?.postMessage({ type: 'abort', generationId });
      controller.push({ kind: 'error', reason: 'Generation aborted', code: 'aborted' });
      controller.close();
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    // Strip non-cloneable fields (AbortSignal, callbacks) before posting.
    // The worker never needs the signal — abort is handled by a separate
    // {type:'abort'} message (see onAbort above).
    const { signal: _signal, onLifecycleEvent: _lce, ...workerOptions } = options ?? {};
    this.worker.postMessage({
      type: 'generate',
      generationId,
      messages,
      options: workerOptions,
      systemRoleStrategy: this.currentModel?.systemRoleSupport ?? 'native',
    });

    try {
      for await (const event of controller.iterate()) {
        yield event;
      }
    } finally {
      this.worker?.removeEventListener('message', onMessage);
      this.currentGeneration = null;
    }
  }

  async unload(): Promise<void> {
    if (!this.worker) return;
    try {
      this.worker.postMessage({ type: 'unload' });
    } catch {
      // Worker may already be terminated.
    }
    if (this.workerListener) {
      try {
        this.worker.removeEventListener('message', this.workerListener);
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      this.worker.terminate();
    } catch {
      // Best-effort cleanup.
    }
    this.worker = null;
    this.workerListener = null;
    this.currentModel = null;
    this.currentBackend = null;
    if (this.currentGeneration) {
      this.currentGeneration.controller.close();
      this.currentGeneration = null;
    }
  }
}

// ─── Async generation controller ───────────────────────────────────────────

/**
 * A tiny push/pull bridge. The worker message handler pushes events
 * via `push(event)`. The async iterator yields them in order. `close()`
 * ends the iterator after the queue drains.
 */
class AsyncGenerationController {
  readonly id: string;
  private readonly queue: TokenEvent[] = [];
  private readonly waiters: Array<(event: IteratorResult<TokenEvent>) => void> = [];
  private closed = false;

  constructor(id: string) {
    this.id = id;
  }

  push(event: TokenEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined, done: true });
    }
  }

  iterate(): AsyncIterable<TokenEvent> {
    const next = (): Promise<IteratorResult<TokenEvent>> => {
      const head = this.queue.shift();
      if (head !== undefined) {
        return Promise.resolve({ value: head, done: false });
      }
      if (this.closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve) => {
        this.waiters.push(resolve);
      });
    };
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<TokenEvent> => ({ next }),
    };
  }
}

function defaultGenerateId(): string {
  return `gen-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

/**
 * Derive the TJS dtype from the catalog model format. Computed once in the
 * adapter (main thread) and sent to the worker so `chooseDtype` in the worker
 * doesn't need to inspect the model id string — which would break now that
 * we send hfId instead of catalog id.
 */
function dtypeFromFormat(format: string): 'q4' | 'q4f16' | 'q2f16' {
  if (format === 'onnx-q4') return 'q4';
  if (format === 'onnx-q2f16') return 'q2f16';
  // onnx-q4f16 or anything else → q4f16
  return 'q4f16';
}

/**
 * Derive the per-file ONNX external-data chunk map from a model's pinned
 * artifact file list, e.g. `{ 'model_q4f16.onnx': 1 }` or, for multi-chunk
 * exports, `{ 'decoder_model_merged_q4f16.onnx': 2, 'embed_tokens_q4f16.onnx': 1 }`.
 *
 * Why a map and not a boolean: TJS resolves `use_external_data_format` as
 * `options value ?? config['transformers.js_config'] value` — an options-level
 * boolean `true` would CLOBBER a repo's per-file chunk-count map and mount only
 * chunk 0 (silently truncating multi-chunk models like Qwen3.5-4B, whose q4f16
 * decoder ships as `.onnx_data` + `.onnx_data_1`). Deriving the exact map from
 * the pinned artifact list is always correct: it equals `true` for single-chunk
 * repos that omit the config key (the original Phi-3 "Module.MountedFiles is
 * not available" fix), and it carries real chunk counts for multi-chunk repos.
 *
 * Keys are basenames (no `onnx/` subfolder) because TJS's
 * `resolveExternalDataFormat` looks up by the constructed file name
 * (`{session}{dtype-suffix}.onnx`), not the repo-relative path. Chunk names
 * follow the TJS convention `{file}_data`, `{file}_data_1`, …
 */
export function getOnnxExternalDataChunks(model: ModelConfig): Record<string, number> {
  const files = model.artifact?.files;
  if (!files) return {};
  const chunks: Record<string, number> = {};
  for (const file of files) {
    if (!file.endsWith('.onnx')) continue;
    const base = file.slice(file.lastIndexOf('/') + 1);
    let count = 0;
    while (files.includes(`${file}_data${count === 0 ? '' : `_${count}`}`)) {
      count++;
    }
    if (count > 0) chunks[base] = count;
  }
  return chunks;
}
