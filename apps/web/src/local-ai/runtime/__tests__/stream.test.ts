// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * `stream()` contract tests — the ONE path from prompt to tokens.
 *
 * Ported from `adapters/__tests__/useChatLegacyShim.test.ts` when R4b deleted
 * the `ReadableStream<string>` shim. Every behaviour that file guarded lives
 * here, re-expressed against the async-iterable seam:
 *
 *     stream(messages, modelId, options): AsyncIterable<TokenEvent> & { cancel() }
 *
 * The three assertions that read the old usage side channel now read the
 * terminating `done` event directly, which is the point of the slice.
 *
 * Failure modes that `useChat` handles via `applyLocalGenerationError` surface
 * as `LocalInferenceStreamError`, so the existing branch logic keeps matching.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { stream } from '../stream';
import * as lifecycle from '../lifecycle';
import { AdapterError, type LoadOptions, type TokenEvent } from '../types';
import * as bootstrap from '../../bootstrap';
import type { ModelConfig } from '../../types';
// LocalInferenceStreamError is the error type `stream()` translates AdapterError
// into — asserted via name matching in the tests, no direct import needed.

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FAKE_MODEL: ModelConfig = {
  id: 'local/qwen3-0.6b',
  friendlyName: 'Qwen3',
  vendor: 'Alibaba',
  sizeGB: 2.1,
  runtime: 'transformers',
  context: 4096,
  // R5a windows inside `stream()`, so the context window is now load-bearing here.
  capabilities: { contextTokens: 4096 },
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
  capabilities: { contextTokens: 2048 },
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

vi.mock('../lifecycle', () => ({
  loadModel: vi.fn(),
  generate: vi.fn(),
}));

vi.mock('../../../lib/validation-harness', () => ({
  getValidationLocalGenerationFixture: vi.fn(() => null),
  isValidationHarnessEnabled: vi.fn(() => false),
}));

const { getValidationLocalGenerationFixture, isValidationHarnessEnabled } = await import(
  '../../../lib/validation-harness'
);

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

/** Drain a stream to completion, returning every event it yielded. */
async function readAll(source: AsyncIterable<TokenEvent>): Promise<TokenEvent[]> {
  const events: TokenEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function textOf(events: TokenEvent[]): string {
  return events
    .filter((e): e is Extract<TokenEvent, { kind: 'token' }> => e.kind === 'token')
    .map((e) => e.text)
    .join('');
}

function doneOf(events: TokenEvent[]): Extract<TokenEvent, { kind: 'done' }> | undefined {
  return events.find((e): e is Extract<TokenEvent, { kind: 'done' }> => e.kind === 'done');
}

/** Start iterating and take the first event (or its rejection). */
function firstEvent(source: AsyncIterable<TokenEvent>): Promise<IteratorResult<TokenEvent>> {
  return source[Symbol.asyncIterator]().next();
}

beforeEach(() => {
  mockLoad.mockReset();
  mockGenerate.mockReset();
  mockBootstrap.mockReset();
  mockBootstrap.mockResolvedValue(undefined);
  // `stream()` reads `countTokens` off the adapter the lifecycle returns.
  mockLoad.mockResolvedValue({
    countTokens: async (text: string) => text.trim().split(/\s+/).length,
  } as unknown);
  mockGetValidationLocalGenerationFixture.mockReturnValue(null);
  mockIsValidationHarnessEnabled.mockReturnValue(false);
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('stream()', () => {
  it('forwards token events from lifecycle.generate', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'Hello' },
        { kind: 'token', text: ', ' },
        { kind: 'token', text: 'world.' },
        { kind: 'done', promptTokens: 7, completionTokens: 3 },
      ]),
    );

    const events = await readAll(
      stream([{ role: 'user', content: 'hi' }], FAKE_MODEL.id, {
        maxTokens: 64,
        temperature: 0.7,
      }),
    );

    expect(textOf(events)).toBe('Hello, world.');
  });

  it('serves validation local generation fixtures without loading model artifacts', async () => {
    mockIsValidationHarnessEnabled.mockReturnValue(true);
    mockGetValidationLocalGenerationFixture.mockReturnValueOnce({
      mode: 'smoke-ready',
      modelId: FAKE_MODEL.id,
      slot: 'eco-fast',
      chunks: ['local/fixture response: ', 'Fixture complete.'],
    });

    const events = await readAll(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id));

    expect(textOf(events)).toBe('local/fixture response: Fixture complete.');
    expect(mockBootstrap).not.toHaveBeenCalled();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(doneOf(events)).toEqual({
      kind: 'done',
      promptTokens: 0,
      completionTokens: 2,
      windowStartIndex: 0,
    });
  });

  it('carries usage on the terminating done event', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'ok' },
        { kind: 'done', promptTokens: 4, completionTokens: 1 },
      ]),
    );

    const events = await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { maxTokens: 16 }),
    );

    // `windowStartIndex` is added by `stream()` itself (R5a) — the adapter's
    // done event knows nothing about the window.
    expect(doneOf(events)).toEqual({
      kind: 'done',
      promptTokens: 4,
      completionTokens: 1,
      windowStartIndex: 0,
    });
  });

  it('carries kvReuse telemetry through on the done event', async () => {
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

    const events = await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { maxTokens: 16 }),
    );

    expect(doneOf(events)?.kvReuse).toEqual(kvReuse);
  });

  it('carries maxInterTokenGapMs (the #28 stall signature) through on the done event', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'ok' },
        { kind: 'done', promptTokens: 4, completionTokens: 1, maxInterTokenGapMs: 412 },
      ]),
    );

    const events = await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { maxTokens: 16 }),
    );

    expect(doneOf(events)?.maxInterTokenGapMs).toBe(412);
  });

  it('threads a null maxInterTokenGapMs through (fewer than two tokens streamed)', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'done', promptTokens: 4, completionTokens: 0, maxInterTokenGapMs: null },
      ]),
    );

    const events = await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { maxTokens: 16 }),
    );

    expect(doneOf(events)?.maxInterTokenGapMs).toBeNull();
  });

  it('throws LocalInferenceStreamError when generate emits an error event', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([{ kind: 'error', reason: 'GPU device lost', code: 'device-lost' }]),
    );

    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id)),
    ).rejects.toMatchObject({ name: 'LocalInferenceStreamError', code: 'DEVICE_LOST' });
  });

  it('translates AdapterError thrown synchronously by lifecycle.generate', async () => {
    mockGenerate.mockImplementation(() => {
      throw new AdapterError('Out of memory', 'oom', true);
    });

    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id)),
    ).rejects.toMatchObject({ name: 'LocalInferenceStreamError', code: 'OOM' });
  });

  it('surfaces an OOM thrown by loadModel as LOAD_OOM, distinct from a mid-reply OOM', async () => {
    mockLoad.mockRejectedValueOnce(new AdapterError('Out of memory', 'oom', true));

    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id)),
    ).rejects.toMatchObject({ name: 'LocalInferenceStreamError', code: 'LOAD_OOM' });
  });

  it('surfaces model-files-missing from loadModel as MODEL_FILES_MISSING (its own honest card, never WORKER_CRASHED)', async () => {
    mockLoad.mockRejectedValueOnce(new AdapterError('Failed to fetch', 'model-files-missing', true));

    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id)),
    ).rejects.toMatchObject({ name: 'LocalInferenceStreamError', code: 'MODEL_FILES_MISSING' });
  });

  it('surfaces cooldown-active from loadModel as LOCAL_MODEL_COOLDOWN', async () => {
    mockLoad.mockRejectedValueOnce(
      new AdapterError('Qwen3 cooling down after a recent crash (240s left).', 'cooldown-active', true),
    );

    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id)),
    ).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'LOCAL_MODEL_COOLDOWN',
      message: expect.stringMatching(/240s left/) as unknown,
    });
  });

  it('throws when the model id is not in the v1 catalog', async () => {
    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], 'local/not-in-catalog')),
    ).rejects.toMatchObject({ name: 'LocalInferenceStreamError', code: 'NOT_IN_CATALOG' });
  });

  it('allows eval candidates only while the validation harness is enabled', async () => {
    mockIsValidationHarnessEnabled.mockReturnValue(true);
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(stream([{ role: 'user', content: 'x' }], FAKE_EVAL_MODEL.id));

    expect(mockLoad).toHaveBeenCalledWith(
      FAKE_EVAL_MODEL,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects eval candidates when the validation harness is disabled', async () => {
    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_EVAL_MODEL.id)),
    ).rejects.toMatchObject({ name: 'LocalInferenceStreamError', code: 'NOT_IN_CATALOG' });
  });

  it('aborts the underlying generation when the stream is cancelled', async () => {
    let signalCaptured: AbortSignal | undefined;

    mockGenerate.mockImplementation((_messages: unknown, options: { signal?: AbortSignal }) => {
      signalCaptured = options.signal;
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          // Block until the consumer cancels. Generator intentionally yields no
          // tokens — exit-on-abort is the whole behavior under test.
          await new Promise<void>((resolve) => {
            options.signal?.addEventListener('abort', () => { resolve(); });
          });
        },
      };
    });

    const tokens = stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id);
    const iterator = tokens[Symbol.asyncIterator]();

    // Kick the generator by starting a read, then wait for lifecycle.generate to
    // actually be called before cancelling — the async chain (bootstrap →
    // loadModel → generate) needs a few microtasks.
    const pending = iterator.next();
    for (let i = 0; i < 20 && !signalCaptured; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    tokens.cancel();

    expect(signalCaptured?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('resolves done immediately on cancel even when the runtime never responds', async () => {
    // The property `ReadableStream.cancel()` gave us before R4b: a runtime that
    // ignores its abort signal must not hold the stop button, the generation
    // lease, or the time-to-first-token watchdog's unwind.
    let reached = false;
    mockGenerate.mockImplementation(() => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() {
        reached = true;
        // Never settles, and never checks the signal.
        await new Promise<void>(() => undefined);
      },
    }));

    const tokens = stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id);
    const iterator = tokens[Symbol.asyncIterator]();
    const pending = iterator.next();
    for (let i = 0; i < 20 && !reached; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(reached).toBe(true);

    tokens.cancel();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    // And it stays done — a second read does not hang either.
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('windows the history with the adapter tokenizer and reports where it starts', async () => {
    let sent: Array<{ role: string; content: string }> = [];
    mockGenerate.mockImplementation((messages: Array<{ role: string; content: string }>) => {
      sent = messages;
      return asyncIterable([{ kind: 'done', promptTokens: 1, completionTokens: 1 }]);
    });

    const long: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: 'system prompt' },
    ];
    for (let i = 0; i < 60; i++) {
      long.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `turn ${i} ${'word '.repeat(120).trim()}`,
      });
    }

    const events = await readAll(stream(long, FAKE_MODEL.id, { maxTokens: 512 }));

    expect(sent.length).toBeLessThan(long.length);
    expect(sent[0]).toEqual(long[0]); // system pinned
    expect(sent[sent.length - 1]).toEqual(long[long.length - 1]); // ends at newest
    const start = doneOf(events)!.windowStartIndex!;
    expect(start).toBeGreaterThan(1);
    expect(long[start]).toEqual(sent[1]);
  });

  it('refuses when even the final user turn does not fit the window', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const huge = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'word '.repeat(9000).trim() },
    ];

    await expect(firstEvent(stream(huge, FAKE_MODEL.id, { maxTokens: 512 }))).rejects.toMatchObject(
      { code: 'CONTEXT_WINDOW_EXCEEDED' },
    );
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('does not refuse when the adapter cannot count (the bound over-counts)', async () => {
    mockLoad.mockResolvedValue({ countTokens: async () => null } as unknown);
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    const messages = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'a fairly ordinary question of some length' },
    ];

    await expect(readAll(stream(messages, FAKE_MODEL.id, { maxTokens: 512 }))).resolves.toHaveLength(
      1,
    );
    expect(mockGenerate).toHaveBeenCalled();
  });

  it('passes maxTokens and temperature through to lifecycle.generate', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        maxTokens: 128,
        temperature: 0.4,
      }),
    );

    expect(mockGenerate).toHaveBeenCalledWith(
      [{ role: 'user', content: 'x' }],
      expect.objectContaining({ maxTokens: 128, temperature: 0.4 }),
    );
  });

  it('forwards the full sampling profile to lifecycle.generate', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        maxTokens: 256,
        temperature: 0.8,
        topP: 0.95,
        topK: 40,
        repetitionPenalty: 1.1,
        noRepeatNgramSize: 3,
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

  it('forwards continueFinalMessage so a resumed reply is finished, not restarted', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(
      stream(
        [
          { role: 'user', content: 'x' },
          { role: 'assistant', content: 'partial ' },
        ],
        FAKE_MODEL.id,
        { maxTokens: 64, continueFinalMessage: true },
      ),
    );

    const passedOptions = mockGenerate.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(passedOptions.continueFinalMessage).toBe(true);
  });

  it('omits sampling fields the caller did not supply (null-omission)', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
        maxTokens: 64,
        topP: 0.9,
        // topK / repetitionPenalty / noRepeatNgramSize intentionally absent
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

  it('delegates load decisions to the lifecycle on every stream (so external unloads do not desync)', async () => {
    // `stream()` is intentionally state-free; lifecycle.loadModel is the SSoT
    // and is itself idempotent for the same active model. This pins the
    // post-fix contract: if external code (e.g. Settings → Switch AI calling
    // unloadActive) clears the lifecycle's adapter between calls, the next
    // stream must re-load — a stale local cache would skip loadModel and leave
    // generate() with no active adapter.
    mockGenerate.mockReturnValue(asyncIterable([{ kind: 'done' }]));

    await readAll(stream([{ role: 'user', content: 'a' }], FAKE_MODEL.id));
    await readAll(stream([{ role: 'user', content: 'b' }], FAKE_MODEL.id));

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

  it('calls bootstrapLocalAi before generating', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id));

    expect(mockBootstrap).toHaveBeenCalled();
  });

  it('translates a template-missing error event to TEMPLATE_MISSING with recoverable=false', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'error', reason: 'apply_chat_template not found', code: 'template-missing' },
      ]),
    );

    await expect(
      firstEvent(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id)),
    ).rejects.toMatchObject({
      name: 'LocalInferenceStreamError',
      code: 'TEMPLATE_MISSING',
      recoverable: false,
    });
  });

  it('carries tokenizerName on the done event, and never leaks it across generations', async () => {
    mockGenerate.mockReturnValueOnce(
      asyncIterable([
        { kind: 'token', text: 'hi' },
        { kind: 'done', promptTokens: 3, completionTokens: 1, tokenizerName: 'LlamaTokenizer' },
      ]),
    );

    const first = await readAll(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id));
    expect(doneOf(first)?.tokenizerName).toBe('LlamaTokenizer');

    // A second generation reports only what ITS OWN done event carries — there
    // is no module state left for a previous run's value to survive in.
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));
    const second = await readAll(stream([{ role: 'user', content: 'y' }], FAKE_MODEL.id));
    expect(doneOf(second)?.tokenizerName).toBeUndefined();
  });

  // ── Cold-load affordance plumbing ────────────────────────────────────────
  // `stream()` forwards the runtime's load lifecycle so chat can show honest,
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

    await readAll(
      stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, {
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

  it('forwards onLifecycleEvent to the generation too (breadcrumb capture)', async () => {
    const onLifecycleEvent = vi.fn();
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id, { onLifecycleEvent }));

    expect(mockGenerate).toHaveBeenCalledWith(
      [{ role: 'user', content: 'x' }],
      expect.objectContaining({ onLifecycleEvent }),
    );
  });

  it('omits the load callbacks when the caller did not supply them (signal still present)', async () => {
    mockGenerate.mockReturnValueOnce(asyncIterable([{ kind: 'done' }]));

    await readAll(stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id));

    const passedLoadOptions = mockLoad.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('onLoadProgress' in passedLoadOptions).toBe(false);
    expect('onLifecycleEvent' in passedLoadOptions).toBe(false);
    expect(passedLoadOptions.signal).toBeInstanceOf(AbortSignal);
  });

  it('ends cleanly when cancelled during model load (no user-facing error)', async () => {
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

    const tokens = stream([{ role: 'user', content: 'x' }], FAKE_MODEL.id);
    const iterator = tokens[Symbol.asyncIterator]();

    // Kick the generator and wait for loadModel to actually be reached
    // (bootstrap → loadModel needs a few microtasks) before cancelling mid-load.
    const pending = iterator.next();
    for (let i = 0; i < 20 && !loadSignal; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(loadSignal).toBeDefined();

    // Cancelling resolves the pending read as done — the late aborted-load
    // rejection is the cancellation we asked for and never surfaces.
    tokens.cancel();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(loadSignal?.aborted).toBe(true);
    // Load never completed, so generation was never started.
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
