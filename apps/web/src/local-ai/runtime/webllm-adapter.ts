// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebLLM (`@mlc-ai/web-llm`) adapter.
 *
 * Used only on Chromium WebGPU per `runtime-router.canRunWebLLM`. Owns
 * its own download + cache independently from the download `Storage` —
 * WebLLM's `cacheBackend: 'opfs'` (or 'cache' / 'indexeddb') manages a
 * private weight cache that doesn't read existing OPFS files. The two
 * storage layers are incompatible without a proxy, so we don't try to
 * share bytes; the catalog includes the WebLLM `model_lib` URL and the
 * weight URL — both routed through Eco's `/api/local-models` proxy.
 *
 * Engine factory DI seam: tests pass a fake engine factory. Production
 * registers `() => CreateMLCEngine(...)` from the real package.
 *
 * Cancellation: WebLLM has `engine.interruptGenerate()` — only safe
 * during active streaming. The adapter only calls it during a generate
 * iteration that was started with stream:true.
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

// ─── Engine interface ──────────────────────────────────────────────────────

/**
 * Minimal slice of the MLCEngine surface that we use. Defined here so
 * tests can mock without depending on `@mlc-ai/web-llm` types.
 */
export type WebLLMEngine = {
  reload(modelId: string, options?: { signal?: AbortSignal }): Promise<void>;
  chat: {
    completions: {
      create(args: {
        messages: ChatMessage[];
        stream: true;
        max_tokens?: number;
        temperature?: number;
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
  options: { modelId: string; onProgress?: (loaded: number, total: number) => void },
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

export type WebLLMAdapterOptions = {
  /** Override the engine factory. Defaults to the registered factory. */
  engineFactory?: WebLLMEngineFactory;
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

    // MLC's prebuiltAppConfig.model_list uses the repo name without the
    // org prefix (e.g. 'SmolLM2-1.7B-Instruct-q4f16_1-MLC'). The catalog
    // stores the full HF id ('mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC');
    // strip the org prefix to get the MLC engine id.
    const hfId = model.artifact?.hfId;
    if (!hfId) {
      throw new AdapterError(
        `Catalog model "${model.id}" is missing artifact.hfId — cannot resolve MLC model id. Fix catalog-data.json.`,
        'init-failed',
        false,
      );
    }
    const mlcId = hfId.replace(/^mlc-ai\//, '');

    emit?.({ phase: 'load-start', at: now(), note: model.id });

    let engine: WebLLMEngine;
    try {
      engine = await factory({
        modelId: mlcId,
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

    try {
      await engine.reload(mlcId, { signal: options?.signal });
    } catch (err) {
      emit?.({
        phase: 'load-fail',
        at: now(),
        error: { message: err instanceof Error ? err.message : String(err), name: err instanceof Error ? err.name : undefined },
      });
      try {
        await engine.unload();
      } catch {
        // Best-effort cleanup.
      }
      throw new AdapterError(
        err instanceof Error ? err.message : String(err),
        classifyWebLLMError(err),
        true,
      );
    }

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
        if (chunk.choices[0]?.finish_reason) {
          break;
        }
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
