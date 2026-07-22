// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import { AdapterError } from '../types';
import { WebLLMAdapter, type WebLLMEngine } from '../webllm-adapter';

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

type Chunk = {
  choices: Array<{ delta: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function makeEngine(opts?: {
  reloadFails?: Error;
  createFails?: Error;
  chunks?: Chunk[];
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
});
