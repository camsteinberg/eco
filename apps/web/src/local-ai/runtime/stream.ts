// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `stream()` — the ONE path from a composed prompt to on-device tokens.
 *
 * Every dispatch path in `useChat` (send / edit / regenerate / retry /
 * offline-continue) calls this and nothing else. It is the whole distance
 * between "here is a prompt and a model id" and an `AsyncIterable<TokenEvent>`:
 *
 *   - Bootstrap (idempotent) and `loadModel` are called on EVERY stream.
 *     `runtime/lifecycle` is the single source of truth for "which model is
 *     loaded"; it serializes load/unload under a lock and no-ops a repeat load
 *     of the active model. We delegate rather than keep a parallel cache that
 *     would go stale when external code (Settings → Switch AI, `unloadActive`)
 *     mutates the lifecycle's adapter between calls.
 *   - Model id → `ModelConfig` via `catalog.getModel`. Local validation can also
 *     resolve eval-only candidates while the mission harness is enabled; those
 *     ids still fail in production. An id outside the allowed set (e.g. a stale
 *     slot binding from a prior install) throws
 *     `LocalInferenceStreamError('NOT_IN_CATALOG')` so chat refuses honestly
 *     rather than silently misrouting.
 *   - `AdapterErrorCode` is translated into `LocalInferenceStreamError.code`, so
 *     `applyLocalGenerationError` in `useChat` keeps matching. A `{kind:'error'}`
 *     event is THROWN rather than yielded: error handling stays in one place and
 *     consumers never have to re-implement the taxonomy.
 *   - `cancel()` aborts the load AND the generation. It is synchronous and
 *     idempotent, and — this is load-bearing — a cancelled stream's iterator
 *     resolves `done` immediately instead of waiting for the runtime to notice
 *     (see `abortableIterator`). The adapter still receives the signal and ends
 *     its own protocol properly (WebLLM's `interruptGenerate`); what we decline
 *     to do is block the UI on it.
 *
 * Before R4b this lived in `adapters/useChatLegacyShim.ts`, which wrapped the
 * same work in a `ReadableStream<string>` and pushed usage out through a
 * module-level side channel. `TokenEvent` carries usage on the terminating
 * `done` event, so the side channel is gone with the wrapper.
 *
 * Out of scope (and why):
 *   - Cascade-on-runtime-error: mid-chat model swap is worse UX than
 *     surface-and-act. The cascade lives in setup (`useLocalAiSetup`) where a
 *     fallback is honest. Live-chat errors bubble to the user.
 */

'use client';

import { bootstrapLocalAi } from '../bootstrap';
import { getModel } from '../catalog/catalog';
import { getEvalCandidateModel } from '../eval/eval-candidates';
import { generate as lifecycleGenerate, loadModel as lifecycleLoadModel } from './lifecycle';
import {
  AdapterError,
  type AdapterErrorCode,
  type ChatMessage,
  type LoadOptions,
  type OnLifecycleEvent,
  type TokenEvent,
} from './types';
import type { ModelConfig } from '../types';
import { LocalInferenceStreamError } from './errors';
import { TEMPLATE_MISSING_USER_MESSAGE } from '../adapters/error-messages';
import {
  getValidationLocalGenerationFixture,
  isValidationHarnessEnabled,
} from '../../lib/validation-harness';
import { logger } from '../../lib/logger';

const NOT_IN_CATALOG_MESSAGE =
  "That model isn't available on this device. Choose an available model in Settings → Eco.";

/**
 * What `useChat` consumes. An `AsyncIterable<TokenEvent>` plus a synchronous
 * `cancel()` — the stop button and the time-to-first-token watchdog both need
 * to release the runtime without awaiting anything.
 */
export type TokenStream = AsyncIterable<TokenEvent> & {
  /** Abort the load and the generation. Synchronous, idempotent. */
  cancel(): void;
};

/**
 * The sampling row plus the two load-observability callbacks. The sampling
 * fields are exactly `prompt/assemble.ts`'s `PromptOptions`, in the runtime's
 * own camelCase spelling — there is no rename anywhere on this path.
 */
export type StreamOptions = {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  noRepeatNgramSize?: number;
  /** Finish the trailing assistant turn instead of restarting the reply. */
  continueFinalMessage?: boolean;
  /**
   * Forwarded to the load only. The chat path deliberately ignores it — on a
   * cached cold load byte-fractions burn out in ~1s of a much longer
   * session-create, so they would be misleading (see `useChat`).
   */
  onLoadProgress?: (fraction: number) => void;
  /**
   * Forwarded to BOTH the load AND the generation, so a caller sees the load
   * phases (`load-finish` — the "almost ready" hint) and the generation phases
   * (`first-token`, `generation-complete`/`-fail`) on one callback.
   */
  onLifecycleEvent?: OnLifecycleEvent;
};

/** The terminating event's payload — what a caller reads usage off. */
export type DoneEvent = Extract<TokenEvent, { kind: 'done' }>;

export function stream(
  messages: ChatMessage[],
  modelId: string,
  options: StreamOptions = {},
): TokenStream {
  const abortController = new AbortController();

  async function* run(): AsyncGenerator<TokenEvent> {
    const model = getRuntimeModel(modelId);
    if (!model) {
      throw new LocalInferenceStreamError('NOT_IN_CATALOG', NOT_IN_CATALOG_MESSAGE, true);
    }

    // `signal` is always present so an abort during the (potentially
    // minutes-long) cold load cancels the load rather than waiting it out; the
    // progress/lifecycle callbacks are omitted when the caller didn't supply
    // them (house spread-omit style).
    const loadOptions: LoadOptions = {
      signal: abortController.signal,
      ...(options.onLoadProgress != null ? { onLoadProgress: options.onLoadProgress } : {}),
      ...(options.onLifecycleEvent != null ? { onLifecycleEvent: options.onLifecycleEvent } : {}),
    };

    try {
      const validationFixture = getValidationLocalGenerationFixture(model.id);
      if (validationFixture) {
        for (const chunk of validationFixture.chunks) {
          if (abortController.signal.aborted) return;
          yield { kind: 'token', text: chunk };
        }
        yield {
          kind: 'done',
          promptTokens: 0,
          completionTokens: validationFixture.chunks.length,
        };
        return;
      }

      try {
        // Both are safe to call repeatedly: bootstrap is idempotent, and
        // lifecycle.loadModel returns the active adapter without re-loading
        // when the same model id is already active.
        await bootstrapLocalAi();
        await lifecycleLoadModel(model, loadOptions);
      } catch (err) {
        // A load-phase OOM means the model doesn't fit this device right now —
        // a different problem (and different advice) from a mid-reply OOM,
        // which is usually the prompt's size.
        if (err instanceof AdapterError && err.code === 'oom') {
          throw new LocalInferenceStreamError('LOAD_OOM', err.message, true);
        }
        throw err;
      }
      if (abortController.signal.aborted) return;

      const iter = lifecycleGenerate(messages, {
        signal: abortController.signal,
        ...(options.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
        ...(options.temperature != null ? { temperature: options.temperature } : {}),
        ...(options.topP != null ? { topP: options.topP } : {}),
        ...(options.topK != null ? { topK: options.topK } : {}),
        ...(options.repetitionPenalty != null
          ? { repetitionPenalty: options.repetitionPenalty }
          : {}),
        ...(options.noRepeatNgramSize != null
          ? { noRepeatNgramSize: options.noRepeatNgramSize }
          : {}),
        ...(options.continueFinalMessage ? { continueFinalMessage: true } : {}),
        ...(options.onLifecycleEvent != null ? { onLifecycleEvent: options.onLifecycleEvent } : {}),
      });

      for await (const event of iter) {
        if (event.kind === 'error') {
          throw translateAdapterError(event.code, event.reason);
        }
        if (event.kind === 'done') logDoneTelemetry(event);
        yield event;
      }
    } catch (err) {
      // A cancelled stream ends cleanly. The consumer already unwound (see
      // `abortableIterator`), and a late abort-shaped rejection from the load
      // or the adapter is the cancellation we asked for, not a fault to show.
      if (abortController.signal.aborted) return;
      if (err instanceof LocalInferenceStreamError) throw err;
      if (err instanceof AdapterError) throw translateAdapterError(err.code, err.message);
      throw new LocalInferenceStreamError(
        'LOCAL_INFERENCE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    [Symbol.asyncIterator]: () => abortableIterator(run(), abortController.signal),
    cancel: () => abortController.abort(),
  };
}

/**
 * Wrap `inner` so that once `signal` aborts, `next()` resolves `done`
 * IMMEDIATELY rather than waiting for the runtime to come back.
 *
 * This is the property `ReadableStream.cancel()` gave us for free before R4b,
 * and the stop button depends on it: a runtime that takes a while to notice its
 * abort signal must not hold the UI, the generation lease, or the
 * time-to-first-token watchdog's unwind. The inner generator is left to finish
 * its own protocol in the background — the adapter has the signal and ends
 * properly (WebLLM's `interruptGenerate`); we simply stop waiting.
 */
function abortableIterator(
  inner: AsyncGenerator<TokenEvent>,
  signal: AbortSignal,
): AsyncIterator<TokenEvent> {
  const done: IteratorResult<TokenEvent> = { done: true, value: undefined };
  const aborted = new Promise<IteratorResult<TokenEvent>>((resolve) => {
    if (signal.aborted) {
      resolve(done);
      return;
    }
    signal.addEventListener('abort', () => resolve(done), { once: true });
  });
  return {
    next: () => Promise.race([inner.next(), aborted]),
    return: async () => {
      // `for await (... of stream)` with a `break` lands here. Ask the inner
      // generator to unwind, but never await it (same reason as above).
      void inner.return(undefined).catch(() => undefined);
      return done;
    },
  };
}

function getRuntimeModel(modelId: string): ModelConfig | null {
  const catalogModel = getModel(modelId);
  if (catalogModel) return catalogModel;
  if (!isValidationHarnessEnabled()) return null;
  return getEvalCandidateModel(modelId);
}

/** Dev-only console breadcrumbs; both are opt-in signals, not everyday noise. */
function logDoneTelemetry(event: DoneEvent): void {
  if (process.env.NODE_ENV === 'production') return;
  if (event.kvReuse != null) {
    // Makes per-turn reuse decisions readable straight off the console during
    // multi-turn TTFT investigations.
    logger.info('[eco/kv-reuse]', event.kvReuse);
  }
  if (event.cjkSuppression?.enabled) {
    // Opt-in models only (everyday-default turns stay quiet): per-turn
    // CJK-guard decision off the console.
    logger.info('[eco/cjk-suppression]', event.cjkSuppression);
  }
}

/**
 * Map the adapter's error codes onto the `LocalInferenceStreamError` codes that
 * `applyLocalGenerationError` in useChat already handles. Each code triggers a
 * specific UI branch (cooldown banner, OOM advice, device-protection notice,
 * etc.) — preserving them is what keeps the chat path's error surface honest.
 */
function translateAdapterError(
  code: AdapterErrorCode | undefined,
  message: string,
): LocalInferenceStreamError {
  switch (code) {
    case 'cooldown-active':
      // Dedicated UI branch in useChat (LOCAL_MODEL_COOLDOWN) that preserves
      // the "Ns left" countdown from the original message.
      return new LocalInferenceStreamError('LOCAL_MODEL_COOLDOWN', message, true);
    case 'oom':
      return new LocalInferenceStreamError('OOM', message, true);
    case 'device-lost':
      return new LocalInferenceStreamError('DEVICE_LOST', message, true);
    case 'template-missing':
      return new LocalInferenceStreamError('TEMPLATE_MISSING', TEMPLATE_MISSING_USER_MESSAGE, false);
    case 'gpu-busy-other-tab':
      // Another tab owns the GPU (single-tab ownership prevents the concurrent
      // WebGPU device-init crash). Recoverable: retrying after the other tab
      // releases the GPU succeeds.
      return new LocalInferenceStreamError('GPU_BUSY_OTHER_TAB', message, true);
    case 'model-files-missing':
      // The weights are gone from this device and could not be fetched. Its own
      // useChat branch says so (offline vs. online wording) — never the "needed
      // a moment" crash card, which would tell the person to retry something
      // that cannot work until they reconnect.
      return new LocalInferenceStreamError('MODEL_FILES_MISSING', message, true);
    case 'webgpu-unavailable':
    case 'init-failed':
      return new LocalInferenceStreamError('WORKER_CRASHED', message, true);
    case 'timeout':
      return new LocalInferenceStreamError('TIMEOUT', message, true);
    case 'aborted':
      // Aborts are user-initiated; surface as a generic error so the caller's
      // abort branch (which checks the generation's abort signal) wins.
      return new LocalInferenceStreamError('ABORTED', message, true);
    case 'generation-failed':
    default:
      return new LocalInferenceStreamError('LOCAL_INFERENCE_FAILED', message, true);
  }
}
