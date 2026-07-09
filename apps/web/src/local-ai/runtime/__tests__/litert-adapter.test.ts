// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelConfig } from '../../types';
import type { CachedEntry, Storage, StorageKey } from '../../download/storage';
import { AdapterError, type TokenEvent } from '../types';
import {
  LiteRTAdapter,
  type LiteRTConversation,
  type LiteRTConversationConfig,
  type LiteRTEngine,
  type LiteRTMessage,
} from '../litert-adapter';

const CACHED_LITERTLM_KEY =
  '/api/local-models/litert-community/gemma-4-E2B-it-litert-lm/resolve/rev123/gemma-4-E2B-it-web.litertlm';

const MODEL: ModelConfig = {
  id: 'candidate/gemma-4-e2b-litert',
  friendlyName: 'Gemma 4 E2B (LiteRT)',
  vendor: 'Google',
  sizeGB: 1.87,
  runtime: 'litert',
  format: 'litertlm',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 2048 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'predicted',
  artifact: {
    hfId: 'litert-community/gemma-4-E2B-it-litert-lm',
    revision: 'rev123',
    files: ['gemma-4-E2B-it-web.litertlm'],
  },
};

/** Build a ReadableStream<LiteRTMessage> from a list of chunks. */
function streamOf(chunks: LiteRTMessage[], delayMs?: number): ReadableStream<LiteRTMessage> {
  return new ReadableStream<LiteRTMessage>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeEngine(opts?: {
  chunks?: LiteRTMessage[];
  createConversationFails?: Error;
  onCreateConversation?: (config?: LiteRTConversationConfig) => void;
  onCancel?: () => void;
  streamFactory?: () => ReadableStream<LiteRTMessage>;
}): LiteRTEngine {
  return {
    createConversation: async (config) => {
      opts?.onCreateConversation?.(config);
      if (opts?.createConversationFails) throw opts.createConversationFails;
      const conversation: LiteRTConversation = {
        sendMessageStreaming: () =>
          opts?.streamFactory?.() ??
          streamOf(opts?.chunks ?? [
            { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
            { role: 'assistant', content: [{ type: 'text', text: ' world' }] },
          ]),
        cancel: () => opts?.onCancel?.(),
        delete: async () => undefined,
      };
      return conversation;
    },
    delete: async () => undefined,
  };
}

/**
 * Minimal fake Storage. `get()` returns a Response wrapping `cachedBytes` (the
 * copy the setup/download pipeline would have streamed in), or null to simulate
 * a cache miss. `onGet` observes the key the adapter reads with.
 */
function makeStorage(opts?: {
  cachedBytes?: Uint8Array<ArrayBuffer>;
  onGet?: (key: StorageKey) => void;
}): Storage {
  return {
    backend: 'cache-api',
    async get(key: StorageKey): Promise<CachedEntry | null> {
      opts?.onGet?.(key);
      if (!opts?.cachedBytes) return null;
      return {
        response: new Response(opts.cachedBytes),
        sizeBytes: opts.cachedBytes.byteLength,
      };
    },
    async put() {},
    async has() { return false; },
    async verify() { return false; },
    async remove() {},
    async listForModel() { return []; },
    async clearModel() {},
  };
}

let engine: LiteRTEngine;
let adapter: LiteRTAdapter;

beforeEach(() => {
  engine = makeEngine();
  adapter = new LiteRTAdapter({ engineFactory: async () => engine });
});

afterEach(async () => {
  await adapter.unload().catch(() => undefined);
});

// ─── Load ──────────────────────────────────────────────────────────────────

describe('LiteRTAdapter — load', () => {
  it('loads via factory and reports webgpu backend', async () => {
    await adapter.load(MODEL);
    expect(adapter.isLoaded).toBe(true);
    expect(adapter.activeModel?.id).toBe(MODEL.id);
    expect(adapter.backend).toBe('webgpu');
  });

  it('streams the cached .litertlm from storage into the engine (no re-fetch)', async () => {
    // The setup/download pipeline already streamed the bundle to Eco storage.
    // The adapter must hand the engine that cached stream — NOT a URL the
    // engine would re-fetch (a wasteful second 2 GB download).
    const bytes = new Uint8Array([7, 8, 9, 10, 11]);
    let receivedModel: string | ReadableStream<Uint8Array> | undefined;
    let receivedMaxTokens: number | undefined;
    adapter = new LiteRTAdapter({
      storage: makeStorage({ cachedBytes: bytes }),
      engineFactory: async ({ model, maxNumTokens }) => {
        receivedModel = model;
        receivedMaxTokens = maxNumTokens;
        return engine;
      },
    });
    await adapter.load(MODEL);
    expect(receivedModel).toBeInstanceOf(ReadableStream);
    const streamed = new Uint8Array(
      await new Response(receivedModel as ReadableStream<Uint8Array>).arrayBuffer(),
    );
    expect(streamed).toEqual(bytes);
    expect(receivedMaxTokens).toBe(2048);
  });

  it('reads storage with the catalog-id + relative proxy-path key', async () => {
    let receivedKey: StorageKey | undefined;
    adapter = new LiteRTAdapter({
      storage: makeStorage({
        cachedBytes: new Uint8Array([1]),
        onGet: (key) => { receivedKey = key; },
      }),
      engineFactory: async () => engine,
    });
    await adapter.load(MODEL);
    expect(receivedKey).toEqual({
      modelId: 'candidate/gemma-4-e2b-litert',
      url: CACHED_LITERTLM_KEY,
    });
  });

  it('falls back to the absolute self-fetch URL when storage has no cached copy', async () => {
    let receivedModel: string | ReadableStream<Uint8Array> | undefined;
    adapter = new LiteRTAdapter({
      storage: makeStorage(), // get() returns null → cache miss
      engineFactory: async ({ model }) => {
        receivedModel = model;
        return engine;
      },
    });
    await adapter.load(MODEL);
    expect(typeof receivedModel).toBe('string');
    expect(receivedModel).toContain(CACHED_LITERTLM_KEY);
  });

  it('rejects with AdapterError when artifact.files is empty', async () => {
    const noFiles: ModelConfig = {
      ...MODEL,
      artifact: { hfId: 'x/y', revision: 'r', files: [] },
    };
    await expect(adapter.load(noFiles)).rejects.toThrowError(/missing artifact\.files/i);
  });

  it('rejects with AdapterError when artifact is missing', async () => {
    const noArtifact: ModelConfig = { ...MODEL, artifact: undefined };
    await expect(adapter.load(noArtifact)).rejects.toBeInstanceOf(AdapterError);
  });

  it('engine factory failure → AdapterError, not loaded', async () => {
    adapter = new LiteRTAdapter({ engineFactory: async () => { throw new Error('boom'); } });
    await expect(adapter.load(MODEL)).rejects.toBeInstanceOf(AdapterError);
    expect(adapter.isLoaded).toBe(false);
  });

  it('classifies OOM in factory failure', async () => {
    adapter = new LiteRTAdapter({
      engineFactory: async () => { throw new Error('Aborted(): out of memory'); },
    });
    try {
      await adapter.load(MODEL);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as AdapterError).code).toBe('oom');
    }
  });
});

// ─── Generate ──────────────────────────────────────────────────────────────

describe('LiteRTAdapter — generate', () => {
  beforeEach(async () => {
    await adapter.load(MODEL);
  });

  it('yields token deltas then done with a token count', async () => {
    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    const text = events.filter((e) => e.kind === 'token').map((e) => (e.kind === 'token' ? e.text : '')).join('');
    expect(text).toBe('Hello world');
    const done = events.find((e) => e.kind === 'done');
    expect(done).toBeDefined();
    if (done?.kind === 'done') expect(done.completionTokens).toBe(2);
  });

  it('handles CUMULATIVE chunks by emitting only the new suffix', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'The' },
        { role: 'assistant', content: 'The cap' },
        { role: 'assistant', content: 'The capital' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);
    const tokens: string[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      if (event.kind === 'token') tokens.push(event.text);
    }
    expect(tokens).toEqual(['The', ' cap', 'ital']);
  });

  it('handles plain-string DELTA chunks', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'assistant', content: 'c' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);
    const tokens: string[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      if (event.kind === 'token') tokens.push(event.text);
    }
    expect(tokens.join('')).toBe('abc');
  });

  it('maps sampling options + preface into the conversation config', async () => {
    let captured: LiteRTConversationConfig | undefined;
    engine = makeEngine({ onCreateConversation: (config) => { captured = config; } });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate(
      [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      { temperature: 0.3, topK: 64, topP: 0.95, maxTokens: 256 },
    )) {
      events.push(event);
    }

    expect(captured?.sessionConfig?.samplerParams).toEqual({ temperature: 0.3, k: 64, p: 0.95 });
    expect(captured?.sessionConfig?.maxOutputTokens).toBe(256);
    // Preface = all but the final user turn.
    expect(captured?.preface?.messages?.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('temperature 0 → deterministic GREEDY sampler (type 3, no temp/k/p)', async () => {
    let captured: LiteRTConversationConfig | undefined;
    engine = makeEngine({ onCreateConversation: (config) => { captured = config; } });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate(
      [{ role: 'user', content: 'hi' }],
      // The eval harness's greedy arm passes temperature 0 (and the profile's
      // topK/topP, which greedy must ignore).
      { temperature: 0, topK: 64, topP: 0.95, maxTokens: 256 },
    )) {
      events.push(event);
    }

    // GREEDY (SamplerType.GREEDY = 3) and nothing else — temp/k/p are dropped
    // because they're undefined under argmax.
    expect(captured?.sessionConfig?.samplerParams).toEqual({ type: 3 });
    expect(captured?.sessionConfig?.maxOutputTokens).toBe(256);
  });

  it('ignores unsupported Transformers-only controls instead of inventing LiteRT parity', async () => {
    let captured: LiteRTConversationConfig | undefined;
    engine = makeEngine({ onCreateConversation: (config) => { captured = config; } });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate(
      [{ role: 'user', content: 'hi' }],
      {
        temperature: 0.3,
        topK: 64,
        topP: 0.95,
        repetitionPenalty: 1.12,
        noRepeatNgramSize: 4,
        maxTokens: 256,
      },
    )) {
      events.push(event);
    }

    expect(captured?.sessionConfig?.samplerParams).toEqual({ temperature: 0.3, k: 64, p: 0.95 });
    expect(JSON.stringify(captured?.sessionConfig?.samplerParams)).not.toMatch(/repetition|ngram/i);
  });

  it('truncates delta chunks at LiteRT chat template sentinels and still emits done', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'OK<|im_end|>extra' },
        { role: 'assistant', content: 'should not be read' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const tokens = events.filter((e) => e.kind === 'token').map((e) => (e.kind === 'token' ? e.text : ''));
    expect(tokens.join('')).toBe('OK');
    expect(tokens.join('')).not.toContain('<|im_end|>');
    expect(tokens.join('')).not.toContain('extra');
    expect(events[events.length - 1]).toMatchObject({ kind: 'done', completionTokens: 1 });
  });

  it('truncates cumulative chunks at LiteRT chat template sentinels without double-emitting', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'The' },
        { role: 'assistant', content: 'The answer' },
        { role: 'assistant', content: 'The answer<end_of_turn>ignored' },
        { role: 'assistant', content: 'The answer ignored twice' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const tokens = events.filter((e) => e.kind === 'token').map((e) => (e.kind === 'token' ? e.text : ''));
    expect(tokens).toEqual(['The', ' answer']);
    expect(tokens.join('')).toBe('The answer');
    expect(tokens.join('')).not.toContain('<end_of_turn>');
    expect(tokens.join('')).not.toContain('ignored');
    expect(events[events.length - 1]).toMatchObject({ kind: 'done', completionTokens: 2 });
  });

  it('truncates a LiteRT stop sentinel split across delta chunks', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'OK<|im' },
        { role: 'assistant', content: '_end|>extra' },
        { role: 'assistant', content: 'should not be read' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const text = events.filter((e) => e.kind === 'token').map((e) => (e.kind === 'token' ? e.text : '')).join('');
    expect(text).toBe('OK');
    expect(text).not.toContain('<|im_end|>');
    expect(text).not.toContain('extra');
    expect(events[events.length - 1]).toMatchObject({ kind: 'done', completionTokens: 1 });
  });

  it('truncates a LiteRT stop sentinel split across cumulative chunks', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'OK<|im' },
        { role: 'assistant', content: 'OK<|im_end|>extra' },
        { role: 'assistant', content: 'OK<|im_end|>extra should not be read' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const text = events.filter((e) => e.kind === 'token').map((e) => (e.kind === 'token' ? e.text : '')).join('');
    expect(text).toBe('OK');
    expect(text).not.toContain('<|im_end|>');
    expect(text).not.toContain('extra');
    expect(events[events.length - 1]).toMatchObject({ kind: 'done', completionTokens: 1 });
  });

  it('reports LiteRT completionTokens as visible chunk count, not tokenizer accounting', async () => {
    engine = makeEngine({
      chunks: [
        { role: 'assistant', content: 'Alpha' },
        { role: 'assistant', content: ' beta' },
        { role: 'assistant', content: ' gamma' },
      ],
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }

    const done = events.find((event) => event.kind === 'done');
    expect(done).toMatchObject({ kind: 'done', completionTokens: 3 });
    if (done?.kind === 'done') {
      expect(done.promptTokens).toBeUndefined();
      expect(done.tokenizerName).toBeUndefined();
    }
  });

  it('aborts via signal — conversation.cancel called, last event is error', async () => {
    let cancelled = false;
    engine = makeEngine({
      onCancel: () => { cancelled = true; },
      streamFactory: () =>
        streamOf(
          Array.from({ length: 100 }, (_, i) => ({
            role: 'assistant',
            content: [{ type: 'text', text: `t${i} ` }],
          })),
          5,
        ),
    });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);

    const controller = new AbortController();
    const events: TokenEvent[] = [];
    for await (const event of adapter.generate(
      [{ role: 'user', content: 'long' }],
      { signal: controller.signal },
    )) {
      events.push(event);
      if (events.length >= 2) controller.abort();
    }
    expect(cancelled).toBe(true);
    expect(events[events.length - 1]?.kind).toBe('error');
  });

  it('emits a single error event when createConversation throws', async () => {
    engine = makeEngine({ createConversationFails: new Error('inference failed') });
    adapter = new LiteRTAdapter({ engineFactory: async () => engine });
    await adapter.load(MODEL);
    const events: TokenEvent[] = [];
    for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
      events.push(event);
    }
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('error');
  });
});

// ─── Unload ────────────────────────────────────────────────────────────────

describe('LiteRTAdapter — unload', () => {
  it('clears state and is safe to call when not loaded', async () => {
    await adapter.unload();
    expect(adapter.isLoaded).toBe(false);

    await adapter.load(MODEL);
    await adapter.unload();
    expect(adapter.isLoaded).toBe(false);
    expect(adapter.activeModel).toBeNull();
  });
});
