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
