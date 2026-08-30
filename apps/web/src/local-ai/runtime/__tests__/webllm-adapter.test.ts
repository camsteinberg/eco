// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
import { AdapterError } from '../types';
import type { ConfidenceSummary } from '../confidence';
import { WebLLMAdapter, type WebLLMChunk, type WebLLMEngine } from '../webllm-adapter';

// Captures the appConfig the adapter hands the REAL hasModelInCache: a
// self-hosted model is NOT in prebuiltAppConfig, so the adapter must pass its
// own appConfig or the check silently reads "not cached".
const hasModelInCacheSpy = vi.hoisted(() => vi.fn());
vi.mock('@mlc-ai/web-llm', () => ({ hasModelInCache: hasModelInCacheSpy }));

const MODEL: ModelConfig = {
  id: 'local/smollm2-1.7b-webllm-q4f16',
  friendlyName: 'SmolLM2',
  vendor: 'HF',
  sizeGB: 0.97,
  runtime: 'webllm',
  format: 'mlc-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
  artifact: {
    hfId: 'mlc-ai/SmolLM2-1.7B-Instruct-q4f16_1-MLC',
    revision: '84f57f8580a9d8d623266b600ad4273bb9fd84c1',
    files: ['params_shard_0.bin', 'ndarray-cache.json'],
  },
};

function makeEngine(opts?: {
  reloadFails?: Error;
  createFails?: Error;
  chunks?: WebLLMChunk[];
  iterDelayMs?: number;
}): WebLLMEngine {
  return {
    reload: async () => {
      if (opts?.reloadFails) throw opts.reloadFails;
    },
    chat: {
      completions: {
        create: async () => {
          if (opts?.createFails) throw opts.createFails;
          const chunks = opts?.chunks ?? [
            { choices: [{ delta: { content: 'hello' } }] },
            { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 4 } },
          ];
          return (async function* () {
            for (const c of chunks) {
              if (opts?.iterDelayMs) await new Promise((r) => setTimeout(r, opts.iterDelayMs));
              yield c;
            }
          })();
        },
      },
    },
    interruptGenerate: () => undefined,
    unload: async () => undefined,
  };
}

/**
 * Models the real WebLLM behavior this adapter's abort handling depends on:
 * `unload()` aborts the engine's internal controller, which makes an
 * in-flight `reload()` reject on its own. `rejectReload`'s message
 * deliberately does NOT match any of `classifyWebLLMError`'s heuristics
 * (no "abort" substring) — proving the adapter classifies this as
 * 'aborted' because it explicitly checked the signal, not because the
 * error text happened to look abort-shaped.
 *
 * `reloadStarted` resolves once `reload()` has actually been called, so a
 * test can wait for it before aborting — otherwise `controller.abort()`
 * called synchronously right after `adapter.load(...)` reliably lands
 * BEFORE `reload()` is ever reached (several awaits separate them: the
 * engine factory call alone yields a microtask), testing the wrong path
 * entirely and masking whatever it was meant to exercise.
 */
function makeCancelableEngine(): {
  engine: WebLLMEngine;
  unloadCalls: () => number;
  reloadStarted: Promise<void>;
} {
  let unloadCallCount = 0;
  let rejectReload: ((err: Error) => void) | null = null;
  let notifyReloadStarted: () => void;
  const reloadStarted = new Promise<void>((resolve) => {
    notifyReloadStarted = resolve;
  });
  const engine: WebLLMEngine = {
    reload: () => new Promise((_resolve, reject) => {
      rejectReload = reject;
      notifyReloadStarted();
    }),
    chat: { completions: { create: async () => (async function* () {})() } },
    interruptGenerate: () => undefined,
    unload: async () => {
      unloadCallCount++;
      rejectReload?.(new Error('reload was interrupted'));
    },
  };
  return { engine, unloadCalls: () => unloadCallCount, reloadStarted };
}

let engine: WebLLMEngine;
let adapter: WebLLMAdapter;

beforeEach(() => {
  engine = makeEngine();
  adapter = new WebLLMAdapter({
    engineFactory: async () => engine,
  });
});

afterEach(async () => {
  await adapter.unload().catch(() => undefined);
});

// ─── Load ──────────────────────────────────────────────────────────────────

describe('WebLLMAdapter — load', () => {
  it('loads via factory and reload', async () => {
    await adapter.load(MODEL);
    expect(adapter.isLoaded).toBe(true);
    expect(adapter.activeModel?.id).toBe(MODEL.id);
    expect(adapter.backend).toBe('webgpu');
  });

  it('passes MLC-format id (stripped of mlc-ai/ prefix) to engine factory', async () => {
    let receivedModelId: string | undefined;
    adapter = new WebLLMAdapter({
      engineFactory: async ({ modelId }) => {
        receivedModelId = modelId;
        return engine;
      },
    });
    await adapter.load(MODEL);
    expect(receivedModelId).toBe('SmolLM2-1.7B-Instruct-q4f16_1-MLC');
  });

  it('passes non-mlc-ai hfId unchanged to engine factory', async () => {
    let receivedModelId: string | undefined;
    adapter = new WebLLMAdapter({
      engineFactory: async ({ modelId }) => {
        receivedModelId = modelId;
        return engine;
      },
    });
    const nonMlcModel: ModelConfig = {
      ...MODEL,
      artifact: { hfId: 'other-org/SomeModel-MLC', revision: 'abc', files: ['a.bin'] },
    };
    await adapter.load(nonMlcModel);
    expect(receivedModelId).toBe('other-org/SomeModel-MLC');
  });

  it('rejects with AdapterError when artifact.hfId is missing', async () => {
    const noArtifactModel: ModelConfig = { ...MODEL, artifact: undefined };
    await expect(adapter.load(noArtifactModel)).rejects.toThrowError(/missing artifact\.hfId/i);
  });

  it('reload failure → AdapterError + cleanup', async () => {
    engine = makeEngine({ reloadFails: new Error('webgpu unavailable') });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await expect(adapter.load(MODEL)).rejects.toBeInstanceOf(AdapterError);
    expect(adapter.isLoaded).toBe(false);
  });

  it('engine factory failure → AdapterError', async () => {
    adapter = new WebLLMAdapter({ engineFactory: async () => { throw new Error('boom'); } });
    await expect(adapter.load(MODEL)).rejects.toBeInstanceOf(AdapterError);
  });

  it('classifies OOM in error message', async () => {
    engine = makeEngine({ reloadFails: new Error('CUDA out of memory') });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    try {
      await adapter.load(MODEL);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as AdapterError).code).toBe('oom');
    }
  });

  it('classifies device-lost', async () => {
    engine = makeEngine({ reloadFails: new Error('GPU device lost during reload') });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    try {
      await adapter.load(MODEL);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as AdapterError).code).toBe('device-lost');
    }
  });

  // Regression coverage for the confirmed latent bug in the original
  // integration: `reload()` genuinely takes no AbortSignal, so a signal
  // passed as a fake `chatOpts` param was a silent no-op. Load-abort here
  // must go through `unload()`, which really does cancel the in-flight
  // reload rather than merely abandoning it.
  describe('load abort', () => {
    it('calls unload() to genuinely cancel an in-flight reload, classified aborted', async () => {
      const { engine: cancelable, unloadCalls, reloadStarted } = makeCancelableEngine();
      adapter = new WebLLMAdapter({ engineFactory: async () => cancelable });

      const controller = new AbortController();
      const pending = adapter.load(MODEL, { signal: controller.signal });
      await reloadStarted;
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: 'aborted' });
      expect(unloadCalls()).toBe(1);
    });

    it('does not call unload() twice when the abort itself triggered the failure', async () => {
      const { engine: cancelable, unloadCalls, reloadStarted } = makeCancelableEngine();
      adapter = new WebLLMAdapter({ engineFactory: async () => cancelable });

      const controller = new AbortController();
      const pending = adapter.load(MODEL, { signal: controller.signal });
      await reloadStarted;
      controller.abort();
      await pending.catch(() => undefined);

      expect(unloadCalls()).toBe(1);
    });

    it('rejects immediately as aborted when the signal is already aborted before load', async () => {
      const { engine: cancelable } = makeCancelableEngine();
      adapter = new WebLLMAdapter({ engineFactory: async () => cancelable });

      const controller = new AbortController();
      controller.abort();

      await expect(adapter.load(MODEL, { signal: controller.signal }))
        .rejects.toMatchObject({ code: 'aborted' });
    });
  });
});

// ─── Generate ──────────────────────────────────────────────────────────────

describe('WebLLMAdapter — generate', () => {
  beforeEach(async () => {
    await adapter.load(MODEL);
  });

  it('yields tokens then done with usage', async () => {
    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events.find((e) => e.kind === 'token' && e.text === 'hello')).toBeDefined();
    expect(events.find((e) => e.kind === 'token' && e.text === ' world')).toBeDefined();
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    if (done?.kind === 'done') {
      expect(done.promptTokens).toBe(2);
      expect(done.completionTokens).toBe(4);
    }
  });

  it('aborts via signal — interruptGenerate called', async () => {
    let interrupted = false;
    engine = {
      reload: async () => undefined,
      chat: {
        completions: {
          create: async () => (async function* () {
            for (let i = 0; i < 100; i++) {
              await new Promise((r) => setTimeout(r, 5));
              yield { choices: [{ delta: { content: `t${i}` } }] };
            }
          })(),
        },
      },
      interruptGenerate: () => { interrupted = true; },
      unload: async () => undefined,
    };
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const controller = new AbortController();
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate(
        [{ role: 'user', content: 'long task' }],
        { signal: controller.signal },
      )) {
        events.push(event);
        if (events.length >= 2) controller.abort();
      }
    })();

    await collector;
    expect(interrupted).toBe(true);
    expect(events[events.length - 1]?.kind).toBe('error');
  });

  it('emits error event when chat.completions.create throws', async () => {
    engine = makeEngine({ createFails: new Error('inference failed') });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);
    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([])) {
      events.push(event);
    }
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('error');
  });
});

// ─── Stream drain (second-generation deadlock regression) ─────────────────
// WebLLM finalizes a request — and releases its internal request lock — only
// when its chunk generator runs to natural completion. Its cleanup is NOT in
// a `finally`, so a consumer that `break`s out of the stream (an early
// `generator.return()`) leaves the engine permanently "busy" and the NEXT
// `create()` call deadlocks forever. Observed live 2026-07-23: every chat
// generation after a passed smoke hung at "Reading over the conversation…"
// on iPhone Safari and desktop Chromium alike. The adapter must therefore
// drain the stream past the finish_reason chunk to the generator's natural
// end, never abandoning it mid-protocol on the normal-completion path.

describe('WebLLMAdapter — stream drain (deadlock regression)', () => {
  it('drains the chunk generator to natural completion on a normal finish', async () => {
    let fullyDrained = false;
    engine = {
      reload: async () => undefined,
      chat: {
        completions: {
          create: async () => (async function* () {
            yield { choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] };
            // Only reached when the consumer pulls PAST the finish_reason
            // chunk — an early break/return() skips this line. This is where
            // the real WebLLM finalizes the request and frees its lock.
            fullyDrained = true;
          })(),
        },
      },
      interruptGenerate: () => undefined,
      unload: async () => undefined,
    };
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    expect(events[events.length - 1]?.kind).toBe('done');
    expect(fullyDrained).toBe(true);
  });

  it('a second generate succeeds after a naturally-finished first one', async () => {
    // Models WebLLM's request serialization: create() refuses while the
    // previous request was never finalized (its generator abandoned).
    let busy = false;
    const makeChunks = (text: string) => (async function* () {
      yield { choices: [{ delta: { content: text }, finish_reason: 'stop' }] };
      busy = false; // the real engine's post-stream finalize
    })();
    engine = {
      reload: async () => undefined,
      chat: {
        completions: {
          create: async () => {
            if (busy) {
              throw new Error('previous request never finalized — engine deadlocked');
            }
            busy = true;
            return makeChunks('reply');
          },
        },
      },
      interruptGenerate: () => undefined,
      unload: async () => undefined,
    };
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const first: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'one' }])) {
      first.push(event);
    }
    expect(first[first.length - 1]?.kind).toBe('done');

    const second: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'two' }])) {
      second.push(event);
    }
    expect(second.find((e) => e.kind === 'token')).toBeDefined();
    expect(second[second.length - 1]?.kind).toBe('done');
  });
});

// ─── Usage via include_usage (trailing empty-choices chunk) ──────────────────
// WebLLM only reports real completion-token counts when `create()` is called
// with `stream_options: { include_usage: true }`. The counts then arrive on a
// FINAL chunk whose `choices` array is EMPTY. The adapter must request that
// option AND tolerate the trailing chunk without emitting a token or breaking
// the #64 drain-to-completion contract.

describe('WebLLMAdapter — usage (include_usage)', () => {
  it('requests the trailing usage chunk via stream_options.include_usage', async () => {
    let receivedArgs:
      | Parameters<WebLLMEngine['chat']['completions']['create']>[0]
      | undefined;
    engine = {
      reload: async () => undefined,
      chat: {
        completions: {
          create: async (args) => {
            receivedArgs = args;
            return (async function* () {
              yield { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
            })();
          },
        },
      },
      interruptGenerate: () => undefined,
      unload: async () => undefined,
    };
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    for await (const _event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      // drain
    }
    expect(receivedArgs?.stream_options?.include_usage).toBe(true);
  });

  it('reads completion tokens from the trailing empty-choices chunk and still drains to completion', async () => {
    let fullyDrained = false;
    engine = {
      reload: async () => undefined,
      chat: {
        completions: {
          create: async () => (async function* () {
            // Content chunks carry no usage; the FINAL chunk has an EMPTY choices
            // array and the real token counts — the include_usage shape.
            yield { choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] };
            yield { choices: [], usage: { prompt_tokens: 9, completion_tokens: 42 } };
            // Only reached when the consumer pulls PAST the usage chunk — proves
            // the trailing chunk doesn't trigger an early break (the #64 contract).
            fullyDrained = true;
          })(),
        },
      },
      interruptGenerate: () => undefined,
      unload: async () => undefined,
    };
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'q' }])) {
      events.push(event);
    }

    // The empty-choices usage chunk must NOT emit a token — exactly one token.
    const tokens = events.filter((e) => e.kind === 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ text: 'Answer' });

    const done = events[events.length - 1];
    expect(done?.kind).toBe('done');
    if (done?.kind === 'done') {
      expect(done.promptTokens).toBe(9);
      expect(done.completionTokens).toBe(42);
    }
    // The trailing chunk was pulled → the generator ran to natural completion.
    expect(fullyDrained).toBe(true);
  });
});

// ─── Unload ────────────────────────────────────────────────────────────────

describe('WebLLMAdapter — unload', () => {
  it('clears state and is safe to call when not loaded', async () => {
    await adapter.unload();
    expect(adapter.isLoaded).toBe(false);

    await adapter.load(MODEL);
    await adapter.unload();
    expect(adapter.isLoaded).toBe(false);
    expect(adapter.activeModel).toBeNull();
  });
});

// ─── weightsCached ──────────────────────────────────────────────────────────

describe('WebLLMAdapter — weightsCached', () => {
  it('delegates to the injected override with the stripped MLC id', async () => {
    let receivedId: string | undefined;
    adapter = new WebLLMAdapter({
      engineFactory: async () => engine,
      hasModelInCache: async (mlcId) => {
        receivedId = mlcId;
        return true;
      },
    });
    const cached = await adapter.weightsCached(MODEL);
    expect(cached).toBe(true);
    expect(receivedId).toBe('SmolLM2-1.7B-Instruct-q4f16_1-MLC');
  });

  it('returns false when the override reports not cached', async () => {
    adapter = new WebLLMAdapter({
      engineFactory: async () => engine,
      hasModelInCache: async () => false,
    });
    expect(await adapter.weightsCached(MODEL)).toBe(false);
  });

  it('passes a self-hosted appConfig (stripped id + same-origin base) to the real hasModelInCache', async () => {
    hasModelInCacheSpy.mockReset();
    hasModelInCacheSpy.mockResolvedValue(true);
    // No override → the adapter takes the real-import path.
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });

    const cached = await adapter.weightsCached(MODEL);

    expect(cached).toBe(true);
    expect(hasModelInCacheSpy).toHaveBeenCalledTimes(1);
    const [mlcId, appConfig] = hasModelInCacheSpy.mock.calls[0]!;
    expect(mlcId).toBe('SmolLM2-1.7B-Instruct-q4f16_1-MLC');
    expect(appConfig.model_list[0].model_id).toBe('SmolLM2-1.7B-Instruct-q4f16_1-MLC');
    expect(appConfig.model_list[0].model).toBe(
      `${window.location.origin}/webllm/models/SmolLM2-1.7B-Instruct-q4f16_1-MLC/resolve/main/`,
    );
    expect(appConfig.model_list[0].model_lib).toMatch(/^\/webllm\/v0_2_84\//);
  });

  it('returns false (never throws) when the real hasModelInCache rejects', async () => {
    hasModelInCacheSpy.mockReset();
    hasModelInCacheSpy.mockRejectedValue(new Error('ModelNotFound'));
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });

    expect(await adapter.weightsCached(MODEL)).toBe(false);
  });
});

// ─── Confidence from streamed logprobs ────────────────────────────────────

describe('WebLLMAdapter — confidence', () => {
  it('passes logprobs: true and top_logprobs: 1 to create()', async () => {
    let receivedArgs:
      | Parameters<WebLLMEngine['chat']['completions']['create']>[0]
      | undefined;
    engine = {
      reload: async () => undefined,
      chat: {
        completions: {
          create: async (args) => {
            receivedArgs = args;
            return (async function* () {
              yield { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
            })();
          },
        },
      },
      interruptGenerate: () => undefined,
      unload: async () => undefined,
    };
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    for await (const _event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      // drain
    }
    expect(receivedArgs?.logprobs).toBe(true);
    expect(receivedArgs?.top_logprobs).toBe(1);
  });

  it('accumulates logprobs into a ConfidenceSummary with null entropy fields', async () => {
    const chunks: WebLLMChunk[] = [
      {
        choices: [{
          delta: { content: 'A' },
          logprobs: { content: [{ logprob: -0.1 }] },
        }],
      },
      {
        choices: [{
          delta: { content: 'B' },
          logprobs: { content: [{ logprob: -0.5 }] },
        }],
      },
      {
        choices: [{
          delta: { content: 'C' },
          finish_reason: 'stop',
          logprobs: { content: [{ logprob: -0.3 }] },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ];

    engine = makeEngine({ chunks });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'x' }])) {
      events.push(event);
    }

    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    if (done?.kind !== 'done') throw new Error('expected done');

    const conf = done.confidence;
    expect(conf).toBeDefined();
    const c = conf as ConfidenceSummary;
    expect(c.steps).toBe(3);
    expect(c.minTop1LogProb).toBeCloseTo(-0.5, 6);
    expect(c.minAt).toBe(1);
    expect(c.meanTop1LogProb).toBeCloseTo((-0.1 + -0.5 + -0.3) / 3, 6);
    // Entropy fields are honestly null — WebLLM only provides the chosen-token logprob.
    expect(c.meanEntropy).toBeNull();
    expect(c.maxEntropy).toBeNull();
    expect(c.maxEntropyAt).toBeNull();
  });

  it('greedy is true when temperature is 0', async () => {
    const chunks: WebLLMChunk[] = [
      {
        choices: [{
          delta: { content: 'X' },
          finish_reason: 'stop',
          logprobs: { content: [{ logprob: -0.01 }] },
        }],
      },
    ];

    engine = makeEngine({ chunks });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate(
      [{ role: 'user', content: 'q' }],
      { temperature: 0 },
    )) {
      events.push(event);
    }

    const done = events.find((e) => e.kind === 'done');
    if (done?.kind !== 'done') throw new Error('expected done');
    expect(done.confidence?.greedy).toBe(true);
  });

  it('greedy is false when temperature is nonzero', async () => {
    const chunks: WebLLMChunk[] = [
      {
        choices: [{
          delta: { content: 'X' },
          finish_reason: 'stop',
          logprobs: { content: [{ logprob: -0.2 }] },
        }],
      },
    ];

    engine = makeEngine({ chunks });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate(
      [{ role: 'user', content: 'q' }],
      { temperature: 0.7 },
    )) {
      events.push(event);
    }

    const done = events.find((e) => e.kind === 'done');
    if (done?.kind !== 'done') throw new Error('expected done');
    expect(done.confidence?.greedy).toBe(false);
  });

  it('omits confidence when no logprobs appear on any chunk', async () => {
    // Chunks without logprobs — e.g. engine does not support it.
    const chunks: WebLLMChunk[] = [
      { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
    ];

    engine = makeEngine({ chunks });
    adapter = new WebLLMAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: import('../types').TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'q' }])) {
      events.push(event);
    }

    const done = events.find((e) => e.kind === 'done');
    if (done?.kind !== 'done') throw new Error('expected done');
    // No logprobs → no confidence field on the done event.
    expect(done.confidence).toBeUndefined();
  });
});
