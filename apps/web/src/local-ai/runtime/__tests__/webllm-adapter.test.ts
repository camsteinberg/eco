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
