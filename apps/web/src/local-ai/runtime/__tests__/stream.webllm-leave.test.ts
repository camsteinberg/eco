// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A reply the chat stops reading part-way, without a Stop.
 *
 * WebLLM 0.2.84 releases its per-model request lock only after a stream's last
 * chunk, so a stream nobody reads holds it. When the consumer leaves (a `break`
 * out of `for await`), its `return()` must travel down every layer to the
 * WebLLM adapter's `finally`, which hands the open stream to
 * `finishOpenStream` — the read that interrupts it and frees the lock. No layer
 * is a native async generator (see `async-stream.ts`), so each one forwards
 * that `return()` by hand; this checks the whole chain does.
 *
 * Real path: stream() → runtime lifecycle → WebLLMAdapter → a fake engine that
 * holds the lock the way WebLLM does. Only bootstrap is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../bootstrap', () => ({ bootstrapLocalAi: vi.fn(async () => undefined) }));

import { stream } from '../stream';
import { _resetLifecycleForTesting, setAdapterFactory } from '../lifecycle';
import { __resetGpuOwnershipForTests } from '../gpu-ownership';
import { WebLLMAdapter, type WebLLMChunk, type WebLLMEngine } from '../webllm-adapter';
import { LocalInferenceStreamError } from '../errors';
import { getModel } from '../../catalog/catalog';
import { setSlot, setSlotStatus } from '../../lifecycle/slots';
import { VALIDATION_GENERATION_FAULT_MESSAGE } from '../../../lib/validation-harness';

// The shipping iPhone model — a real catalog entry, so the slot store resolves it.
const MODEL = getModel('candidate/qwen2.5-0.5b-mlc')!;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

/**
 * `create()` takes the lock; the stream releases it after its last chunk, not
 * in a `finally`, and ends at the next decode step once interrupted.
 */
function makeLockingEngine(): { engine: WebLLMEngine; locked: () => boolean; interrupts: () => number } {
  let locked = false;
  let interrupt = false;
  let interrupts = 0;
  const engine: WebLLMEngine = {
    reload: async () => undefined,
    resetChat: async () => undefined,
    chat: {
      completions: {
        create: async () => {
          locked = true;
          return (async function* (): AsyncGenerator<WebLLMChunk> {
            interrupt = false;
            await tick(); // prefill
            for (let i = 0; i < 10_000; i++) {
              if (interrupt) break;
              await tick();
              yield { choices: [{ delta: { content: ` t${i}` } }] };
            }
            yield { choices: [{ delta: {}, finish_reason: interrupt ? 'abort' : 'length' }] };
            yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } };
            locked = false;
          })();
        },
      },
    },
    interruptGenerate: () => {
      interrupt = true;
      interrupts++;
    },
    unload: async () => undefined,
  };
  return { engine, locked: () => locked, interrupts: () => interrupts };
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

describe('stream — a consumer that leaves a WebLLM reply part-way', () => {
  it("reaches the adapter's finally through the lifecycle, which frees the engine's lock", async () => {
    const fake = makeLockingEngine();
    setAdapterFactory(() => new WebLLMAdapter({ engineFactory: async () => fake.engine }));

    let tokens = 0;
    for await (const event of stream([{ role: 'user', content: 'hello' }], MODEL.id)) {
      if (event.kind === 'token' && ++tokens === 2) break;
    }

    // Nothing reads the reply any more, and no other reply starts: only the
    // adapter's `finally` can finish the stream now.
    await vi.waitFor(() => expect(fake.locked()).toBe(false), { timeout: 1000 });
    expect(fake.interrupts()).toBeGreaterThan(0);
  });

  it('does the same when the reply fails part-way, and the failure keeps its own error', async () => {
    const fake = makeLockingEngine();
    setAdapterFactory(() => new WebLLMAdapter({ engineFactory: async () => fake.engine }));
    // The harness's mid-reply fault: stream() throws after the first word.
    window.localStorage.setItem('eco-force-generation-fault', 'mid-reply');

    let failure: unknown = null;
    try {
      for await (const event of stream([{ role: 'user', content: 'hello' }], MODEL.id)) {
        void event;
      }
    } catch (err) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(LocalInferenceStreamError);
    expect(failure).toMatchObject({
      code: 'LOCAL_INFERENCE_FAILED',
      message: VALIDATION_GENERATION_FAULT_MESSAGE,
    });
    // The throw closed every layer before it reached the consumer.
    await vi.waitFor(() => expect(fake.locked()).toBe(false), { timeout: 1000 });
    expect(fake.interrupts()).toBeGreaterThan(0);
  });
});
