// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Stream-shape adapter between the v1 local-AI runtime and useChat.
 *
 * `useChat.ts` consumes local inference as `ReadableStream<string>` with
 * confidence/usage written into a side-channel store. The v1 runtime's
 * `lifecycle.generate(...)` returns `AsyncIterable<TokenEvent>` and emits
 * usage on the terminating `done` event. This adapter bridges the two
 * contracts so useChat doesn't have to know about iterators.
 *
 * The translation is one-directional and additive: nothing else in
 * `local-ai/` knows the ReadableStream shape exists. A future refactor of
 * useChat's local-AI branch to consume `AsyncIterable<TokenEvent>` directly
 * would remove this adapter; until then it is the stable interop point.
 *
 * Scope (deliberate, non-bloat):
 *   - Bootstrap is idempotent — calling generate() before bootstrap finishes
 *     is fine; bootstrapLocalAi() resolves immediately for repeat callers.
 *   - Model id → ModelConfig via `catalog.getModel`. Local validation can also
 *     resolve eval-only candidates while the mission harness is enabled; those
 *     ids still error in production. If the id is not in the allowed set (e.g.,
 *     a stale slot binding from a prior install), the stream errors with
 *     `LocalInferenceStreamError('NOT_IN_CATALOG')` so the v1 chat-path refuses
 *     honestly rather than silently misroute.
 *   - `loadModel` is called once per (shim, modelId) pair. Repeat generate()
 *     calls on the same shim/model reuse the already-loaded adapter.
 *   - Errors from `loadModel` and from the iterator are translated from
 *     `AdapterErrorCode` into `LocalInferenceStreamError.code` so the
 *     existing `applyLocalGenerationError` in useChat keeps matching.
 *   - Signal-driven abort: the shim owns an `AbortController` per generate()
 *     call; `stream.cancel()` triggers `controller.abort()`. The lifecycle's
 *     `generate` forwards the signal to the adapter, which stops yielding.
 *   - Sampling profile: the snake_case legacy knobs (`top_p`, `top_k`,
 *     `repetition_penalty`, `no_repeat_ngram_size`) are mapped to their
 *     camelCase `GenerateOptions` equivalents (`topP`, `topK`,
 *     `repetitionPenalty`, `noRepeatNgramSize`) and forwarded to the runtime
 *     when present, alongside `maxTokens` / `temperature`. The runtime honors
 *     the full per-model profile rather than a temperature-only fallback.
 *
 * Out of scope (and why):
 *   - Cascade-on-runtime-error: mid-chat model swap is worse UX than
 *     surface-and-act. The cascade lives in setup (`useLocalAiSetup`) where
 *     a fallback is honest. Live-chat errors bubble to the user.
 *   - Confidence: legacy worker computed a heuristic; the v1 catalog models
 *     don't emit one. The chat store accepts null.
 */

'use client';

import { bootstrapLocalAi } from '../bootstrap';
import { getModel } from '../catalog/catalog';
import { getEvalCandidateModel } from '../eval/eval-candidates';
import {
  generate as lifecycleGenerate,
  loadModel as lifecycleLoadModel,
} from '../runtime/lifecycle';
import {
  AdapterError,
  type AdapterErrorCode,
  type ChatMessage,
  type LifecycleEvent,
  type LoadOptions,
} from '../runtime/types';
import type { ModelConfig } from '../types';
import { setLastUsage, setLastTemplateName } from '../runtime/usage-store';
import { LocalInferenceStreamError } from '../runtime/errors';
import { TEMPLATE_MISSING_USER_MESSAGE } from './error-messages';
import {
  getValidationLocalGenerationFixture,
  isValidationHarnessEnabled,
} from '../../lib/validation-harness';
import { logger } from '../../lib/logger';

// ─── Legacy contract — what useChat expects ────────────────────────────────

/**
 * Mirrors the subset of GenerateOptions in `lib/local-inference-runtime.ts`
 * that the v1 path can honor. The snake_case sampling knobs are mapped to
 * their camelCase `GenerateOptions` equivalents and forwarded to the runtime
 * (see `generate`). `continueFinalMessage` is forwarded so a resumed reply is
 * finished rather than restarted; `supervisorNested` is accepted for
 * caller-shape parity but not consumed.
 */
export type LegacyGenerateOptions = {
  max_new_tokens?: number;
  temperature?: number;
  // Forwarded to the v1 runtime as topP / topK / repetitionPenalty /
  // noRepeatNgramSize when present.
  top_p?: number;
  top_k?: number;
  repetition_penalty?: number;
  no_repeat_ngram_size?: number;
  continueFinalMessage?: boolean;
  supervisorNested?: boolean;
  // Cold-load affordance plumbing. Both are pure pass-through to the runtime —
  // the shim stays state-free (it does not read chatStore). A caller (chat) uses
  // `onLifecycleEvent` to learn when compile finishes (`load-finish`) so it can
  // flip an "almost ready" hint. `onLifecycleEvent` is forwarded to BOTH the load
  // AND the generate options, so the caller also sees the generation phases
  // (`first-token`, `generation-complete`/`-fail`) for breadcrumb capture.
  // `onLoadProgress` is forwarded for other callers; the chat path deliberately
  // ignores it (cached cold-load byte progress is misleading — see useChat).
  onLoadProgress?: (fraction: number) => void;
  onLifecycleEvent?: (event: LifecycleEvent) => void;
};

export type LegacyMessage = ChatMessage;

export type LocalAiLegacyInference = {
  generate(
    messages: LegacyMessage[],
    modelId: string,
    options?: LegacyGenerateOptions,
  ): ReadableStream<string>;
};

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Build a per-instance shim. Each useChat hook instance memoizes its own
 * shim; per-instance scoping mirrors the legacy `useLocalInference()` hook
 * lifecycle.
 *
 * The shim is intentionally state-free with respect to "which model is
 * loaded" — that question is owned by `runtime/lifecycle`, which serializes
 * load/unload under a lock and no-ops repeat loads of the active model. We
 * delegate, rather than maintain a parallel cache that could go stale when
 * external code (Settings → Switch AI, `unloadActive`, etc.) mutates the
 * lifecycle's adapter between generate() calls.
 */
export function createLocalAiLegacyInference(): LocalAiLegacyInference {
  async function ensureLoaded(
    model: ModelConfig,
    loadOptions?: LoadOptions,
  ): Promise<void> {
    // Both are safe to call repeatedly: bootstrap is idempotent, and
    // lifecycle.loadModel returns the active adapter without re-loading
    // when the same model id is already active. Calling unconditionally
    // is correct under any external state mutation.
    await bootstrapLocalAi();
    await lifecycleLoadModel(model, loadOptions);
  }

  function generate(
    messages: LegacyMessage[],
    modelId: string,
    options?: LegacyGenerateOptions,
  ): ReadableStream<string> {
    const model = getRuntimeModel(modelId);
    if (!model) {
      return errorStream(
        new LocalInferenceStreamError(
          'NOT_IN_CATALOG',
          'That model isn\'t available on this device. Choose an available model in Settings → Eco.',
          true,
        ),
      );
    }

    const maxTokens = options?.max_new_tokens;
    const temperature = options?.temperature;
    const topP = options?.top_p;
    const topK = options?.top_k;
    const repetitionPenalty = options?.repetition_penalty;
    const noRepeatNgramSize = options?.no_repeat_ngram_size;
    const continueFinalMessage = options?.continueFinalMessage;
    const onLoadProgress = options?.onLoadProgress;
    const onLifecycleEvent = options?.onLifecycleEvent;
    const abortController = new AbortController();
    // Load options forwarded to the runtime. `signal` is always present so an
    // abort during the (potentially minutes-long) cold load cancels the load
    // rather than waiting it out; the progress/lifecycle callbacks are omitted
    // when the caller didn't supply them (house spread-omit style).
    const loadOptions: LoadOptions = {
      signal: abortController.signal,
      ...(onLoadProgress != null ? { onLoadProgress } : {}),
      ...(onLifecycleEvent != null ? { onLifecycleEvent } : {}),
    };
    // Reset per-generation usage and template name so stale values from a
    // previous run cannot bleed into this message's possiblyTruncated /
    // token-count / receipt surface in useChat (legacy worker reset on
    // every start; the shim must match that contract).
    setLastUsage(null);
    setLastTemplateName(null);

    return new ReadableStream<string>({
      start(controller) {
        const run = async () => {
          try {
            const validationFixture = getValidationLocalGenerationFixture(model.id);
            if (validationFixture) {
              for (const chunk of validationFixture.chunks) {
                if (abortController.signal.aborted) {
                  controller.close();
                  return;
                }
                controller.enqueue(chunk);
              }
              setLastUsage({
                maxTokens: validationFixture.chunks.join('').length,
                promptTokens: 0,
                completionTokens: validationFixture.chunks.length,
              });
              controller.close();
              return;
            }

            try {
              await ensureLoaded(model, loadOptions);
            } catch (err) {
              // A load-phase OOM means the model doesn't fit this device right
              // now — a different problem (and different advice) from a
              // mid-reply OOM, which is usually the prompt's size.
              if (err instanceof AdapterError && err.code === 'oom') {
                throw new LocalInferenceStreamError('LOAD_OOM', err.message, true);
              }
              throw err;
            }
            if (abortController.signal.aborted) {
              // Consumer cancelled while we were loading.
              controller.close();
              return;
            }
            const iter = lifecycleGenerate(messages, {
              signal: abortController.signal,
              ...(maxTokens != null ? { maxTokens } : {}),
              ...(temperature != null ? { temperature } : {}),
              ...(topP != null ? { topP } : {}),
              ...(topK != null ? { topK } : {}),
              ...(repetitionPenalty != null ? { repetitionPenalty } : {}),
              ...(noRepeatNgramSize != null ? { noRepeatNgramSize } : {}),
              ...(continueFinalMessage ? { continueFinalMessage: true } : {}),
              // Forwarded to the generation phase too (same callback as load), so
              // the caller sees `first-token` / `generation-complete` / `-fail`
              // for breadcrumb capture. Omitted when the caller didn't supply it.
              ...(onLifecycleEvent != null ? { onLifecycleEvent } : {}),
            });
            let lastUsageRecorded = false;
            for await (const event of iter) {
              if (event.kind === 'token') {
                controller.enqueue(event.text);
              } else if (event.kind === 'done') {
                setLastUsage({
                  ...(event.promptTokens != null ? { promptTokens: event.promptTokens } : {}),
                  ...(event.completionTokens != null ? { completionTokens: event.completionTokens } : {}),
                  ...(maxTokens != null ? { maxTokens } : {}),
                  ...(event.kvReuse != null ? { kvReuse: event.kvReuse } : {}),
                  ...(event.cjkSuppression != null ? { cjkSuppression: event.cjkSuppression } : {}),
                  ...(event.maxInterTokenGapMs !== undefined
                    ? { maxInterTokenGapMs: event.maxInterTokenGapMs }
                    : {}),
                });
                setLastTemplateName(event.tokenizerName ?? null);
                if (process.env.NODE_ENV !== 'production' && event.kvReuse != null) {
                  // Dev-only: makes per-turn reuse decisions readable straight
                  // off the console during multi-turn TTFT investigations.
                  logger.info('[eco/kv-reuse]', event.kvReuse);
                }
                if (process.env.NODE_ENV !== 'production' && event.cjkSuppression?.enabled) {
                  // Dev-only, opt-in models only (everyday-default turns stay
                  // quiet): per-turn CJK-guard decision off the console.
                  logger.info('[eco/cjk-suppression]', event.cjkSuppression);
                }
                lastUsageRecorded = true;
              } else if (event.kind === 'error') {
                controller.error(translateAdapterError(event.code, event.reason));
                return;
              }
            }
            if (!lastUsageRecorded && maxTokens != null) {
              // Adapter ended without emitting `done` — still record the
              // requested budget so downstream "possibly truncated" logic
              // has something to work with.
              setLastUsage({ maxTokens });
            }
            controller.close();
          } catch (err) {
            if (err instanceof AdapterError) {
              controller.error(translateAdapterError(err.code, err.message));
            } else if (err instanceof LocalInferenceStreamError) {
              controller.error(err);
            } else {
              const message = err instanceof Error ? err.message : String(err);
              controller.error(new LocalInferenceStreamError('LOCAL_INFERENCE_FAILED', message));
            }
          }
        };
        void run();
      },
      cancel() {
        abortController.abort();
      },
    });
  }

  return { generate };
}

function getRuntimeModel(modelId: string): ModelConfig | null {
  const catalogModel = getModel(modelId);
  if (catalogModel) return catalogModel;

  if (!isValidationHarnessEnabled()) {
    return null;
  }

  return getEvalCandidateModel(modelId);
}

// ─── Error translation ─────────────────────────────────────────────────────

/**
 * Map the v1 adapter's error codes onto the legacy `LocalInferenceStreamError`
 * codes that `applyLocalGenerationError` in useChat already handles. Each
 * legacy code triggers a specific UI branch (cooldown banner, OOM advice,
 * device-protection notice, etc.) — preserving them keeps the v1 chat path
 * visually identical to legacy from the user's perspective.
 */
function translateAdapterError(
  code: AdapterErrorCode | undefined,
  message: string,
): LocalInferenceStreamError {
  switch (code) {
    case 'cooldown-active':
      // Dedicated UI branch in useChat (LOCAL_MODEL_COOLDOWN) that
      // preserves the "Ns left" countdown from the original message.
      return new LocalInferenceStreamError('LOCAL_MODEL_COOLDOWN', message, true);
    case 'oom':
      return new LocalInferenceStreamError('OOM', message, true);
    case 'device-lost':
      return new LocalInferenceStreamError('DEVICE_LOST', message, true);
    case 'template-missing':
      return new LocalInferenceStreamError(
        'TEMPLATE_MISSING',
        TEMPLATE_MISSING_USER_MESSAGE,
        false,
      );
    case 'gpu-busy-other-tab':
      // Another tab owns the GPU (single-tab ownership prevents the concurrent
      // WebGPU device-init crash). Recoverable: retrying after the other tab
      // releases the GPU succeeds.
      return new LocalInferenceStreamError('GPU_BUSY_OTHER_TAB', message, true);
    case 'model-files-missing':
      // The weights are gone from this device and could not be fetched. Its
      // own useChat branch says so (offline vs. online wording) — never the
      // "needed a moment" crash card, which would tell the person to retry
      // something that cannot work until they reconnect.
      return new LocalInferenceStreamError('MODEL_FILES_MISSING', message, true);
    case 'webgpu-unavailable':
    case 'init-failed':
      return new LocalInferenceStreamError('WORKER_CRASHED', message, true);
    case 'timeout':
      return new LocalInferenceStreamError('TIMEOUT', message, true);
    case 'aborted':
      // Aborts are user-initiated; surface as a generic error so the caller's
      // abort branch (which checks abortController.signal.aborted) wins.
      return new LocalInferenceStreamError('ABORTED', message, true);
    case 'generation-failed':
    default:
      return new LocalInferenceStreamError('LOCAL_INFERENCE_FAILED', message, true);
  }
}

function errorStream(err: LocalInferenceStreamError): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.error(err);
    },
  });
}
