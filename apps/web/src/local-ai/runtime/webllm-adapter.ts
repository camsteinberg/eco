// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebLLM (`@mlc-ai/web-llm`) adapter.
 *
 * Re-integrated as the WebKit survival path: MLC/WebLLM measurably
 * retains far less memory than ONNX Runtime on the same engine and was
 * confirmed to survive the exact idle-quiescence pattern that reliably
 * killed ORT on a real iPhone. Eco shipped this runtime once before
 * (retired 2026-07-10 alongside its only model, SmolLM2 — collateral, not
 * a runtime verdict) and this file is a restoration, not a fresh build.
 *
 * Owns its own download + cache independently from Eco's `Storage` seam —
 * WebLLM writes into its own Cache API namespaces (`webllm/model`,
 * `webllm/config`, `webllm/wasm`), disjoint from `eco-local-ai-<id>`. The
 * two storage layers are incompatible without a proxy, so this adapter
 * does not try to share bytes with Eco's downloader; see
 * `weightsCached()` below for how a caller can still recognize a
 * fully-cached WebLLM model without knowing that namespace directly.
 *
 * Engine factory DI seam: tests pass a fake engine factory. Production
 * registers a real `CreateMLCEngine(...)` call once a self-hosted
 * `model_lib` origin is chosen for a specific model — see
 * `bootstrap.ts`'s comment on why no production factory is registered yet.
 *
 * Cancellation:
 *   - Load: `reload()` takes NO AbortSignal (confirmed against the
 *     package's shipped `.d.ts` — a prior version of this adapter passed
 *     `{ signal }` as `chatOpts`, which the real API silently ignored,
 *     a latent no-op bug that shipped unnoticed). `unload()` DOES abort
 *     the engine's own internal `reloadController`, whose signal is
 *     threaded into every fetch `reload()` makes — calling it mid-reload
 *     makes `reload()`'s own promise reject, genuinely halting the
 *     in-flight fetches rather than merely abandoning them. That matters
 *     specifically here: careful memory behavior on WebKit is this
 *     runtime's whole reason for existing.
 *   - Generate: `engine.interruptGenerate()` is a real, purpose-built
 *     cancellation API — safe once streaming has actually started, which
 *     is the only time this adapter calls it.
 */

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
import {
  buildWebLLMAppConfig,
  stripMlcOrgPrefix,
  webllmModelLibPathFor,
} from './webllm-config';

// ─── Engine interface ──────────────────────────────────────────────────────

/**
 * Minimal slice of the MLCEngine surface that we use. Defined here so
 * tests can mock without depending on `@mlc-ai/web-llm` types.
 *
 * `reload` intentionally takes no cancellation parameter — the real
 * `MLCEngine.reload(modelId, chatOpts?)` has none. Do not add one back;
 * see the module doc comment above.
 */
export type WebLLMEngine = {
  reload(modelId: string): Promise<void>;
  chat: {
    completions: {
      create(args: {
        messages: ChatMessage[];
        stream: true;
        max_tokens?: number;
        temperature?: number;
        /**
         * With `include_usage: true`, the engine emits a FINAL chunk carrying
         * `usage` whose `choices` array is EMPTY — the only chunk that reports
         * real completion-token counts. Without it, `usage` never arrives and
         * `completionTokens` is always 0.
         */
        stream_options?: { include_usage?: boolean };
      }): Promise<AsyncIterable<{
        choices: Array<{
          delta: { content?: string };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      }>>;
    };
  };
  interruptGenerate(): void;
  unload(): Promise<void>;
};

export type WebLLMEngineFactory = (
  options: {
    modelId: string;
    /**
     * Catalog `capabilities.contextTokens` for this model — the engine caps its
     * KV-cache allocation to this via `ModelRecord.overrides.context_window_size`
     * (the model's native window is larger). Passed from the adapter, which holds
     * the full ModelConfig, so the cap tracks the catalog with no second source.
     */
    contextWindowSize: number;
    onProgress?: (loaded: number, total: number) => void;
  },
) => Promise<WebLLMEngine>;

let engineFactory: WebLLMEngineFactory | null = null;

export function setWebLLMEngineFactory(factory: WebLLMEngineFactory | null): void {
  engineFactory = factory;
}

export function hasWebLLMEngineFactory(): boolean {
  return engineFactory != null;
}

// ─── Adapter ────────────────────────────────────────────────────────────────

/** Safe timestamp: performance.now() if available, else Date.now(). */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Same-origin base for building the self-hosted appConfig; throws under SSR. */
function webllmOrigin(): string {
  const origin =
    typeof globalThis !== 'undefined' &&
    (globalThis as { location?: { origin?: string } }).location?.origin;
  if (!origin) {
    throw new AdapterError(
      'WebLLM: no window.location.origin — cannot build the self-hosted appConfig.',
      'init-failed',
      false,
    );
  }
  return origin;
}

export type WebLLMAdapterOptions = {
  /** Override the engine factory. Defaults to the registered factory. */
  engineFactory?: WebLLMEngineFactory;
  /**
   * Override how a fully-cached model is detected. Defaults to the real
   * `hasModelInCache` from `@mlc-ai/web-llm` — tests inject a fake so they
   * don't depend on the real package's Cache API usage.
   */
  hasModelInCache?: (mlcId: string) => Promise<boolean>;
};

export class WebLLMAdapter implements RuntimeAdapter {
  readonly runtime = 'webllm' as const;
  private readonly options: WebLLMAdapterOptions;

  private engine: WebLLMEngine | null = null;
  private currentModel: ModelConfig | null = null;
  private inFlight: { abort: () => void } | null = null;

  constructor(options: WebLLMAdapterOptions = {}) {
    this.options = options;
  }

  get isLoaded(): boolean {
    return this.engine !== null && this.currentModel !== null;
  }

  // WebLLM is WebGPU-only by construction; surfacing a constant makes the
  // RuntimeAdapter contract uniform across both implementations.
  get backend(): RuntimeBackend | null {
    return this.engine ? 'webgpu' : null;
  }

  get activeModel(): ModelConfig | null {
    return this.currentModel;
  }

  /**
   * MLC's `prebuiltAppConfig.model_list` (and any self-hosted `appConfig`
   * modeled on it) uses the repo name without the org prefix (e.g.
   * `'SmolLM2-1.7B-Instruct-q4f16_1-MLC'`). The catalog stores the full HF
   * id (`'mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC'`); strip the org
   * prefix to get the MLC engine id.
   */
  private mlcIdFor(model: ModelConfig): string {
    const hfId = model.artifact?.hfId;
    if (!hfId) {
      throw new AdapterError(
        `Catalog model "${model.id}" is missing artifact.hfId — cannot resolve MLC model id. Fix catalog-data.json.`,
        'init-failed',
        false,
      );
    }
    return stripMlcOrgPrefix(hfId);
  }

  async weightsCached(model: ModelConfig): Promise<boolean> {
    const mlcId = this.mlcIdFor(model);
    if (this.options.hasModelInCache) {
      return this.options.hasModelInCache(mlcId);
    }
    try {
      const webllm = await import('@mlc-ai/web-llm');
      // hasModelInCache defaults to `prebuiltAppConfig`, which does NOT contain
      // our self-hosted record — so hand it the SAME appConfig the engine factory
      // builds (same shared source of truth). Without it, findModelRecord throws
      // and the whole model reads as "not cached".
      const appConfig = buildWebLLMAppConfig(
        mlcId,
        webllmOrigin(),
        webllmModelLibPathFor(model),
        model.capabilities.contextTokens,
      );
      return await webllm.hasModelInCache(mlcId, appConfig);
    } catch {
      // No Cache API in this environment, or the check itself failed —
      // treat as "not confirmed cached" rather than throwing; the caller
      // falls back to whatever it does for an unconfirmed model.
      return false;
    }
  }

  async load(model: ModelConfig, options?: LoadOptions): Promise<void> {
    const emit = options?.onLifecycleEvent;

    if (this.engine) {
      await this.unload();
    }

    const factory = this.options.engineFactory ?? engineFactory;
    if (!factory) {
      throw new AdapterError(
        'No WebLLM engine factory registered. Call setWebLLMEngineFactory at app boot.',
        'init-failed',
        false,
      );
    }

    emit?.({ phase: 'runtime-import', at: now(), note: 'webllm-engine-factory' });

    const mlcId = this.mlcIdFor(model);

    emit?.({ phase: 'load-start', at: now(), note: model.id });

    let engine: WebLLMEngine;
    try {
      engine = await factory({
        modelId: mlcId,
        contextWindowSize: model.capabilities.contextTokens,
        onProgress: options?.onLoadProgress
          ? (loaded, total) => {
              const fraction = total > 0 ? Math.max(0, Math.min(1, loaded / total)) : 0;
              options.onLoadProgress!(fraction);
            }
          : undefined,
      });
    } catch (err) {
      emit?.({
        phase: 'load-fail',
        at: now(),
        error: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined },
      });
      throw new AdapterError(
        err instanceof Error ? err.message : String(err),
        classifyWebLLMError(err),
        true,
      );
    }

    // reload() takes no AbortSignal — but unload() aborts the engine's own
    // internal reloadController, whose signal is threaded into every fetch
    // reload() makes. Wiring the abort to a real unload() call (rather than
    // trying to pass a signal reload() doesn't accept) makes cancellation
    // genuinely halt the in-flight fetches, not just abandon them.
    let abortedDuringReload = false;
    const onAbort = (): void => {
      abortedDuringReload = true;
      void engine.unload().catch(() => undefined);
    };
    if (options?.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    // The signal fired before reload() was ever called — there is no
    // in-flight fetch for unload() (already called, above) to have
    // cancelled, and nothing will ever settle the reload() promise we'd
    // otherwise be awaiting. Fail fast instead of starting an operation we
    // already know should not run.
    if (abortedDuringReload) {
      emit?.({
        phase: 'load-fail',
        at: now(),
        error: { message: 'Load aborted before reload() could start.' },
      });
      throw new AdapterError('Load aborted before reload() could start.', 'aborted', true);
    }

    try {
      await engine.reload(mlcId);
    } catch (err) {
      options?.signal?.removeEventListener('abort', onAbort);
      emit?.({
        phase: 'load-fail',
        at: now(),
        error: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined },
      });
      // unload() already ran via onAbort if this failure was our own abort;
      // avoid calling it twice.
      if (!abortedDuringReload) {
        await engine.unload().catch(() => undefined);
      }
      throw new AdapterError(
        err instanceof Error ? err.message : String(err),
        abortedDuringReload ? 'aborted' : classifyWebLLMError(err),
        true,
      );
    }
    options?.signal?.removeEventListener('abort', onAbort);

    this.engine = engine;
    this.currentModel = model;
    emit?.({ phase: 'load-finish', at: now(), note: 'backend=webgpu' });
  }

  async *generate(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<TokenEvent> {
    if (!this.engine) {
      throw new AdapterError('Not loaded', 'init-failed', false);
    }
    const engine = this.engine;
    const emit = options?.onLifecycleEvent;
    let firstTokenEmitted = false;
    let seq = 0;

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      try {
        engine.interruptGenerate();
      } catch {
        // interruptGenerate is documented unsafe before stream — but we
        // only reach here after stream began, so this should succeed.
      }
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        yield { kind: 'error', reason: 'Generation aborted', code: 'aborted' };
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    this.inFlight = { abort: onAbort };

    let chunks: AsyncIterable<{
      choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>;
    try {
      chunks = await engine.chat.completions.create({
        messages,
        stream: true,
        max_tokens: options?.maxTokens ?? 512,
        temperature: options?.temperature ?? 0.7,
        // Ask for the trailing usage chunk — without it completionTokens is 0.
        // The drain loop below tolerates that final empty-choices chunk (no
        // token, no early break); see the finish_reason NOTE.
        stream_options: { include_usage: true },
      });
    } catch (err) {
      emit?.({
        phase: 'generation-fail',
        at: now(),
        error: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined },
      });
      yield {
        kind: 'error',
        reason: err instanceof Error ? err.message : String(err),
        code: classifyWebLLMError(err),
      };
      return;
    }

    let lastUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    try {
      for await (const chunk of chunks) {
        if (aborted) {
          yield { kind: 'error', reason: 'Generation aborted', code: 'aborted' };
          return;
        }
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            emit?.({ phase: 'first-token', at: now() });
          }
          seq++;
          yield { kind: 'token', text: delta, seq };
        }
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
        // NOTE: no break on finish_reason — the generator must run to natural
        // completion so WebLLM finalizes the request and releases its internal
        // lock; breaking here deadlocks the NEXT create() forever.
      }
      emit?.({ phase: 'generation-complete', at: now() });
      yield {
        kind: 'done',
        promptTokens: lastUsage?.prompt_tokens,
        completionTokens: lastUsage?.completion_tokens,
      };
    } catch (err) {
      if (aborted) {
        // Caller will see the abort event we already pushed.
        return;
      }
      emit?.({
        phase: 'generation-fail',
        at: now(),
        error: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined },
      });
      yield {
        kind: 'error',
        reason: err instanceof Error ? err.message : String(err),
        code: classifyWebLLMError(err),
      };
    } finally {
      this.inFlight = null;
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  async unload(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.currentModel = null;
    if (this.inFlight) {
      try {
        this.inFlight.abort();
      } catch {
        // Best-effort.
      }
      this.inFlight = null;
    }
    if (engine) {
      await engine.unload().catch(() => undefined);
    }
  }
}

// ─── Error classification ──────────────────────────────────────────────────

function classifyWebLLMError(err: unknown): import('./types').AdapterErrorCode {
  if (!(err instanceof Error)) return 'generation-failed';
  // An externally-aborted load/reload is not a crash — 'aborted' never
  // records a crash cooldown (same classification as transformers-adapter).
  if (err.name === 'AbortError' || /\babort/i.test(err.message)) {
    return 'aborted';
  }
  const msg = err.message.toLowerCase();
  if (msg.includes('out of memory') || msg.includes('oom') || msg.includes('out_of_memory')) {
    return 'oom';
  }
  if (msg.includes('device') && msg.includes('lost')) {
    return 'device-lost';
  }
  if (msg.includes('webgpu') && (msg.includes('unavailable') || msg.includes('not supported'))) {
    return 'webgpu-unavailable';
  }
  return 'generation-failed';
}
