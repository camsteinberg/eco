// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A WebGPU device lost while the page sits in the background (a phone locked
 * for a few minutes), on ONNX — every Android pick runs here. The WebLLM
 * sequence is in `stream.gpu-loss.test.ts`.
 *
 * Real path: stream() → runtime lifecycle → TransformersAdapter → fake workers
 * that behave like the real one at its message boundary: a loaded model whose
 * device can be lost (`device-lost`, then failing requests the way
 * `classify-generation-error` reads them), and a worker whose page has no
 * WebGPU adapter. With no adapter the real worker falls back to the WASM EP
 * unless the init requires WebGPU; for these WebGPU-only builds that fallback
 * fails in session init ("Kernel not found"), which reads as a crash. Only
 * bootstrap is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../bootstrap', () => ({ bootstrapLocalAi: vi.fn(async () => undefined) }));

import { stream } from '../stream';
import {
  _resetLifecycleForTesting,
  getActiveAdapter,
  setAdapterFactory,
  subscribeDeviceLost,
} from '../lifecycle';
import { __resetGpuOwnershipForTests } from '../gpu-ownership';
import {
  TransformersAdapter,
  type WorkerInbound,
  type WorkerLike,
  type WorkerOutbound,
} from '../transformers-adapter';
import { LocalInferenceStreamError } from '../errors';
import { CacheApiStorage, type CacheStorageLike } from '../../download/storage';
import { getModel } from '../../catalog/catalog';
import { setSlot, setSlotStatus } from '../../lifecycle/slots';
import type { ModelConfig } from '../../types';

// Android's pick on a GPU with shader-f16 (WebGPU-only build), and its pick on
// one without (a build the CPU EP cannot run).
const MODEL_F16 = getModel('candidate/lfm2.5-1.2b-instruct-onnx')!;
const MODEL_Q4 = getModel('candidate/lfm2.5-1.2b-instruct-q4-onnx')!;

const STRIKES_KEY = 'eco-local-ai-fault-strikes-v1';
const COOLDOWNS_KEY = 'eco-local-ai-cooldowns-v1';
const RECONNECT = 'GPU_RECONNECT | One moment — Eco is refreshing to pick up where you left off.';
// What onnxruntime-web's CPU EP throws in session init for these builds.
const KERNEL_NOT_FOUND = 'Could not find an implementation for GatherBlockQuantized(1) node with name ...';

const noCaches: CacheStorageLike = {
  open: async () => {
    throw new Error('unused');
  },
  has: async () => false,
  keys: async () => [],
  delete: async () => false,
};

type Page = { adapter: 'available' | 'none' };

/** A worker that answers like the real one, for one load. */
class OnnxWorker implements WorkerLike {
  private readonly listeners = new Set<(e: MessageEvent<WorkerOutbound>) => void>();
  private lost = false;

  constructor(private readonly page: Page) {}

  postMessage(msg: WorkerInbound): void {
    setTimeout(() => this.answer(msg), 0);
  }

  private answer(msg: WorkerInbound): void {
    if (msg.type === 'init') {
      if (this.page.adapter === 'available') this.emit({ type: 'ready', backend: 'webgpu' });
      else if (msg.requireWebGpu === true) {
        this.emit({ type: 'error', code: 'webgpu-unavailable', message: `${msg.modelFriendlyName} needs WebGPU, and this page cannot get a WebGPU adapter.` });
      } else {
        // The WASM fallback: the session cannot be built on the CPU EP.
        this.emit({ type: 'error', code: 'init-failed', message: KERNEL_NOT_FOUND });
      }
    } else if (msg.type === 'countTokens') {
      this.emit({ type: 'tokenCount', requestId: msg.requestId, count: Math.ceil(msg.text.length / 4) });
    } else if (msg.type === 'generate') {
      if (this.lost) {
        this.emit({ type: 'error', generationId: msg.generationId, code: 'device-lost', message: 'GPUDevice was lost' });
        return;
      }
      this.emit({ type: 'token', generationId: msg.generationId, text: 'hi', seq: 1 });
      this.emit({ type: 'done', generationId: msg.generationId, finishReason: 'eos', promptTokens: 3, completionTokens: 1 });
    }
  }

  /** The browser takes the device: the real worker reports it, then fails requests. */
  loseDevice(): void {
    this.lost = true;
    this.emit({ type: 'device-lost', message: 'GPU process was lost' });
  }

  private emit(data: WorkerOutbound): void {
    for (const listener of [...this.listeners]) listener({ data } as MessageEvent<WorkerOutbound>);
  }

  addEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
    if (type === 'message') this.listeners.add(listener as (e: MessageEvent<WorkerOutbound>) => void);
  }
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: unknown): void {
    if (type === 'message') this.listeners.delete(listener as (e: MessageEvent<WorkerOutbound>) => void);
  }
  terminate(): void {
    this.listeners.clear();
  }
}

let page: Page;
let workers: OnnxWorker[];

function serveWorkers(): void {
  setAdapterFactory(
    () =>
      new TransformersAdapter({
        storage: new CacheApiStorage(noCaches),
        workerFactory: () => {
          const worker = new OnnxWorker(page);
          workers.push(worker);
          return worker;
        },
      }),
  );
}

/** One send: the reply text, or `CODE | message` for the error it threw. */
async function send(model: ModelConfig): Promise<string> {
  let text = '';
  try {
    for await (const event of stream([{ role: 'user', content: 'hello' }], model.id)) {
      if (event.kind === 'token') text += event.text;
    }
    return `reply: ${text}`;
  } catch (err) {
    if (err instanceof LocalInferenceStreamError) return `${err.code} | ${err.message}`;
    return `thrown: ${String(err)}`;
  }
}

/** Let worker answers and fire-and-forget unloads settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  window.localStorage.clear();
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  page = { adapter: 'available' };
  workers = [];
  serveWorkers();
  setSlot('eco-fast', MODEL_F16);
  setSlotStatus('eco-fast', 'ready');
});

afterEach(() => {
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  window.localStorage.clear();
});

describe('stream — an ONNX model\'s GPU device lost while the page was in the background', () => {
  it('notices the loss when it happens, so GPU recovery can run before the next message', async () => {
    const noticed = vi.fn();
    const unsubscribe = subscribeDeviceLost(noticed);
    expect(await send(MODEL_F16)).toBe('reply: hi');

    workers[0]!.loseDevice();
    unsubscribe();

    expect(noticed).toHaveBeenCalledTimes(1);
    expect(getActiveAdapter()?.deviceLost).toBe(true);
  });

  it('reloads the model and answers the next message when this page can still get an adapter', async () => {
    expect(await send(MODEL_F16)).toBe('reply: hi');
    workers[0]!.loseDevice();

    expect(await send(MODEL_F16)).toBe('reply: hi');
    expect(workers).toHaveLength(2);
    expect(window.localStorage.getItem(STRIKES_KEY)).toBeNull();
    expect(window.localStorage.getItem(COOLDOWNS_KEY)).toBeNull();
  });

  it('routes the next message and its Try again to one page refresh when this page can no longer get an adapter', async () => {
    expect(await send(MODEL_F16)).toBe('reply: hi');
    workers[0]!.loseDevice();
    page.adapter = 'none';

    const afterLock = await send(MODEL_F16);
    await settle();
    const tryAgain = await send(MODEL_F16);
    await settle();

    expect([afterLock, tryAgain]).toEqual([RECONNECT, RECONNECT]);
    expect(window.localStorage.getItem(STRIKES_KEY)).toBeNull();
    expect(window.localStorage.getItem(COOLDOWNS_KEY)).toBeNull();
  });
});

// The case with no loss at all: a page that never had an adapter for a
// WebGPU-only build (e.g. the reload after a GPU that never came back). Before,
// the worker fell back to the CPU, failed in session init, and the failure read
// as a crash: a five-minute cooldown, so Try again showed the "short breather"
// countdown. Now it fails as `webgpu-unavailable`: the same "needed a moment"
// card each time, no strike, no cooldown — and never a page refresh, since this
// page lost no device (`GPU_RECONNECT` needs one), so no reload loop.
describe('stream — a WebGPU-only ONNX build on a page with no WebGPU adapter (no loss)', () => {
  it.each([
    ['the f16 build (WebGPU-only)', MODEL_F16],
    ['the plain-int4 build (the CPU EP cannot run it)', MODEL_Q4],
  ])('%s: the same honest error on every send — no cooldown, no refresh', async (_label, model) => {
    setSlot('eco-fast', model);
    page.adapter = 'none';
    const needsWebGpu = `WORKER_CRASHED | ${model.friendlyName} needs WebGPU, and this page cannot get a WebGPU adapter.`;

    const first = await send(model);
    await settle();
    const tryAgain = await send(model);
    await settle();

    expect([first, tryAgain]).toEqual([needsWebGpu, needsWebGpu]);
    expect(window.localStorage.getItem(COOLDOWNS_KEY)).toBeNull();
    expect(window.localStorage.getItem(STRIKES_KEY)).toBeNull();
  });
});
