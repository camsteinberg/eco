// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it, vi } from 'vitest';
import type { ModelConfig } from '../../types';
import { longestCommonPrefixLen } from '../kv-cache';
import type { ChatMessage, GenerateOptions, TokenEvent } from '../types';
import { WebLLMAdapter } from '../webllm-adapter';
import {
  FakeMlcEngine,
  SEP_IDS,
  fullPrefillIds,
  type FakeEngineOptions,
} from './fixtures/fake-mlc-engine';

vi.mock('../webllm-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webllm-config')>();
  return {
    ...actual,
    webllmModelLibPathFor: () => '/webllm/v0_2_84/test-model-lib.wasm',
  };
});

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

const SYSTEM: ChatMessage = { role: 'system', content: 'Be brief.' };
const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

type DoneEvent = Extract<TokenEvent, { kind: 'done' }>;

async function setup(options?: FakeEngineOptions) {
  const engine = new FakeMlcEngine(options);
  const adapter = new WebLLMAdapter({ engineFactory: async () => engine });
  await adapter.load(MODEL);
  return { engine, pipeline: engine.pipeline, adapter };
}

async function turn(
  adapter: WebLLMAdapter,
  messages: ChatMessage[],
  options?: GenerateOptions,
): Promise<{ text: string; done: DoneEvent | undefined }> {
  let text = '';
  let done: DoneEvent | undefined;
  for await (const event of adapter.generate(messages, options)) {
    if (event.kind === 'token') text += event.text;
    if (event.kind === 'done') done = event;
  }
  return { text, done };
}

describe('WebLLM multi-turn KV reuse', () => {
  it('reuses the KV on the next turn and prefills the previous reply\'s separator', async () => {
    const { pipeline, adapter } = await setup();
    pipeline.queueReply('Paris.');
    const first = [SYSTEM, user('Capital of France?')];
    expect((await turn(adapter, first)).text).toBe('Paris.');

    pipeline.queueReply('Madrid.');
    const second = [...first, assistant('Paris.'), user('And Spain?')];
    await turn(adapter, second);

    const full = fullPrefillIds(second);
    // The model read exactly what a full prefill of the conversation feeds…
    expect(pipeline.kvAtFirstSample).toEqual(full);
    // …while only the new round was prefilled, opening with the separator that
    // closes the previous reply (never fed: the stop id is not forwarded).
    expect(pipeline.prefilled.length).toBeLessThan(full.length);
    expect(pipeline.prefilled.slice(0, SEP_IDS.length)).toEqual(SEP_IDS);
  });

  it('keeps reusing across later turns, and reports the full prompt length', async () => {
    const { engine, pipeline, adapter } = await setup();
    const first = [SYSTEM, user('Capital of France?')];
    pipeline.queueReply('Paris.');
    await turn(adapter, first);
    const heldAfterFirst = pipeline.kv.length;

    const second = [...first, assistant('Paris.'), user('And Spain?')];
    pipeline.queueReply('Madrid.');
    const { done } = await turn(adapter, second);
    const full = fullPrefillIds(second);
    // WebLLM's own count is the ids this prefill fed; the receipt's is the whole
    // prompt the model read.
    expect(pipeline.promptLen).toBeLessThan(full.length);
    expect(done?.promptTokens).toBe(full.length);
    expect(done?.kvReuse).toEqual({
      decision: 'reuse',
      cachedLen: heldAfterFirst,
      promptLen: full.length,
      cacheCommitted: true,
    });

    const third = [...second, assistant('Madrid.'), user('And Italy?')];
    pipeline.queueReply('Rome.');
    const third_ = await turn(adapter, third);
    expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(third));
    expect(third_.done?.kvReuse?.decision).toBe('reuse');
    // Only the first turn, with nothing cached, cleared the conversation.
    expect(engine.resetChatCalls).toBe(1);
  });

  it('resets a context difference the engine itself would have reused', async () => {
    // An engine whose compare ignores message text keeps its cache for an
    // edited history; the adapter's own check must not rely on it.
    const { engine, pipeline, adapter } = await setup({ contentBlindCompare: true });
    pipeline.queueReply('Paris.');
    await turn(adapter, [SYSTEM, user('Capital of France?')]);

    const edited = [SYSTEM, user('Capital of Italy?'), assistant('Paris.'), user('Sure?')];
    pipeline.queueReply('Rome.');
    const { done } = await turn(adapter, edited);
    expect(engine.resetChatCalls).toBe(2);
    expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(edited));
    expect(done?.kvReuse?.decision).toBe('miss');
    expect(done?.kvReuse?.reason).toBe('not-strict-prefix');
    expect(done?.kvReuse?.divergence?.cached).toContain('France');
    expect(done?.kvReuse?.divergence?.next).toContain('Italy');
  });

  it('re-reads a reply sampled in ids that re-encode differently, then reuses again', async () => {
    const { engine, pipeline, adapter } = await setup();
    const first = [SYSTEM, user('Capital of Germany?')];
    // Sampled one character at a time; the render encodes "in" as one id.
    pipeline.queueReply(Array.from('Berlin.', (c) => c.codePointAt(0)!));
    expect((await turn(adapter, first)).text).toBe('Berlin.');

    const second = [...first, assistant('Berlin.'), user('And Austria?')];
    pipeline.queueReply('Vienna.');
    const secondTurn = await turn(adapter, second);
    expect(engine.resetChatCalls).toBe(2);
    expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(second));
    expect(secondTurn.done?.kvReuse?.decision).toBe('miss');
    expect(secondTurn.done?.kvReuse?.reason).toBe('not-strict-prefix');

    const third = [...second, assistant('Vienna.'), user('And Hungary?')];
    pipeline.queueReply('Budapest.');
    const thirdTurn = await turn(adapter, third);
    expect(engine.resetChatCalls).toBe(2);
    expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(third));
    expect(thirdTurn.done?.kvReuse?.decision).toBe('reuse');
  });

  describe('lands on a full prefill', () => {
    async function afterTwoTurns() {
      const ctx = await setup();
      const first = [SYSTEM, user('Capital of France?')];
      ctx.pipeline.queueReply('Paris.');
      await turn(ctx.adapter, first);
      const second = [...first, assistant('Paris.'), user('And Spain?')];
      ctx.pipeline.queueReply('Madrid.');
      await turn(ctx.adapter, second);
      return { ...ctx, first, second };
    }

    it('after an edited earlier message', async () => {
      const { engine, pipeline, adapter } = await afterTwoTurns();
      const edited = [SYSTEM, user('Capital of Peru?'), assistant('Paris.'), user('And Spain?'), assistant('Madrid.'), user('Next?')];
      pipeline.queueReply('Lima.');
      const { done } = await turn(adapter, edited);
      expect(engine.resetChatCalls).toBe(2);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(edited));
      expect(done?.kvReuse?.reason).toBe('not-strict-prefix');
    });

    it('on a regenerate', async () => {
      const { engine, pipeline, adapter, second } = await afterTwoTurns();
      pipeline.queueReply('Madrid!');
      const { done } = await turn(adapter, second);
      expect(engine.resetChatCalls).toBe(2);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(second));
      expect(done?.kvReuse?.decision).toBe('miss');
    });

    it('when the history window slides past the oldest turn', async () => {
      const { engine, pipeline, adapter } = await afterTwoTurns();
      const slid = [SYSTEM, user('And Spain?'), assistant('Madrid.'), user('And Italy?')];
      pipeline.queueReply('Rome.');
      const { done } = await turn(adapter, slid);
      expect(engine.resetChatCalls).toBe(2);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(slid));
      // The held cache is longer than the slid render.
      expect(done?.kvReuse?.reason).toBe('equal-or-shorter');
    });

    it('after a model switch', async () => {
      const { adapter, second } = await afterTwoTurns();
      const next = new FakeMlcEngine();
      const switched = new WebLLMAdapter({ engineFactory: async () => next });
      await switched.load(MODEL);
      await adapter.unload();
      const third = [...second, assistant('Madrid.'), user('And Italy?')];
      next.pipeline.queueReply('Rome.');
      const { done } = await turn(switched, third);
      expect(next.pipeline.kvAtFirstSample).toEqual(fullPrefillIds(third));
      expect(done?.kvReuse).toMatchObject({ decision: 'miss', reason: 'no-cache', cachedLen: 0 });
    });

    it('when a forward the gate did not see leaves its count behind the engine\'s', async () => {
      const { engine, pipeline, adapter, second } = await afterTwoTurns();
      // Something forwarded one id past the gate's wrapper.
      pipeline.kv.push(7);
      pipeline.filledKVCacheLength += 1;
      const third = [...second, assistant('Madrid.'), user('And Italy?')];
      pipeline.queueReply('Rome.');
      const { done } = await turn(adapter, third);
      expect(engine.resetChatCalls).toBe(2);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(third));
      expect(done?.kvReuse?.reason).toBe('reset-before-prefill');
    });
  });

  describe('after a reply that stopped early', () => {
    async function abortedFirstTurn() {
      const ctx = await setup();
      const first = [SYSTEM, user('Capital of France?')];
      ctx.pipeline.queueReply('Paris, of course.');
      const controller = new AbortController();
      let partial = '';
      let tokens = 0;
      for await (const event of ctx.adapter.generate(first, { signal: controller.signal })) {
        if (event.kind !== 'token') continue;
        partial += event.text;
        if (++tokens === 2) controller.abort();
      }
      return { ...ctx, first, partial };
    }

    it('reuses exactly when the history carries the interrupted text', async () => {
      const { engine, pipeline, adapter, first, partial } = await abortedFirstTurn();
      expect(partial).toBe('Pa');
      const second = [...first, assistant(partial), user('And Spain?')];
      pipeline.queueReply('Madrid.');
      const { done } = await turn(adapter, second);
      expect(engine.resetChatCalls).toBe(1);
      // The last sampled id was never forwarded; the prefill feeds it, then the
      // separator, then the new round.
      expect(pipeline.prefilled.slice(0, 1 + SEP_IDS.length)).toEqual(['a'.codePointAt(0), ...SEP_IDS]);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(second));
      expect(done?.kvReuse?.decision).toBe('reuse');
    });

    it('resets through resetChat when the history carries other text', async () => {
      const { engine, pipeline, adapter, first } = await abortedFirstTurn();
      const second = [...first, assistant('Pa…'), user('And Spain?')];
      pipeline.queueReply('Madrid.');
      const { done } = await turn(adapter, second);
      expect(engine.resetChatCalls).toBe(2);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(second));
      expect(done?.kvReuse?.decision).toBe('miss');
    });

    it('reuses exactly after a length stop', async () => {
      const { pipeline, adapter } = await setup();
      const first = [SYSTEM, user('Capital of France?')];
      pipeline.queueReply('Paris.');
      const cut = await turn(adapter, first, { maxTokens: 3 });
      expect(cut.done?.finishReason).toBe('length');
      const second = [...first, assistant(cut.text), user('Go on.')];
      pipeline.queueReply('Paris.');
      const { done } = await turn(adapter, second);
      expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(second));
      expect(done?.kvReuse?.decision).toBe('reuse');
    });
  });

  it('defensively resets during prefill when the template rewrites an earlier reply', async () => {
    // A template that drops "~" from a reply once a later message follows is not
    // append-only: the cache matches the stored render, not the next one.
    const strip = '~';
    const { engine, pipeline, adapter } = await setup({ stripEarlierReplyPrefix: strip });
    const first = [SYSTEM, user('Capital of France?')];
    pipeline.queueReply('~Paris.');
    await turn(adapter, first);

    const second = [...first, assistant('~Paris.'), user('And Spain?')];
    pipeline.queueReply('Madrid.');
    const { done } = await turn(adapter, second);
    expect(engine.multiRound).toBe(true);
    expect(engine.resetChatCalls).toBe(1);
    expect(pipeline.kvAtFirstSample).toEqual(fullPrefillIds(second, strip));
    expect(done?.kvReuse?.decision).toBe('miss');
    expect(done?.kvReuse?.reason).toBe('reset-during-prefill');
    expect(done?.promptTokens).toBe(fullPrefillIds(second, strip).length);
  });

  it('penalises every id in the KV, the previous reply\'s generated ids included', async () => {
    const { pipeline, adapter } = await setup();
    const first = [SYSTEM, user('Name a word.')];
    pipeline.queueReply('Quiz.');
    await turn(adapter, first, { repetitionPenalty: 1.3 });

    const second = [...first, assistant('Quiz.'), user('Another?')];
    pipeline.queueReply('Jazz.');
    await turn(adapter, second, { repetitionPenalty: 1.3 });
    const kv = pipeline.kvAtFirstSample!;
    expect(pipeline.penalisedAtFirstSample).toEqual([...new Set(kv)].sort((a, b) => a - b));
    // 'Q' and 'z' appear only in the previous reply.
    expect(pipeline.penalisedAtFirstSample).toEqual(
      expect.arrayContaining(['Q'.codePointAt(0), 'z'.codePointAt(0)]),
    );
  });
});

describe('fake MLC engine (fixture check)', () => {
  it('reproduces the library hole: a raw multi-round turn leaves the separator out of the KV', async () => {
    const engine = new FakeMlcEngine();
    const first = [SYSTEM, user('Capital of France?')];
    engine.pipeline.queueReply('Paris.');
    for await (const _chunk of await engine.chat.completions.create({ messages: first })) {
      // drain
    }
    const second = [...first, assistant('Paris.'), user('And Spain?')];
    engine.pipeline.queueReply('Madrid.');
    for await (const _chunk of await engine.chat.completions.create({ messages: second })) {
      // drain
    }

    expect(engine.multiRound).toBe(true);
    const full = fullPrefillIds(second);
    const kv = engine.pipeline.kvAtFirstSample!;
    const at = longestCommonPrefixLen(kv, full);
    // The KV is the full render with exactly the separator missing at the end
    // of the previous reply.
    expect(full.slice(at, at + SEP_IDS.length)).toEqual(SEP_IDS);
    expect([...full.slice(0, at), ...full.slice(at + SEP_IDS.length)]).toEqual(kv);
  });
});
