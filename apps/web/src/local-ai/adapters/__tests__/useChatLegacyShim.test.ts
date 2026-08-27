// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Shim contract tests — pin the surface that useChat.ts depends on.
 *
 * The shim translates the new `local-ai/runtime` async-iterable + adapter-
 * error world into the legacy `useLocalInference`-shaped contract:
 *
 *     generate(messages, modelId, opts): ReadableStream<string>
 *
 * Failure modes that useChat already handles via `applyLocalGenerationError`
 * surface as `LocalInferenceStreamError` so the existing branch logic
 * matches without changes.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createLocalAiLegacyInference } from '../useChatLegacyShim';
import * as lifecycle from '../../runtime/lifecycle';
import { AdapterError, type LoadOptions, type TokenEvent } from '../../runtime/types';
import * as bootstrap from '../../bootstrap';
import { _resetUsageStoreForTesting, getLastUsage, getLastTemplateName } from '../../runtime/usage-store';
import type { ModelConfig } from '../../types';
// LocalInferenceStreamError is the error type the shim translates AdapterError
// into — asserted via name matching in the tests, no direct import needed.

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_MODEL: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 2.1,
  runtime: 'transformers',
  context: 4096,
  intent: ['snappy', 'balanced'],
  evidenceTier: 'proven',
  // Other required fields filled by spread for parity with catalog-data.json.
} as unknown as ModelConfig;

const FAKE_EVAL_MODEL: ModelConfig = {
  id: 'candidate/gemma-4-e2b-litert',
  friendlyName: 'Gemma 4 E2B (LiteRT)',
  vendor: 'Google',
  sizeGB: 1.87,
  runtime: 'litert',
  context: 2048,
  intent: ['balanced', 'quality'],
  evidenceTier: 'predicted',
} as unknown as ModelConfig;

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock('../../bootstrap', () => ({
  bootstrapLocalAi: vi.fn(async () => undefined),
}));

vi.mock('../../catalog/catalog', () => ({
  getModel: (id: string): ModelConfig | null => (id === FAKE_MODEL.id ? FAKE_MODEL : null),
}));

vi.mock('../../eval/eval-candidates', () => ({
  getEvalCandidateModel: (id: string): ModelConfig | null =>
    id === FAKE_EVAL_MODEL.id ? FAKE_EVAL_MODEL : null,
}));

vi.mock('../../runtime/lifecycle', () => ({
  loadModel: vi.fn(),
  generate: vi.fn(),
}));

vi.mock('../../../lib/validation-harness', () => ({
  getValidationLocalGenerationFixture: vi.fn(() => null),
  isValidationHarnessEnabled: vi.fn(() => false),
}));

const { getValidationLocalGenerationFixture, isValidationHarnessEnabled } = await import('../../../lib/validation-harness');

const mockLoad = lifecycle.loadModel as unknown as Mock;
const mockGenerate = lifecycle.generate as unknown as Mock;
const mockBootstrap = bootstrap.bootstrapLocalAi as unknown as Mock;
const mockGetValidationLocalGenerationFixture = vi.mocked(getValidationLocalGenerationFixture);
const mockIsValidationHarnessEnabled = vi.mocked(isValidationHarnessEnabled);

// ─── Helpers ───────────────────────────────────────────────────────────────

function asyncIterable(events: TokenEvent[]): AsyncIterable<TokenEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

async function readAll(stream: ReadableStream<string>): Promise<string[]> {
  const reader = stream.getReader();
  const out: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

beforeEach(() => {
  mockLoad.mockReset();
  mockGenerate.mockReset();
  mockBootstrap.mockReset();
  mockBootstrap.mockResolvedValue(undefined);
  mockLoad.mockResolvedValue({} as unknown);
  mockGetValidationLocalGenerationFixture.mockReturnValue(null);
  mockIsValidationHarnessEnabled.mockReturnValue(false);
  _resetUsageStoreForTesting();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('createLocalAiLegacyInference', () => {
  it('forwards token events from lifecycle.generate as enqueued strings', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'Hello' },
        { kind: 'token', text: ', ' },
        { kind: 'token', text: 'world.' },
        { kind: 'done', promptTokens: 7, completionTokens: 3 },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    const stream = shim.generate(
      [{ role: 'user', content: 'hi' }],
      FAKE_MODEL.id,
      { max_new_tokens: 64, temperature: 0.7 },
    );

    const tokens = await readAll(stream);
    expect(tokens.join('')).toBe('Hello, world.');
  });

  it('serves validation local generation fixtures without loading model artifacts', async () => {
    mockIsValidationHarnessEnabled.mockReturnValue(true);
    mockGetValidationLocalGenerationFixture.mockReturnValueOnce({
      mode: 'smoke-ready',
      modelId: FAKE_MODEL.id,
      slot: 'eco-fast',
      chunks: ['local/fixture response: ', 'Fixture complete.'],
    });

    const shim = createLocalAiLegacyInference();
    const tokens = await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id),
    );

    expect(tokens.join('')).toBe('local/fixture response: Fixture complete.');
    expect(mockBootstrap).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(getLastUsage()).toEqual({
      maxTokens: 'local/fixture response: Fixture complete.'.length,
      promptTokens: 0,
      completionTokens: 2,
    });
  });

  it('records usage to the usage-store when done fires', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'ok' },
        { kind: 'done', promptTokens: 4, completionTokens: 1 },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        max_new_tokens: 16,
      }),
    );

    const usage = getLastUsage();
    expect(usage).toEqual({ promptTokens: 4, completionTokens: 1, maxTokens: 16 });
  });

  it('records kvReuse telemetry to the usage-store when done carries it', async () => {
    const kvReuse = {
      decision: 'reuse' as const,
      cachedLen: 100,
      promptLen: 110,
      cacheCommitted: true,
    };
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'ok' },
        { kind: 'done', promptTokens: 4, completionTokens: 1, kvReuse },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        max_new_tokens: 16,
      }),
    );

    expect(getLastUsage()).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      maxTokens: 16,
      kvReuse,
    });
  });

  it('records maxInterTokenGapMs (the #28 stall signature) to the usage-store when done carries it', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'ok' },
        { kind: 'done', promptTokens: 4, completionTokens: 1, maxInterTokenGapMs: 412 },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { max_new_tokens: 16 }),
    );

    expect(getLastUsage()).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      maxTokens: 16,
      maxInterTokenGapMs: 412,
    });
  });

  it('threads a null maxInterTokenGapMs through (fewer than two tokens streamed)', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([{ kind: 'done', promptTokens: 4, completionTokens: 0, maxInterTokenGapMs: null }]),
    );

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { max_new_tokens: 16 }),
    );

    expect(getLastUsage()?.maxInterTokenGapMs).toBeNull();
  });

  it('errors the stream with LocalInferenceStreamError when generate emits an error event', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'error', reason: 'GPU device lost', code: 'device-lost' },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'DEVICE_LOST',
    });
  });

  it('translates AdapterError thrown synchronously by lifecycle.generate', async () => {
    mockGenerate.mockImplementation(() => {
      throw new AdapterError('Out of memory', 'oom', true);
    });

    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'OOM',
    });
  });

  it('surfaces an OOM thrown by loadModel as LOAD_OOM, distinct from a mid-reply OOM', async () => {
    mockLoad.mockRejectedValueOnce(new AdapterError('Out of memory', 'oom', true));

    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'LOAD_OOM',
    });
  });

  it('surfaces model-files-missing from loadModel as MODEL_FILES_MISSING (its own honest card, never WORKER_CRASHED)', async () => {
    mockLoad.mockRejectedValueOnce(new AdapterError('Failed to fetch', 'model-files-missing', true));

    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'MODEL_FILES_MISSING',
    });
  });

  it('surfaces cooldown-active from loadModel as LOCAL_MODEL_COOLDOWN', async () => {
    mockLoad.mockRejectedValueOnce(
      new AdapterError(
        'Qwen3 cooling down after a recent crash (240s left).',
        'cooldown-active',
        true,
      ),
    );

    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'LOCAL_MODEL_COOLDOWN',
      message: expect.stringMatching(/240s left/) as unknown,
    });
  });

  it('errors the stream when the model id is not in the v1 catalog', async () => {
    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      'local/not-in-catalog',
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
    });
  });

  it('allows eval candidates only while the validation harness is enabled', async () => {
    mockIsValidationHarnessEnabled.mockReturnValue(true);
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_EVAL_MODEL.id),
    );

    expect(mockLoad).toHaveBeenCalledWith(
      FAKE_EVAL_MODEL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects eval candidates when the validation harness is disabled', async () => {
    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_EVAL_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'NOT_IN_CATALOG',
    });
  });

  it('aborts the underlying generation when the stream is cancelled', async () => {
    let signalCaptured: AbortSignal | undefined;

    mockGenerate.mockImplementation(
      (_messages: unknown, options: { signal?: AbortSignal }) => {
        signalCaptured = options.signal;
        return {
          // eslint-disable-next-line require-yield
          async *[Symbol.asyncIterator]() {
            // Block until the consumer cancels. Generator intentionally yields
            // no tokens — exit-on-abort is the whole behavior under test.
            await new Promise<void>((resolve) => {
              options.signal?.addEventListener('abort', () => resolve());
            });
          },
        };
      },
    );

    const shim = createLocalAiLegacyInference();
    const stream = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    );
    const reader = stream.getReader();

    // Kick the start() callback by initiating a read, then wait for
    // lifecycle.generate to actually be called before cancelling — the
    // async chain (bootstrap → loadModel → generate) needs a few microtasks.
    void reader.read();
    for (let i = 0; i < 20 && !signalCaptured; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await reader.cancel();

    expect(signalCaptured?.aborted).toBe(true);
  });

  it('passes maxTokens and temperature through to lifecycle.generate', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([{ kind: 'done' }]),
    );

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        max_new_tokens: 128,
        temperature: 0.4,
      }),
    );

    expect(mockGenerate).toHaveBeenCalledWith(
      [{ role: 'user', content: 'x' }],
      expect.objectContaining({ maxTokens: 128, temperature: 0.4 }),
    );
  });

  it('forwards the full snake_case sampling profile as camelCase GenerateOptions', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        max_new_tokens: 256,
        temperature: 0.8,
        top_p: 0.95,
        top_k: 40,
        repetition_penalty: 1.1,
        no_repeat_ngram_size: 3,
      }),
    );

    expect(mockGenerate).toHaveBeenCalledWith(
      [{ role: 'user', content: 'x' }],
      expect.objectContaining({
        maxTokens: 256,
        temperature: 0.8,
        topP: 0.95,
        topK: 40,
        repetitionPenalty: 1.1,
        noRepeatNgramSize: 3,
      }),
    );
  });

  it('omits sampling fields the caller did not supply (null-omission)', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        max_new_tokens: 64,
        top_p: 0.9,
        // top_k / repetition_penalty / no_repeat_ngram_size intentionally absent
      }),
    );

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    const passedOptions = mockGenerate.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(passedOptions.topP).toBe(0.9);
    expect(passedOptions.maxTokens).toBe(64);
    expect('topK' in passedOptions).toBe(false);
    expect('repetitionPenalty' in passedOptions).toBe(false);
    expect('noRepeatNgramSize' in passedOptions).toBe(false);
    // temperature was not supplied either — it must not be synthesized.
    expect('temperature' in passedOptions).toBe(false);
  });

  it('delegates load decisions to the lifecycle on every generate (so external unloads do not desync)', async () => {
    // The shim is intentionally state-free; lifecycle.loadModel is the
    // SSoT and is itself idempotent for the same active model. This test
    // pins the post-fix contract: if external code (e.g., Settings →
    // Switch AI calling unloadActive) clears the lifecycle's adapter
    // between generate() calls, the next generate must re-load — a stale
    // local cache would skip loadModel and leave generate() with no
    // active adapter.
    mockGenerate.mockReturnValue(asyncIterable([{ kind: 'done' }]));
    const shim = createLocalAiLegacyInference();

    await readAll(shim.generate([{ role: 'user', content: 'a' }], FAKE_MODEL.id));
    await readAll(shim.generate([{ role: 'user', content: 'b' }], FAKE_MODEL.id));

    // loadModel called on every generate. Lifecycle handles the no-op
    // when the model is already active — the shim does not second-guess.
    expect(mockLoad).toHaveBeenCalledTimes(2);
    expect(mockLoad).toHaveBeenNthCalledWith(
      1,
      FAKE_MODEL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockLoad).toHaveBeenNthCalledWith(
      2,
      FAKE_MODEL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('calls bootstrapLocalAi before the first generate', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id),
    );

    expect(mockBootstrap).toHaveBeenCalled();
  });

  it('translates template-missing error event to TEMPLATE_MISSING with recoverable=false', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'error', reason: 'apply_chat_template not found', code: 'template-missing' },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    const reader = shim.generate(
      [{ role: 'user', content: 'x' }],
      FAKE_MODEL.id,
    ).getReader();

    await expect(reader.read()).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'TEMPLATE_MISSING',
      recoverable: false,
    });
  });

  it('captures tokenizerName from done event and resets it on next generation start', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'hi' },
        { kind: 'done', promptTokens: 3, completionTokens: 1, tokenizerName: 'LlamaTokenizer' },
      ]),
    );

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id),
    );

    // After a complete generation the template name is available.
    expect(getLastTemplateName()).toBe('LlamaTokenizer');

    // Starting a new generation resets the template name before the stream
    // produces any events (prevents cross-generation leakage).
    mockGenerate.mockReturnValueOnce(
      asyncIterable([{ kind: 'done' }]),
    );
    // Read the stream to trigger the start() callback which resets state.
    await readAll(
      shim.generate([{ role: 'user', content: 'y' }], FAKE_MODEL.id),
    );
    // done event with no tokenizerName → null.
    expect(getLastTemplateName()).toBeNull();
  });

  // ── Cold-load affordance plumbing ──────────────────────────────────────────
  // The shim forwards the runtime's load lifecycle so chat can show honest,
  // time-aware "warming up" copy and an "almost ready" hint on `load-finish`.

  it('forwards onLoadProgress + onLifecycleEvent (plus a signal) to loadModel and fires them', async () => {
    const onLoadProgress = vi.fn();
    const onLifecycleEvent = vi.fn();
    mockLoad.mockImplementationOnce(async (_model: unknown, options?: LoadOptions) => {
      // Simulate the adapter driving both callbacks during a cold load.
      options?.onLoadProgress?.(0.42);
      options?.onLifecycleEvent?.({ phase: 'load-finish', at: 123 });
      return {} as unknown;
    });
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const shim = createLocalAiLegacyInference();
    await readAll(
      shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        onLoadProgress,
        onLifecycleEvent,
      }),
    );

    expect(mockLoad).toHaveBeenCalledWith(
      FAKE_MODEL,
      expect.objectContaining({
        onLoadProgress,
        onLifecycleEvent,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(onLoadProgress).toHaveBeenCalledWith(0.42);
    expect(onLifecycleEvent).toHaveBeenCalledWith({ phase: 'load-finish', at: 123 });
  });

  it('omits the load callbacks when the caller did not supply them (signal still present)', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const shim = createLocalAiLegacyInference();
    await readAll(shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id));

    const passedLoadOptions = mockLoad.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('onLoadProgress' in passedLoadOptions).toBe(false);
    expect('onLifecycleEvent' in passedLoadOptions).toBe(false);
    expect(passedLoadOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('closes the stream cleanly when cancelled during model load (no user-facing error)', async () => {
    let loadSignal: AbortSignal | undefined;
    mockLoad.mockImplementationOnce((_model: unknown, options?: LoadOptions) => {
      loadSignal = options?.signal;
      // Block until the consumer cancels, then reject the way the transformers
      // adapter does for an externally-aborted load: AdapterError('aborted').
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new AdapterError('Load aborted', 'aborted', true));
        });
      });
    });

    const shim = createLocalAiLegacyInference();
    const stream = shim.generate([{ role: 'user', content: 'x' }], FAKE_MODEL.id);
    const reader = stream.getReader();

    // Kick start() and wait for loadModel to actually be reached (bootstrap →
    // loadModel needs a few microtasks) before cancelling mid-load.
    const readPromise = reader.read();
    for (let i = 0; i < 20 && !loadSignal; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(loadSignal).toBeDefined();

    // Cancelling resolves the pending read as done — the late aborted-load
    // rejection hits an already-closed controller and never surfaces.
    await expect(reader.cancel()).resolves.toBeUndefined();
    await expect(readPromise).resolves.toEqual({ done: true, value: undefined });
    expect(loadSignal?.aborted).toBe(true);
    // Load never completed, so generation was never started.
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
