// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A WebGPU device lost while the page sits in the background (a phone locked
 * for a few minutes), with the page itself kept alive.
 *
 * What a real iPhone did: WebLLM's own `device.lost` handler disposed the
 * loaded pipeline, so the next send failed at once with "The current Object
 * has already been disposed"; Try again then loaded from cold and failed with
 * "Unable to find a compatible GPU…" because the page could no longer get a
 * WebGPU adapter. Only a page reload recovered.
 *
 * Real path: stream() → runtime lifecycle → WebLLMAdapter → fake engines that
 * reproduce both failures. Only bootstrap is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../bootstrap', () => ({ bootstrapLocalAi: vi.fn(async () => undefined) }));

import { stream } from '../stream';
import { _resetLifecycleForTesting, setAdapterFactory } from '../lifecycle';
import { __resetGpuOwnershipForTests } from '../gpu-ownership';
import { WebLLMAdapter, type WebLLMEngine } from '../webllm-adapter';
import { stripMlcOrgPrefix } from '../webllm-config';
import { LocalInferenceStreamError } from '../errors';
import { getModel } from '../../catalog/catalog';
import { setSlot, setSlotStatus } from '../../lifecycle/slots';

// The shipping iPhone model — a real catalog entry, so the slot store resolves it.
const MODEL = getModel('candidate/qwen2.5-0.5b-mlc')!;
const MLC_ID = stripMlcOrgPrefix(MODEL.artifact!.hfId);

// Verbatim from @mlc-ai/web-llm 0.2.84: TVMObject.typeIndex() on a disposed
// object, and detectGPUDevice() when requestAdapter() resolves null.
const DISPOSED = 'The current Object has already been disposed';
const NO_ADAPTER =
  "Unable to find a compatible GPU. This issue might be because your computer doesn't have a GPU, or your system settings are not configured properly. " +
  'Please check if your device has a GPU properly set up and if your your browser supports WebGPU. ' +
  "You can also consult your browser's compatibility chart to see if it supports WebGPU. " +
  'For more information about WebGPU support in your browser, visit https://webgpureport.org/';

const STRIKES_KEY = 'eco-local-ai-fault-strikes-v1';
const COOLDOWNS_KEY = 'eco-local-ai-cooldowns-v1';

type LosableEngine = {
  engine: WebLLMEngine;
  /** Lose the device the way the browser does: `device.lost` resolves. */
  loseDevice(): Promise<void>;
  /** Engine calls made after the device was lost. */
  callsAfterLoss(): number;
};

/**
 * An engine whose device can be lost. Like WebLLM, it disposes its pipeline in
 * its own `device.lost` handler, registered before anyone else's, so every
 * later request throws DISPOSED. `reachableDevice: false` hides the device
 * from the adapter, as a library whose internals moved would.
 */
function makeLosableEngine(options: { reachableDevice: boolean }): LosableEngine {
  let resolveLost!: (info: { reason: string; message: string }) => void;
  const lost = new Promise<{ reason: string; message: string }>((resolve) => {
    resolveLost = resolve;
  });
  let disposed = false;
  let afterLoss = 0;
  void lost.then(() => {
    disposed = true;
  });
  const touch = (): void => {
    if (!disposed) return;
    afterLoss++;
    throw new Error(DISPOSED);
  };
  const pipeline = options.reachableDevice
    ? { tvm: { lib: { webGPUContext: { device: { lost } } } } }
    : {};
  const engine: WebLLMEngine = {
    reload: async () => undefined,
    loadedModelIdToPipeline: new Map<string, unknown>([[MLC_ID, pipeline]]),
    resetChat: async () => touch(),
    chat: {
      completions: {
        create: async () => {
          touch();
          return (async function* () {
            yield { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
            yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } };
          })();
        },
      },
    },
    interruptGenerate: () => undefined,
    unload: async () => undefined,
  };
  return {
    engine,
    loseDevice: async () => {
      resolveLost({ reason: 'unknown', message: 'GPU process was lost' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    callsAfterLoss: () => afterLoss,
  };
}

function engineWithNoAdapter(): WebLLMEngine {
  return {
    reload: async () => {
      throw new Error(NO_ADAPTER);
    },
    chat: { completions: { create: async () => { throw new Error('unreachable'); } } },
    interruptGenerate: () => undefined,
    resetChat: async () => undefined,
    unload: async () => undefined,
  };
}

/** Engines handed out in order, one per adapter load. */
function serveEngines(engines: WebLLMEngine[]): void {
  let next = 0;
  setAdapterFactory(
    () =>
      new WebLLMAdapter({
        engineFactory: async () => {
          const engine = engines[next++];
          if (!engine) throw new Error('test: no engine left');
          return engine;
        },
      }),
  );
}

/** One send: the reply text, or `CODE | message` for the error it threw. */
async function send(): Promise<string> {
  let text = '';
  try {
    for await (const event of stream([{ role: 'user', content: 'hello' }], MODEL.id)) {
      if (event.kind === 'token') text += event.text;
    }
    return `reply: ${text}`;
  } catch (err) {
    if (err instanceof LocalInferenceStreamError) return `${err.code} | ${err.message}`;
    return `thrown: ${String(err)}`;
  }
}

/** Let the fire-and-forget unload a failed generation schedules settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  window.localStorage.clear();
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  setSlot('eco-fast', MODEL);
  setSlotStatus('eco-fast', 'ready');
});

afterEach(() => {
  _resetLifecycleForTesting();
  __resetGpuOwnershipForTests();
  window.localStorage.clear();
});

describe('stream — a GPU device lost while the page was in the background', () => {
  it('routes every send to a page refresh when this page can no longer get an adapter (the phone sequence)', async () => {
    const first = makeLosableEngine({ reachableDevice: true });
    serveEngines([first.engine, engineWithNoAdapter(), engineWithNoAdapter(), engineWithNoAdapter()]);

    expect(await send()).toBe('reply: hi');
    await first.loseDevice();

    // The person's next message, then their Try again.
    const afterLock = await send();
    await settle();
    const tryAgain = await send();
    await settle();

    expect([afterLock, tryAgain]).toEqual([
      'GPU_RECONNECT | One moment — Eco is refreshing to pick up where you left off.',
      'GPU_RECONNECT | One moment — Eco is refreshing to pick up where you left off.',
    ]);
    expect(first.callsAfterLoss()).toBe(0);
    expect(window.localStorage.getItem(STRIKES_KEY)).toBeNull();
    expect(window.localStorage.getItem(COOLDOWNS_KEY)).toBeNull();
  });

  it('reloads the model quietly and answers when this page can still get an adapter', async () => {
    const first = makeLosableEngine({ reachableDevice: true });
    const second = makeLosableEngine({ reachableDevice: true });
    serveEngines([first.engine, second.engine]);

    expect(await send()).toBe('reply: hi');
    await first.loseDevice();

    expect(await send()).toBe('reply: hi');
    expect(first.callsAfterLoss()).toBe(0);
    expect(window.localStorage.getItem(STRIKES_KEY)).toBeNull();
    expect(window.localStorage.getItem(COOLDOWNS_KEY)).toBeNull();
  });

  it.each([
    ['the adapter sees the loss', true],
    ['the loss is only seen when the engine throws', false],
  ])(
    'two lock episodes in a row leave no strike and no cooldown, and the next send still loads (%s)',
    async (_label, reachableDevice) => {
      const engines = [
        makeLosableEngine({ reachableDevice }),
        makeLosableEngine({ reachableDevice }),
        makeLosableEngine({ reachableDevice }),
      ];
      serveEngines(engines.map((e) => e.engine));

      expect(await send()).toBe('reply: hi');
      for (const episode of [0, 1]) {
        await engines[episode]!.loseDevice();
        // A send that meets the disposed engine may fail once (when nothing
        // saw the loss beforehand); the one after it must load and answer.
        const next = await send();
        await settle();
        if (next !== 'reply: hi') expect(await send()).toBe('reply: hi');
        expect(window.localStorage.getItem(STRIKES_KEY)).toBeNull();
        expect(window.localStorage.getItem(COOLDOWNS_KEY)).toBeNull();
      }
    },
  );
});
