// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * LiteRT-LM Web (`@litert-lm/core`) adapter — dev-only third runtime.
 *
 * Why this exists: Google AI Edge's LiteRT-LM Web runtime is the only path
 * that runs Gemma 4's quantized `.litertlm` builds in the browser. Eco's
 * Transformers.js + onnxruntime-web WebGPU stack cannot load the Gemma 4
 * block-quantized embeddings (GatherBlockQuantized is unsupported on the
 * ORT-web WebGPU EP — see pitfall-gemma4-gatherblockquantized-webgpu), and
 * the one loadable ONNX build (fp16-embed PTQ q4f16) already lost the chat #7
 * bake-off on speed + arithmetic. LiteRT memory-maps the 1.12 GB embedding
 * table (so only ~0.8 GB weights stay resident) and uses MTP speculative
 * decoding. This adapter is wired ONLY to the eval-lane candidates so a
 * holistic Gemma-via-LiteRT vs Qwen3.5-2B comparison can run; it does NOT
 * touch the shipping catalog.
 *
 * Architecture: LiteRT runs on the MAIN THREAD, dynamic-imported via the
 * engine-factory DI seam so the ~38 MB WASM runtime only loads when a litert
 * model is selected. (This mirrored the now-retired webllm-adapter.) Tests
 * inject a fake engine; production registers a factory that imports
 * `@litert-lm/core` and calls `Engine.create` (see bootstrap.ts).
 *
 * Model bytes: the factory receives an absolute same-origin proxy URL
 * (`/api/local-models/.../<file>.litertlm`); LiteRT fetches it itself, so no
 * CSP `connect-src` change is needed and no multi-GB Blob is built in RAM.
 *
 * Conversation model: Eco's `generate(messages)` gets the full history each
 * call, so we build a FRESH LiteRT conversation per generation — prior turns
 * become the `preface`, the final user turn drives `sendMessageStreaming`.
 * (KV-cache reuse across turns is left for a real integration; this is a
 * revertible spike.)
 */

import type { ModelConfig } from '../types';
import { buildProxyURL } from '../download/proxy';
import { pickStorage, type Storage } from '../download/storage';
import {
  AdapterError,
  type AdapterErrorCode,
  type ChatMessage,
  type GenerateOptions,
  type LoadOptions,
  type RuntimeAdapter,
  type RuntimeBackend,
  type TokenEvent,
} from './types';

// ─── Engine interface (minimal slice of @litert-lm/core) ────────────────────
//
// Defined here so the adapter + its tests don't import the heavy package.
// Shapes track `@litert-lm/core`'s Conversation / Message / ConversationConfig
// (verified against the published 0.13.1 .d.ts).

export type LiteRTSamplerParams = {
  /**
   * `@litert-lm/core` SamplerType enum value: 1 = TOP_K, 2 = TOP_P, 3 = GREEDY.
   * Omitted for sampled decode (the engine uses the model's default sampler with
   * the temperature/k/p below); set to GREEDY for deterministic argmax.
   */
  type?: number;
  temperature?: number;
  k?: number;
  p?: number;
  seed?: number;
};

/**
 * `@litert-lm/core` SamplerType.GREEDY — deterministic argmax decode. Mirrored
 * here as a bare integer so the adapter doesn't import the heavy package for one
 * enum value (verified against dist/wasm_binding_types.d.ts: GREEDY = 3).
 */
const LITERT_SAMPLER_GREEDY = 3;

const LITERT_STOP_SENTINELS = ['<|im_end|>', '<|end|>', '<end_of_turn>', '<eos>'] as const;

export type LiteRTSessionConfig = {
  samplerParams?: LiteRTSamplerParams;
  maxOutputTokens?: number;
};

export type LiteRTMessage = {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
};

export type LiteRTConversationConfig = {
  preface?: { messages?: LiteRTMessage[] };
  sessionConfig?: LiteRTSessionConfig;
};

export type LiteRTConversation = {
  /** Returns a ReadableStream of message chunks as generation proceeds. */
  sendMessageStreaming(message: string): ReadableStream<LiteRTMessage>;
  /** Signal cancellation of any in-flight generation. */
  cancel(): void;
  delete(): Promise<void>;
};

export type LiteRTEngine = {
  createConversation(config?: LiteRTConversationConfig): Promise<LiteRTConversation>;
  delete(): Promise<void>;
};

export type LiteRTEngineFactory = (options: {
  /**
   * The `.litertlm` bytes source. Either a `ReadableStream` of the cached bytes
   * (Eco's preferred path — the setup/download pipeline already streamed the
   * bundle to OPFS/Cache, so the engine reuses it with no re-fetch) or an
   * absolute same-origin proxy URL the engine self-fetches (fallback on a cache
   * miss). `@litert-lm/core`'s `EngineSettings.model` accepts either.
   */
  model: string | ReadableStream<Uint8Array>;
  /** Engine max context tokens (from the model's capabilities.contextTokens). */
  maxNumTokens?: number;
  /** AbortSignal — cancels the load if the engine factory honors it. */
  signal?: AbortSignal;
}) => Promise<LiteRTEngine>;

let engineFactory: LiteRTEngineFactory | null = null;

export function setLiteRTEngineFactory(factory: LiteRTEngineFactory | null): void {
  engineFactory = factory;
}

export function hasLiteRTEngineFactory(): boolean {
  return engineFactory != null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Safe timestamp: performance.now() if available, else Date.now(). */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Resolve a (possibly relative) proxy path to an absolute URL for LiteRT. */
function toAbsoluteUrl(path: string): string {
  const origin =
    typeof globalThis !== 'undefined' &&
    (globalThis as { location?: { origin?: string } }).location?.origin;
  return origin ? `${origin}${path}` : path;
}

/** Extract the text from a LiteRT message chunk (content is string or items). */
function chunkText(message: LiteRTMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('');
  }
  return '';
}

function truncateAtStopSentinel(text: string): { text: string; stopped: boolean } {
  let earliest = -1;
  for (const sentinel of LITERT_STOP_SENTINELS) {
    const index = text.indexOf(sentinel);
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index;
    }
  }

  if (earliest === -1) {
    return { text, stopped: false };
  }

  return { text: text.slice(0, earliest), stopped: true };
}

function longestStopSentinelPrefixSuffix(text: string): number {
  const maxLength = Math.min(
    text.length,
    Math.max(...LITERT_STOP_SENTINELS.map((sentinel) => sentinel.length - 1)),
  );

  for (let length = maxLength; length > 0; length--) {
    const suffix = text.slice(-length);
    if (LITERT_STOP_SENTINELS.some((sentinel) => sentinel.startsWith(suffix))) {
      return length;
    }
  }

  return 0;
}

function drainStopSentinelBuffer(pendingText: string): {
  emitText: string;
  nextPendingText: string;
  stopped: boolean;
} {
  const truncated = truncateAtStopSentinel(pendingText);
  if (truncated.stopped) {
    return { emitText: truncated.text, nextPendingText: '', stopped: true };
  }

  const retainedLength = longestStopSentinelPrefixSuffix(pendingText);
  const emitEnd = pendingText.length - retainedLength;
  return {
    emitText: pendingText.slice(0, emitEnd),
    nextPendingText: pendingText.slice(emitEnd),
    stopped: false,
  };
}

// ─── Adapter ────────────────────────────────────────────────────────────────

export type LiteRTAdapterOptions = {
  /** Override the engine factory. Defaults to the registered factory. */
  engineFactory?: LiteRTEngineFactory;
  /**
   * Storage to read the cached `.litertlm` from — the same backend the download
   * pipeline writes to. Defaults to `pickStorage()` resolved lazily at load
   * (so construction never throws when no Cache API is present). Injected in tests.
   */
  storage?: Storage;
};

export class LiteRTAdapter implements RuntimeAdapter {
  readonly runtime = 'litert' as const;
  private readonly options: LiteRTAdapterOptions;

  private engine: LiteRTEngine | null = null;
  private currentModel: ModelConfig | null = null;
  private inFlight: { cancel: () => void } | null = null;

  constructor(options: LiteRTAdapterOptions = {}) {
    this.options = options;
  }

  get isLoaded(): boolean {
    return this.engine !== null && this.currentModel !== null;
  }

  // LiteRT Web is WebGPU-only by construction.
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
        'No LiteRT engine factory registered. Call setLiteRTEngineFactory at app boot.',
        'init-failed',
        false,
      );
    }

    const artifact = model.artifact;
    // LiteRT models are a single self-contained `.litertlm` bundle.
    const filePath = artifact?.files[0];
    if (!artifact || !filePath) {
      throw new AdapterError(
        `Catalog model "${model.id}" is missing artifact.files — cannot resolve the .litertlm URL. Fix the candidate entry.`,
        'init-failed',
        false,
      );
    }

    // The download pipeline (setup → downloadModel) writes the bundle to Eco
    // storage under the RELATIVE proxy path. Read that cached copy and hand the
    // engine its byte stream so LiteRT reuses it instead of re-fetching ~2 GB
    // (the engine's own loader has no persistent cache). Fall back to the
    // absolute URL — letting LiteRT self-fetch — only on a cache miss.
    const proxyPath = buildProxyURL({
      modelId: artifact.hfId,
      revision: artifact.revision,
      filePath,
    });
    const modelSource = await this.resolveModelSource(model.id, proxyPath);

    emit?.({ phase: 'runtime-import', at: now(), note: 'litert-engine-factory' });
    emit?.({ phase: 'load-start', at: now(), note: model.id });
    options?.onLoadProgress?.(0);

    let engine: LiteRTEngine;
    try {
      engine = await factory({
        model: modelSource,
        maxNumTokens: model.capabilities.contextTokens,
        signal: options?.signal,
      });
    } catch (err) {
      emit?.({
        phase: 'load-fail',
        at: now(),
        error: errorInfo(err),
      });
      throw new AdapterError(message(err), classifyLiteRTError(err), true);
    }

    this.engine = engine;
    this.currentModel = model;
    options?.onLoadProgress?.(1);
    emit?.({ phase: 'load-finish', at: now(), note: 'backend=webgpu' });
  }

  /**
   * Prefer the cached `.litertlm` stream the download pipeline already wrote to
   * Eco storage (persistent, progress-tracked, #186 disk-backed, SHA-verified);
   * fall back to the absolute self-fetch URL on a cache miss or when storage is
   * unavailable. Never throws — `load()` handles factory errors uniformly.
   */
  private async resolveModelSource(
    modelId: string,
    proxyPath: string,
  ): Promise<string | ReadableStream<Uint8Array>> {
    const storage = this.resolveStorage();
    if (storage) {
      try {
        const cached = await storage.get({ modelId, url: proxyPath });
        if (cached?.response.body) {
          return cached.response.body;
        }
      } catch {
        // Storage read failed — fall through to the self-fetch URL.
      }
    }
    return toAbsoluteUrl(proxyPath);
  }

  private resolveStorage(): Storage | null {
    if (this.options.storage) return this.options.storage;
    try {
      return pickStorage();
    } catch {
      // No Cache API in this environment (e.g. jsdom without a fake) — the
      // self-fetch URL path still works.
      return null;
    }
  }

  async *generate(
    messages: ChatMessage[],
    options?: GenerateOptions,
  ): AsyncIterable<TokenEvent> {
    if (!this.engine) {
      throw new AdapterError('Not loaded', 'init-failed', false);
    }
    const engine = this.engine;
    const emit = options?.onLifecycleEvent;

    const last = messages[messages.length - 1];
    if (!last) {
      yield { kind: 'error', reason: 'No messages to generate from', code: 'generation-failed' };
      return;
    }

    // Fresh conversation per generation: prior turns are the preface, the
    // last turn (always the user's current message in Eco) drives generation.
    const prior = messages.slice(0, -1);

    // temperature 0 = greedy: deterministic argmax (the eval harness's
    // reproducible arm). LiteRT has no "temp 0" special-case, so map it to the
    // explicit GREEDY sampler and drop temp/k/p (ignored under argmax, and a
    // 0 temperature with a top-k/p sampler is undefined). Otherwise pass the
    // sampling profile through and let the engine use its default sampler.
    const greedy = options?.temperature === 0;
    const samplerParams: LiteRTSamplerParams = greedy
      ? { type: LITERT_SAMPLER_GREEDY }
      : {
          ...(options?.temperature != null ? { temperature: options.temperature } : {}),
          ...(options?.topK != null ? { k: options.topK } : {}),
          ...(options?.topP != null ? { p: options.topP } : {}),
        };

    const config: LiteRTConversationConfig = {
      preface: prior.length > 0
        ? { messages: prior.map((m) => ({ role: m.role, content: m.content })) }
        : undefined,
      sessionConfig: {
        samplerParams,
        maxOutputTokens: options?.maxTokens ?? 512,
      },
    };

    let aborted = false;
    let conversation: LiteRTConversation | null = null;
    const onAbort = (): void => {
      aborted = true;
      try {
        conversation?.cancel();
      } catch {
        // Best-effort.
      }
    };
    if (options?.signal) {
      if (options.signal.aborted) {
        yield { kind: 'error', reason: 'Generation aborted', code: 'aborted' };
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      try {
        conversation = await engine.createConversation(config);
      } catch (err) {
        emit?.({ phase: 'generation-fail', at: now(), error: errorInfo(err) });
        yield { kind: 'error', reason: message(err), code: classifyLiteRTError(err) };
        return;
      }
      this.inFlight = { cancel: onAbort };

      const stream = conversation.sendMessageStreaming(last.content);
      const reader = stream.getReader();

      let firstTokenEmitted = false;
      let seq = 0;
      // LiteRT may stream cumulative OR delta chunks; track the accumulated
      // text and emit only the new suffix so we render correctly either way.
      let accumulated = '';
      let pendingText = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (aborted) {
            yield { kind: 'error', reason: 'Generation aborted', code: 'aborted' };
            return;
          }
          const text = chunkText(value);
          if (!text) continue;

          let delta: string;
          if (text.startsWith(accumulated) && text.length > accumulated.length) {
            // Cumulative chunk: the new piece is the suffix.
            delta = text.slice(accumulated.length);
            accumulated = text;
          } else {
            // Delta chunk.
            delta = text;
            accumulated += text;
          }
          pendingText += delta;
          const drained = drainStopSentinelBuffer(pendingText);
          pendingText = drained.nextPendingText;

          if (drained.emitText) {
            if (!firstTokenEmitted) {
              firstTokenEmitted = true;
              emit?.({ phase: 'first-token', at: now() });
            }
            seq++;
            yield { kind: 'token', text: drained.emitText, seq };
          }

          if (drained.stopped) break;
        }
      } finally {
        reader.releaseLock();
      }

      if (pendingText) {
        if (!firstTokenEmitted) {
          firstTokenEmitted = true;
          emit?.({ phase: 'first-token', at: now() });
        }
        seq++;
        yield { kind: 'token', text: pendingText, seq };
      }

      emit?.({ phase: 'generation-complete', at: now() });
      // LiteRT's text stream carries no tokenizer token counts; `seq` counts
      // visible text chunks only, so callers must not treat it as tokenizer tok/s.
      yield { kind: 'done', completionTokens: seq };
    } catch (err) {
      if (aborted) return;
      emit?.({ phase: 'generation-fail', at: now(), error: errorInfo(err) });
      yield { kind: 'error', reason: message(err), code: classifyLiteRTError(err) };
    } finally {
      this.inFlight = null;
      if (options?.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
      if (conversation) {
        await conversation.delete().catch(() => undefined);
      }
    }
  }

  async countTokens(_text: string): Promise<null> {
    return null;
  }

  async unload(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.currentModel = null;
    if (this.inFlight) {
      try {
        this.inFlight.cancel();
      } catch {
        // Best-effort.
      }
      this.inFlight = null;
    }
    if (engine) {
      await engine.delete().catch(() => undefined);
    }
  }
}

// ─── Error helpers ───────────────────────────────────────────────────────────

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorInfo(err: unknown): { message: string; name?: string } {
  return {
    message: message(err),
    name: err instanceof Error ? err.name : undefined,
  };
}

function classifyLiteRTError(err: unknown): AdapterErrorCode {
  if (!(err instanceof Error)) return 'generation-failed';
  const msg = err.message.toLowerCase();
  // Crash classes are checked BEFORE abort: LiteRT runs on Emscripten, whose
  // OOM/fatal aborts surface as "Aborted(): out of memory" — that is a crash,
  // not a user cancel, so it must not be swallowed by the abort heuristic below.
  if (msg.includes('out of memory') || msg.includes('oom') || msg.includes('out_of_memory')) {
    return 'oom';
  }
  if (msg.includes('device') && msg.includes('lost')) {
    return 'device-lost';
  }
  if (msg.includes('webgpu') && (msg.includes('unavailable') || msg.includes('not supported'))) {
    return 'webgpu-unavailable';
  }
  // A genuine user/external abort: the DOMException name, or an "aborted"
  // message that isn't the Emscripten "Aborted()" fatal handled above.
  if (err.name === 'AbortError' || /\baborted\b/i.test(err.message)) {
    return 'aborted';
  }
  return 'generation-failed';
}
