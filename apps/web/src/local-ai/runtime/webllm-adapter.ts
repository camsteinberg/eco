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

import type { LogitProcessor } from '@mlc-ai/web-llm';
import type { ModelConfig } from '../types';
import { StreamLogprobAccumulator } from './confidence';
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
import { PromptRepetitionPenalty } from './webllm-prompt-penalty';

// ─── Engine interface ──────────────────────────────────────────────────────

/**
 * Shape of a single streamed chunk from `chat.completions.create`.
 *
 * Mirrors `ChatCompletionChunk.Choice` from the shipped `.d.ts` at
 * `@mlc-ai/web-llm/lib/openai_api_protocols/chat_completion.d.ts`:
 *   - `logprobs.content` is `Array<ChatCompletionTokenLogprob> | null`
 *   - each `ChatCompletionTokenLogprob` has `{ token, bytes, logprob,
 *     top_logprobs: Array<TopLogprob> }` (top_logprobs is NOT optional)
 *   - each `TopLogprob` has `{ token, bytes, logprob }`
 *
 * A chunk may carry more than one entry in `content` (multi-token
 * chunks), so callers must iterate the full array.
 */
export type WebLLMChunk = {
  choices: Array<{
    delta: { content?: string };
    finish_reason?: string;
    logprobs?: {
      content: Array<{
        logprob: number;
        top_logprobs: Array<{ logprob: number }>;
      }> | null;
    } | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

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
        /** Nucleus sampling mass, from the model's sampling profile. */
        top_p?: number;
        /**
         * Repetition penalty, from the model's sampling profile. MLC applies it
         * to the logits before sampling, so it shapes a greedy call too — but
         * only over the tokens generated this round, never the prompt; see
         * `PromptRepetitionPenalty`.
         */
        repetition_penalty?: number;
        /** Request per-token log-probabilities on each chunk. */
        extra_body?: { enable_thinking?: boolean | null };
        logprobs?: boolean;
        /** How many top alternatives to include alongside the chosen token. */
        top_logprobs?: number;
        /**
         * With `include_usage: true`, the engine emits a FINAL chunk carrying
         * `usage` whose `choices` array is EMPTY — the only chunk that reports
         * real completion-token counts. Without it, `usage` never arrives and
         * `completionTokens` is always 0.
         */
        stream_options?: { include_usage?: boolean };
      }): Promise<AsyncIterable<WebLLMChunk>>;
    };
  };
  interruptGenerate(): void;
  /**
   * Clears the engine's stored conversation and KV cache. The adapter calls it
   * before every request so the whole `messages` array is prefilled — see the
   * multi-round note in `generate()`. The real signature takes optional
   * `(keepStats?, modelId?)` arguments; the adapter needs neither.
   */
  resetChat(): Promise<void>;
  unload(): Promise<void>;
  /** Optional: encode text to token ids (for countTokens support). */
  tokenize?: (text: string) => number[] | Promise<number[]>;
  /**
   * The real engine's loaded pipelines, keyed by MLC model id. NOT public API:
   * read only to install the prompt-wide repetition penalty (`mlcPipelineOf`
   * below). `@mlc-ai/web-llm` is pinned exact, so a version bump must re-check
   * the fields `MlcPipeline` names.
   */
  loadedModelIdToPipeline?: Map<string, unknown>;
};

export type WebLLMEngineFactory = (
  options: {
    modelId: string;
    /**
     * Same-origin path to the vendored `model_lib` wasm for this model.
     * Resolved per-model by `webllmModelLibPathFor` — the adapter passes it
     * so the factory never needs to know about the model-library map.
     */
    modelLibPath: string;
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
        modelLibPath: webllmModelLibPathFor(model),
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

    // Effective temperature: the adapter defaults to 0.7 when not specified.
    const effectiveTemp = options?.temperature ?? 0.7;
    const isGreedy = effectiveTemp === 0;
    const confidenceAcc = new StreamLogprobAccumulator();
    // The loaded entry is the only thing that says whether this model HAS a
    // thinking mode; see the note on `extra_body` below.
    const hasThinkingMode = this.currentModel?.quirks?.hasThinkingMode === true;

    let chunks: AsyncIterable<WebLLMChunk>;
    try {
      // WebLLM holds its own copy of the conversation. When the incoming
      // `messages` minus the last entry match that copy it takes a "multiround
      // chatting" branch and prefills ONLY the last round, answering from the
      // KV cache it already holds (`lib/index.js:13305-13331`). Eco assembles
      // the whole prompt itself every turn — system prompt, history selection,
      // budget — so that reuse silently discards the assembler's decisions:
      // measured live, the model started repeating its previous reply from
      // turn 2 while its prompt-token count collapsed from 202 to 35-72.
      // Clearing the conversation first forces the full `messages` array to be
      // prefilled, which is the arm that answered a four-turn walk correctly.
      // A failure here shares the create() failure path below: it means the
      // engine cannot serve this request either.
      await engine.resetChat();

      // WebLLM penalises only the tokens generated this round, so the profile's
      // repetition penalty is applied here over the whole prompt as well, by a
      // logit processor installed on the loaded pipeline for this request (see
      // `webllm-prompt-penalty.ts`). Installed directly rather than through the
      // engine's `logitProcessorRegistry` because a registered processor makes
      // the engine copy every token's logits (the full vocabulary) GPU→CPU→GPU
      // for EVERY request (`lib/index.js:11005`); set per request, a turn with
      // no penalty clears it and costs exactly what it did before.
      const penalty = options?.repetitionPenalty;
      const pipeline = this.currentModel
        ? mlcPipelineOf(engine, this.mlcIdFor(this.currentModel))
        : null;
      const promptPenalty =
        pipeline && penalty != null && penalty !== 1
          ? new PromptRepetitionPenalty(penalty, () => renderedPromptIds(pipeline))
          : undefined;
      if (pipeline) pipeline.logitProcessor = promptPenalty;

      chunks = await engine.chat.completions.create({
        messages,
        stream: true,
        max_tokens: options?.maxTokens ?? 512,
        temperature: effectiveTemp,
        // The sampling profile's two knobs this engine has. Emitted ONLY when
        // set — the rule `transformers-generate-args.ts` follows, and for the
        // same reason: an unprofiled call must fall through to the engine's own
        // defaults rather than receive `undefined`. Neither is suppressed at
        // temperature 0, because the Transformers path forwards the profile
        // under greedy too and MLC applies the repetition penalty to the logits
        // before the argmax; dropping them here would make the two runtimes
        // sample the same model differently. `topK` has no counterpart on this
        // engine (see the note on GenerateOptions.topP in types.ts) and is not
        // forwarded. With the prompt-wide processor installed the engine is
        // sent 1.0 — not omitted, since an omitted key falls back to the
        // model config's own penalty — so no token is penalised twice.
        ...(options?.topP != null ? { top_p: options.topP } : {}),
        ...(penalty != null
          ? { repetition_penalty: promptPenalty ? 1 : penalty }
          : {}),
        logprobs: true,
        top_logprobs: 1,
        // Qwen3-family chat templates default to the <think> reasoning mode;
        // the Transformers worker renders with `enable_thinking: false` and
        // this lane must match, or the same model answers differently per
        // runtime and every reply carries a reasoning block. Sent ONLY to a
        // model whose entry declares the mode: WebLLM does not check, and on
        // `false` it encodes "<think>\n\n</think>\n\n", pushes those tokens
        // into the output and prepends the block to the reply header for ANY
        // model (`lib/index.js:10309`) — so a model without the mode would
        // carry the block in every reply, and in every later prompt once the
        // reply returns as history.
        ...(hasThinkingMode ? { extra_body: { enable_thinking: false } } : {}),
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
    let lastFinishReason: string | undefined;
    try {
      for await (const chunk of chunks) {
        if (aborted) {
          yield { kind: 'error', reason: 'Generation aborted', code: 'aborted' };
          return;
        }
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) {
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            emit?.({ phase: 'first-token', at: now() });
          }
          seq++;
          yield { kind: 'token', text: delta, seq };
        }
        if (choice?.finish_reason) {
          lastFinishReason = choice.finish_reason;
        }
        // Accumulate top-1 logprobs. A chunk may carry multiple entries
        // in `logprobs.content` (multi-token chunks). For each entry, prefer
        // `top_logprobs[0].logprob` (the argmax token's logprob) over
        // `entry.logprob` (the sampled token's logprob) so this statistic
        // matches the Transformers path's `minTop1LogProb` / `meanTop1LogProb`
        // which always record argmax, even under sampling.
        const logprobEntries = choice?.logprobs?.content;
        if (logprobEntries != null) {
          for (const entry of logprobEntries) {
            const top1 = entry.top_logprobs[0]?.logprob ?? entry.logprob;
            confidenceAcc.recordStep(top1);
          }
        }
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
        // NOTE: no break on finish_reason — the generator must run to natural
        // completion so WebLLM finalizes the request and releases its internal
        // lock; breaking here deadlocks the NEXT create() forever.
      }
      emit?.({ phase: 'generation-complete', at: now() });
      const confidence = confidenceAcc.summarize(isGreedy);
      yield {
        kind: 'done',
        finishReason: lastFinishReason === 'length' ? 'length' : lastFinishReason === 'stop' ? 'eos' : undefined,
        promptTokens: lastUsage?.prompt_tokens,
        completionTokens: lastUsage?.completion_tokens,
        ...(confidence != null ? { confidence } : {}),
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

  async countTokens(text: string): Promise<number | null> {
    if (!this.engine?.tokenize) return null;
    try {
      const tokens = await this.engine.tokenize(text);
      return tokens.length;
    } catch {
      return null;
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

// ─── Prompt-wide repetition penalty ────────────────────────────────────────

/** The fields of WebLLM 0.2.84's `LLMChatPipeline` the penalty reads and sets. */
type MlcPipeline = {
  tokenizer: { encode(text: string): Iterable<number> };
  conversation: {
    config: { system_prefix_token_ids?: number[] | null };
    getPromptArray(config: unknown): (string | (string | object)[])[];
  };
  config: unknown;
  logitProcessor: LogitProcessor | undefined;
};

/**
 * The engine's loaded pipeline for `mlcId`, or null when it is not reachable
 * (a test fake, or a library whose internals moved). Null means the adapter
 * falls back to forwarding the penalty to WebLLM, which covers only the
 * generated tokens — the behaviour before this processor existed.
 */
function mlcPipelineOf(engine: WebLLMEngine, mlcId: string): MlcPipeline | null {
  const pipeline: unknown = engine.loadedModelIdToPipeline?.get(mlcId);
  if (typeof pipeline !== 'object' || pipeline === null) return null;
  const { tokenizer, conversation } = pipeline as {
    tokenizer?: { encode?: unknown };
    conversation?: { getPromptArray?: unknown };
  };
  return typeof tokenizer?.encode === 'function' &&
    typeof conversation?.getPromptArray === 'function'
    ? (pipeline as MlcPipeline)
    : null;
}

/**
 * The ids of the prompt the pipeline prefilled. This is the engine's own
 * `getInputData` (`lib/index.js:11205-11271`) — system prefix ids, then each
 * piece of `conversation.getPromptArray()` encoded separately — run with the
 * same tokenizer instance (built from the model's own `tokenizer.json`), so
 * the id set matches the prefilled ids exactly, template special tokens and
 * the reply header included, with no second tokenizer in memory. Read lazily:
 * the engine swaps in a new conversation during `create()`.
 */
function* renderedPromptIds(pipeline: MlcPipeline): Iterable<number> {
  const { conversation, tokenizer } = pipeline;
  yield* conversation.config.system_prefix_token_ids ?? [];
  for (const piece of conversation.getPromptArray(pipeline.config)) {
    for (const part of typeof piece === 'string' ? [piece] : piece) {
      if (typeof part === 'string') yield* tokenizer.encode(part);
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
