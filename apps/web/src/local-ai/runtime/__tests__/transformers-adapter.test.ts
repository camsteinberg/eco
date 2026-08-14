// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheApiStorage, type CacheLike, type CacheStorageLike } from '../../download/storage';
import type { ModelConfig } from '../../types';
import { TransformersAdapter, getOnnxExternalDataChunks, type WorkerInbound, type WorkerLike, type WorkerOutbound } from '../transformers-adapter';

class MemoryCache implements CacheLike {
  store = new Map<string, Response>();
  async put(r: RequestInfo | URL, res: Response): Promise<void> { this.store.set(k(r), res.clone()); }
  async match(r: RequestInfo | URL): Promise<Response | undefined> { const v = this.store.get(k(r)); return v ? v.clone() : undefined; }
  async keys(): Promise<readonly Request[]> { return Array.from(this.store.keys()).map((u) => new Request(u)); }
  async delete(r: RequestInfo | URL): Promise<boolean> { return this.store.delete(k(r)); }
}
class MemoryCacheStorage implements CacheStorageLike {
  caches = new Map<string, MemoryCache>();
  async open(name: string): Promise<MemoryCache> { let c = this.caches.get(name); if (!c) { c = new MemoryCache(); this.caches.set(name, c); } return c; }
  async has(name: string): Promise<boolean> { return this.caches.has(name); }
  async keys(): Promise<string[]> { return Array.from(this.caches.keys()); }
  async delete(name: string): Promise<boolean> { return this.caches.delete(name); }
}
function k(r: RequestInfo | URL): string { if (typeof r === 'string') return r; if (r instanceof URL) return r.toString(); return r.url; }

class FakeWorker implements WorkerLike {
  inbox: WorkerInbound[] = [];
  listeners: Array<(e: MessageEvent<WorkerOutbound>) => void> = [];
  terminated = false;

  postMessage(msg: WorkerInbound): void {
    this.inbox.push(msg);
  }
  addEventListener(_: 'message', l: (e: MessageEvent<WorkerOutbound>) => void): void {
    this.listeners.push(l);
  }
  removeEventListener(_: 'message', l: (e: MessageEvent<WorkerOutbound>) => void): void {
    const i = this.listeners.indexOf(l);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  terminate(): void { this.terminated = true; }

  /** Test helper: emit an event to all listeners. */
  emit(msg: WorkerOutbound): void {
    const event = { data: msg } as MessageEvent<WorkerOutbound>;
    for (const l of [...this.listeners]) l(event);
  }
}

const MODEL: ModelConfig = {
  id: 'local/phi3-mini-4k-q4f16',
  friendlyName: 'Phi-3 Mini',
  vendor: 'Microsoft',
  sizeGB: 2.14,
  runtime: 'transformers',
  format: 'onnx-q4f16',
  capabilities: { intent: ['balanced'], tasks: ['chat'], contextTokens: 4096 },
  bestFor: 't', knownLimitation: 'k', evidenceTier: 'proven',
  artifact: {
    hfId: 'microsoft/Phi-3-mini-4k-instruct-onnx-web',
    revision: '80a2792f5bf861528ce9b449b3230f1bd3fdc759',
    files: ['onnx/model_q4f16.onnx', 'config.json'],
  },
};

let worker: FakeWorker;
let storage: CacheApiStorage;
let adapter: TransformersAdapter;

beforeEach(() => {
  worker = new FakeWorker();
  storage = new CacheApiStorage(new MemoryCacheStorage());
  adapter = new TransformersAdapter({
    storage,
    workerFactory: () => worker,
    generateId: () => 'test-gen-id',
  });
});

afterEach(async () => {
  await adapter.unload().catch(() => undefined);
});

describe('TransformersAdapter — load', () => {
  it('posts init to worker and resolves on ready', async () => {
    const loadPromise = adapter.load(MODEL);
    // Schedule the ready response after the postMessage.
    await Promise.resolve();
    expect(worker.inbox[0]?.type).toBe('init');
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
    expect(adapter.isLoaded).toBe(true);
    expect(adapter.backend).toBe('webgpu');
    expect(adapter.activeModel?.id).toBe(MODEL.id);
  });

  it('forwards init failures as AdapterError', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    worker.emit({ type: 'error', code: 'init-failed', message: 'no webgpu' });
    await expect(loadPromise).rejects.toThrowError(/no webgpu/i);
  });

  it("classifies an aborted load as 'aborted', not 'init-failed' (an abort is not a crash — must not poison the cooldown)", async () => {
    const controller = new AbortController();
    const loadPromise = adapter.load(MODEL, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(loadPromise).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'aborted',
    });
  });

  it("classifies a load started with an already-aborted signal as 'aborted'", async () => {
    const controller = new AbortController();
    controller.abort();
    const loadPromise = adapter.load(MODEL, { signal: controller.signal });
    await expect(loadPromise).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'aborted',
    });
  });

  it('passes forceWasm through to init', async () => {
    const loadPromise = adapter.load(MODEL, { forceWasm: true });
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.forceWasm).toBe(true);
    worker.emit({ type: 'ready', backend: 'wasm' });
    await loadPromise;
    expect(adapter.backend).toBe('wasm');
  });

  it('defaults forceWasm from the ?eco-force-wasm URL override when the caller does not set it', async () => {
    window.history.replaceState({}, '', '/?eco-force-wasm=1');
    try {
      const loadPromise = adapter.load(MODEL);
      await Promise.resolve();
      const init = worker.inbox[0]!;
      if (init.type !== 'init') throw new Error('expected init');
      expect(init.forceWasm).toBe(true);
      worker.emit({ type: 'ready', backend: 'wasm' });
      await loadPromise;
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('lets explicit caller intent win over the URL override', async () => {
    window.history.replaceState({}, '', '/?eco-force-wasm=1');
    try {
      const loadPromise = adapter.load(MODEL, { forceWasm: false });
      await Promise.resolve();
      const init = worker.inbox[0]!;
      if (init.type !== 'init') throw new Error('expected init');
      expect(init.forceWasm).toBe(false);
      worker.emit({ type: 'ready', backend: 'webgpu' });
      await loadPromise;
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('omits the ORT levers when no ?eco-force-* override is present (default path unchanged)', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.ortArtifact).toBeUndefined();
    expect(init.numThreads).toBeUndefined();
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('threads ?eco-force-ort-artifact and ?eco-force-threads into init', async () => {
    window.history.replaceState({}, '', '/?eco-force-ort-artifact=jspi&eco-force-threads=4');
    try {
      const loadPromise = adapter.load(MODEL);
      await Promise.resolve();
      const init = worker.inbox[0]!;
      if (init.type !== 'init') throw new Error('expected init');
      expect(init.ortArtifact).toBe('jspi');
      expect(init.numThreads).toBe(4);
      worker.emit({ type: 'ready', backend: 'wasm' });
      await loadPromise;
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });

  it('reports progress via onLoadProgress', async () => {
    const progress: number[] = [];
    const loadPromise = adapter.load(MODEL, { onLoadProgress: (p) => progress.push(p) });
    await Promise.resolve();
    worker.emit({ type: 'progress', loaded: 25, total: 100 });
    worker.emit({ type: 'progress', loaded: 100, total: 100 });
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
    expect(progress).toEqual([0.25, 1]);
  });

  it('sends hfId (not catalog modelId) to worker for TJS from_pretrained', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.hfId).toBe('microsoft/Phi-3-mini-4k-instruct-onnx-web');
    expect(init.modelId).toBe('local/phi3-mini-4k-q4f16');
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('derives dtype from model format', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.dtype).toBe('q4f16');
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;

    // Test onnx-q4 format → q4 dtype
    await adapter.unload();
    const q4Model: ModelConfig = {
      ...MODEL,
      id: 'local/qwen3-0.6b',
      format: 'onnx-q4',
      artifact: {
        hfId: 'onnx-community/Bonsai-1.7B-ONNX',
        revision: '3f3cf175',
        files: ['onnx/model_q4.onnx', 'config.json'],
      },
    };
    worker = new FakeWorker();
    adapter = new TransformersAdapter({
      storage,
      workerFactory: () => worker,
      generateId: () => 'test-gen-id',
    });
    const loadPromise2 = adapter.load(q4Model);
    await Promise.resolve();
    const init2 = worker.inbox[0]!;
    if (init2.type !== 'init') throw new Error('expected init');
    expect(init2.dtype).toBe('q4');
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise2;
  });

  it('passes cjkSuppression=true on init for opt-in models (Qwen3.5 smart pick)', async () => {
    const qwenModel: ModelConfig = {
      ...MODEL,
      id: 'candidate/qwen3.5-2b-onnx',
      artifact: {
        hfId: 'onnx-community/Qwen3.5-2B-ONNX-OPT',
        revision: 'abc123',
        files: ['onnx/model_q4f16.onnx', 'config.json'],
      },
    };
    const loadPromise = adapter.load(qwenModel);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.cjkSuppression).toBe(true);
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('skips model progress preflight for Qwen3.5 split text-session exports', async () => {
    const qwenModel: ModelConfig = {
      ...MODEL,
      id: 'candidate/qwen3.5-2b-onnx',
      artifact: {
        hfId: 'onnx-community/Qwen3.5-2B-ONNX-OPT',
        revision: 'abc123',
        files: [
          'onnx/decoder_model_merged_q4f16.onnx',
          'onnx/decoder_model_merged_q4f16.onnx_data',
          'onnx/embed_tokens_q4f16.onnx',
          'onnx/embed_tokens_q4f16.onnx_data',
          'config.json',
        ],
      },
    };

    const loadPromise = adapter.load(qwenModel);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect((init as { skipModelProgressPreflight?: boolean }).skipModelProgressPreflight).toBe(true);
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('omits cjkSuppression on init for models without the profile flag', async () => {
    // MODEL is Phi-3 — not opted in. The everyday default must never pay
    // the vocab scan.
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.cjkSuppression).toBeUndefined();
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('rejects with AdapterError when artifact.hfId is missing', async () => {
    const noArtifactModel: ModelConfig = {
      ...MODEL,
      artifact: undefined,
    };
    await expect(adapter.load(noArtifactModel)).rejects.toThrowError(/missing artifact\.hfId/i);
  });

  it('rejects with non-recoverable AdapterError on template-missing during load', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    worker.emit({
      type: 'error',
      code: 'template-missing',
      message: 'Tokenizer does not expose apply_chat_template.',
    });
    await expect(loadPromise).rejects.toMatchObject({
      name: 'AdapterError',
      code: 'template-missing',
      recoverable: false,
    });
  });
});

describe('TransformersAdapter — generate', () => {
  beforeEach(async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('yields tokens then done', async () => {
    const events: import('../types').TokenEvent[] = [];

    // Collect on a background task.
    const collector = (async () => {
      for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }
    })();

    // Wait for the inbox to have the generate message.
    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ type: 'token', generationId: 'test-gen-id', text: 'hello', seq: 1 });
    worker.emit({ type: 'token', generationId: 'test-gen-id', text: ' world', seq: 2 });
    worker.emit({ type: 'done', generationId: 'test-gen-id', promptTokens: 2, completionTokens: 4 });

    await collector;
    expect(events).toEqual([
      { kind: 'token', text: 'hello', seq: 1 },
      { kind: 'token', text: ' world', seq: 2 },
      // Two tokens streamed, so one inter-token gap was measured (a real
      // performance-clock delta — deterministic value covered by its own test).
      { kind: 'done', promptTokens: 2, completionTokens: 4, tokenizerName: undefined, maxInterTokenGapMs: expect.any(Number) },
    ]);
  });

  it('reports the max inter-token gap on done (#28 stall signature)', async () => {
    // Drive the adapter's performance clock so the gap is deterministic:
    // token1@0, token2@10 (gap 10), token3@100 (gap 90 = max). With no
    // onLifecycleEvent supplied, `now()` is called once per token and not on done.
    const nowSpy = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(100)
      .mockReturnValue(100);
    const events: import('../types').TokenEvent[] = [];
    const collector = (async () => {
      for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }
    })();
    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ type: 'token', generationId: 'test-gen-id', text: 'a', seq: 1 });
    worker.emit({ type: 'token', generationId: 'test-gen-id', text: 'b', seq: 2 });
    worker.emit({ type: 'token', generationId: 'test-gen-id', text: 'c', seq: 3 });
    worker.emit({ type: 'done', generationId: 'test-gen-id', completionTokens: 3 });
    await collector;
    const done = events.find((e) => e.kind === 'done');
    expect(done?.kind === 'done' && done.maxInterTokenGapMs).toBe(90);
    nowSpy.mockRestore();
  });

  it('passes kvReuse telemetry through on done', async () => {
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    const kvReuse = {
      decision: 'miss' as const,
      reason: 'not-strict-prefix' as const,
      cachedLen: 804,
      promptLen: 806,
      commonPrefixLen: 800,
      cacheCommitted: true,
    };
    worker.emit({
      type: 'done',
      generationId: 'test-gen-id',
      promptTokens: 9,
      completionTokens: 2,
      kvReuse,
    });

    await collector;
    expect(events).toEqual([
      // No tokens streamed, so no inter-token gap exists → null.
      { kind: 'done', promptTokens: 9, completionTokens: 2, tokenizerName: undefined, kvReuse, maxInterTokenGapMs: null },
    ]);
  });

  it('passes cjkSuppression telemetry through on done', async () => {
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    const cjkSuppression = {
      enabled: true,
      applied: true,
      reason: 'applied' as const,
      bannedTokenCount: 31873,
      scanMs: 240,
    };
    worker.emit({
      type: 'done',
      generationId: 'test-gen-id',
      promptTokens: 9,
      completionTokens: 2,
      cjkSuppression,
    });

    await collector;
    expect(events).toEqual([
      { kind: 'done', promptTokens: 9, completionTokens: 2, tokenizerName: undefined, cjkSuppression, maxInterTokenGapMs: null },
    ]);
  });

  it('aborts on signal — posts abort to worker', async () => {
    const controller = new AbortController();
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate(
        [{ role: 'user', content: 'hi' }],
        { signal: controller.signal },
      )) {
        events.push(event);
        if (events.length === 1) controller.abort();
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ type: 'token', generationId: 'test-gen-id', text: 'one', seq: 1 });
    // The abort listener should post abort to worker.
    await collector;

    const lastInbox = worker.inbox[worker.inbox.length - 1];
    expect(lastInbox?.type).toBe('abort');
    expect(events[events.length - 1]?.kind).toBe('error');
  });

  it('surfaces worker error events as error tokens', async () => {
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    worker.emit({ type: 'error', generationId: 'test-gen-id', code: 'oom', message: 'gpu oom' });
    await collector;
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('error');
  });

  it('yields template-missing error event during generate and ends cleanly', async () => {
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate([{ role: 'user', content: 'hi' }])) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();
    worker.emit({
      type: 'error',
      generationId: 'test-gen-id',
      code: 'template-missing',
      message: 'apply_chat_template not available',
    });
    await collector;
    expect(events).toEqual([
      { kind: 'error', reason: 'apply_chat_template not available', code: 'template-missing' },
    ]);
  });
});

describe('TransformersAdapter — generate postMessage safety', () => {
  beforeEach(async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('does NOT include AbortSignal in the postMessage payload', async () => {
    const controller = new AbortController();
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate(
        [{ role: 'user', content: 'hi' }],
        { signal: controller.signal, maxTokens: 4 },
      )) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();

    // Inspect the generate message posted to the worker.
    const generateMsg = worker.inbox.find((m) => m.type === 'generate');
    expect(generateMsg).toBeDefined();
    if (generateMsg?.type === 'generate') {
      // The options must NOT contain a signal property.
      expect(generateMsg.options).toBeDefined();
      expect('signal' in (generateMsg.options ?? {})).toBe(false);
      // It SHOULD still contain the cloneable fields.
      expect(generateMsg.options?.maxTokens).toBe(4);
    }

    // Clean up the async iterator.
    worker.emit({ type: 'done', generationId: 'test-gen-id' });
    await collector;
  });

  it('does NOT include onLifecycleEvent callback in the postMessage payload', async () => {
    const events: import('../types').TokenEvent[] = [];
    const lifecycleEvents: import('../types').LifecycleEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate(
        [{ role: 'user', content: 'hi' }],
        {
          maxTokens: 4,
          temperature: 0.5,
          onLifecycleEvent: (e) => lifecycleEvents.push(e),
        },
      )) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();

    const generateMsg = worker.inbox.find((m) => m.type === 'generate');
    expect(generateMsg).toBeDefined();
    if (generateMsg?.type === 'generate') {
      expect('onLifecycleEvent' in (generateMsg.options ?? {})).toBe(false);
      expect(generateMsg.options?.maxTokens).toBe(4);
      expect(generateMsg.options?.temperature).toBe(0.5);
    }

    worker.emit({ type: 'done', generationId: 'test-gen-id' });
    await collector;
  });

  it('forwards the full sampling profile (topP/topK/repetitionPenalty/noRepeatNgramSize) to the worker', async () => {
    const collector = (async () => {
      // Drain the iterator; this test asserts on the posted message, not output.
      for await (const _event of adapter.generate(
        [{ role: 'user', content: 'hi' }],
        {
          temperature: 0.6,
          maxTokens: 256,
          topP: 0.95,
          topK: 40,
          repetitionPenalty: 1.1,
          noRepeatNgramSize: 3,
        },
      )) {
        void _event;
      }
    })();

    await Promise.resolve();
    await Promise.resolve();

    const generateMsg = worker.inbox.find((m) => m.type === 'generate');
    expect(generateMsg).toBeDefined();
    if (generateMsg?.type === 'generate') {
      // Proves the adapter spreads the sampling fields onto the worker
      // `generate` message — the worker then maps them to TJS param names.
      expect(generateMsg.options?.topP).toBe(0.95);
      expect(generateMsg.options?.topK).toBe(40);
      expect(generateMsg.options?.repetitionPenalty).toBe(1.1);
      expect(generateMsg.options?.noRepeatNgramSize).toBe(3);
      expect(generateMsg.options?.temperature).toBe(0.6);
      expect(generateMsg.options?.maxTokens).toBe(256);
    }

    worker.emit({ type: 'done', generationId: 'test-gen-id' });
    await collector;
  });

  it('sends abort message when signal fires, worker receives {type: abort}', async () => {
    const controller = new AbortController();
    const events: import('../types').TokenEvent[] = [];

    const collector = (async () => {
      for await (const event of adapter.generate(
        [{ role: 'user', content: 'hi' }],
        { signal: controller.signal },
      )) {
        events.push(event);
      }
    })();

    await Promise.resolve();
    await Promise.resolve();

    // Abort the signal.
    controller.abort();

    // The worker should have received an {type: 'abort'} message.
    const abortMsg = worker.inbox.find((m) => m.type === 'abort');
    expect(abortMsg).toBeDefined();
    if (abortMsg?.type === 'abort') {
      expect(abortMsg.generationId).toBe('test-gen-id');
    }

    await collector;
  });
});

describe('TransformersAdapter — unload', () => {
  it('terminates the worker and clears state', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;

    await adapter.unload();
    expect(worker.terminated).toBe(true);
    expect(adapter.isLoaded).toBe(false);
    expect(adapter.activeModel).toBeNull();
  });
});

// ─── getOnnxExternalDataChunks ────────────────────────────────────────────

describe('getOnnxExternalDataChunks', () => {
  it('maps a single-chunk artifact to count 1, keyed by basename', () => {
    const model: ModelConfig = {
      ...MODEL,
      artifact: {
        hfId: 'microsoft/Phi-3-mini-4k-instruct-onnx-web',
        revision: '80a2792f5bf861528ce9b449b3230f1bd3fdc759',
        files: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'config.json'],
      },
    };
    expect(getOnnxExternalDataChunks(model)).toEqual({ 'model_q4f16.onnx': 1 });
  });

  it('counts multi-chunk data files and maps multi-session artifacts per file', () => {
    // Qwen3.5-4B shape: two-chunk decoder + single-chunk embed_tokens.
    const model: ModelConfig = {
      ...MODEL,
      artifact: {
        hfId: 'onnx-community/Qwen3.5-4B-ONNX-OPT',
        revision: '57b13b4dce7be073be0df3eaf1c842a6bbb2e0a7',
        files: [
          'onnx/decoder_model_merged_q4f16.onnx',
          'onnx/decoder_model_merged_q4f16.onnx_data',
          'onnx/decoder_model_merged_q4f16.onnx_data_1',
          'onnx/embed_tokens_q4f16.onnx',
          'onnx/embed_tokens_q4f16.onnx_data',
          'config.json',
        ],
      },
    };
    expect(getOnnxExternalDataChunks(model)).toEqual({
      'decoder_model_merged_q4f16.onnx': 2,
      'embed_tokens_q4f16.onnx': 1,
    });
  });

  it('returns an empty map when artifact files have no .onnx_data', () => {
    const model: ModelConfig = {
      ...MODEL,
      artifact: {
        hfId: 'onnx-community/Qwen3-0.6B-ONNX',
        revision: 'da145310',
        files: ['onnx/model_q4f16.onnx', 'config.json', 'tokenizer.json'],
      },
    };
    expect(getOnnxExternalDataChunks(model)).toEqual({});
  });

  it('returns an empty map when model has no artifact', () => {
    const model: ModelConfig = { ...MODEL, artifact: undefined };
    expect(getOnnxExternalDataChunks(model)).toEqual({});
  });
});

// ─── revision propagation ───────────────────────────────────────────────

describe('TransformersAdapter — revision propagation', () => {
  it('sends revision from artifact to worker init message', async () => {
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.revision).toBe('80a2792f5bf861528ce9b449b3230f1bd3fdc759');
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('propagates different revision values faithfully', async () => {
    const altRevModel: ModelConfig = {
      ...MODEL,
      id: 'local/qwen3-0.6b',
      format: 'onnx-q4',
      artifact: {
        hfId: 'onnx-community/Bonsai-1.7B-ONNX',
        revision: '3f3cf175abcd1234',
        files: ['onnx/model_q4.onnx', 'config.json'],
      },
    };
    const loadPromise = adapter.load(altRevModel);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.revision).toBe('3f3cf175abcd1234');
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('sends undefined revision when model has no artifact', async () => {
    // Model without artifact should fail before reaching revision, but this
    // validates the type path when artifact is completely absent.
    const noArtifactModel: ModelConfig = { ...MODEL, artifact: undefined };
    // This rejects due to missing hfId; that's expected.
    await expect(adapter.load(noArtifactModel)).rejects.toThrowError(/missing artifact\.hfId/i);
    // No init message should have been posted.
    expect(worker.inbox.length).toBe(0);
  });
});

// ─── externalDataChunks propagation ───────────────────────────────────────

describe('TransformersAdapter — externalDataChunks propagation', () => {
  it('sends the per-file chunk map when artifact has .onnx_data files', async () => {
    const phi3WithExtData: ModelConfig = {
      ...MODEL,
      artifact: {
        hfId: 'microsoft/Phi-3-mini-4k-instruct-onnx-web',
        revision: '80a2792f5bf861528ce9b449b3230f1bd3fdc759',
        files: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'config.json'],
      },
    };
    const loadPromise = adapter.load(phi3WithExtData);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.externalDataChunks).toEqual({ 'model_q4f16.onnx': 1 });
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });

  it('omits externalDataChunks when artifact has no .onnx_data files', async () => {
    // MODEL fixture has no .onnx_data files
    const loadPromise = adapter.load(MODEL);
    await Promise.resolve();
    const init = worker.inbox[0]!;
    if (init.type !== 'init') throw new Error('expected init');
    expect(init.externalDataChunks).toBeUndefined();
    worker.emit({ type: 'ready', backend: 'webgpu' });
    await loadPromise;
  });
});
