// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Regression: the WebLLM chat path counts history with the model's own
 * tokenizer, so a short chat keeps all of it.
 *
 * On a real iPhone 13 (2026-10-02, main b517036) a seven-turn chat on the
 * shipping 4-bit Qwen2.5-0.5B lost its first 8 messages at the sleep-tips turn
 * and all 12 at the summary turn, so "summarize what we talked about" got a
 * reply with nothing in it. The adapter's `countTokens` read a `tokenize` member
 * WebLLM 0.2.84 does not have, so it always returned null and the window fell
 * back to one token per character: a 4096 window minus the 2048 reply reserve
 * minus the 859-character system prompt left 1,189 "tokens" for a history of
 * 3,372 characters (667 real Qwen tokens).
 *
 * This drives the real path in miniature — `assemble()` builds the system prompt
 * and turns exactly as dispatch does, the real `WebLLMAdapter` is loaded on a
 * fake engine, and `selectWindow` is handed `adapter.countTokens` the way
 * `stream()` hands it. The fake pipeline tokenizer emits one id per THREE
 * characters, deliberately more than Qwen's real tokenizer does on this chat
 * (~5 characters per token), so "nothing is evicted" holds with margin rather
 * than by luck of the stand-in.
 *
 * The context and reserve are the two entries' values at b517036 (iPhone:
 * 4096 / ceiling 2048; desktop Safari's Qwen3-0.6B q0f16: 4096 / ceiling 512),
 * kept as literals so a deliberate catalog change does not fail a test about
 * counting.
 */

import { describe, expect, it } from 'vitest';
import { buildBranchRecaps } from '../../../lib/detail-recap';
import { getModel } from '../../catalog/catalog';
import { assemble } from '../../prompt/assemble';
import type { ModelConfig } from '../../types';
import type { ChatMessage } from '../types';
import { WebLLMAdapter, type WebLLMEngine } from '../webllm-adapter';
import { selectWindow } from '../window';

/** The chat as the phone stored it (exported by Eco), up to the summary turn. */
const TRANSCRIPT: ChatMessage[] = [
  { role: 'user', content: 'what’s a quarter of 200' },
  { role: 'assistant', content: 'A quarter of 200 is 75.' },
  { role: 'user', content: 'roughly how far is the moon from earth' },
  { role: 'assistant', content: 'The moon is approximately 384,400 kilometers away from Earth.' },
  { role: 'user', content: 'how many cups are in a gallon' },
  { role: 'assistant', content: '1 gal = 16 cup' },
  { role: 'user', content: 'tell me about vaccines in detail - how do they work?' },
  {
    role: 'assistant',
    content: [
      'Vaccines are designed to stimulate the immune system and protect individuals against specific diseases by introducing antigens into the body. They are typically administered through injections or oral administration.',
      '',
      'Injections involve placing tiny amounts of the vaccine directly into the muscle tissue. Oral administration involves taking the vaccine directly into the mouth and swallowing it.',
      '',
      'Vaccines are highly effective because they trigger the production of antibodies which are like a protective shield. This helps the immune system recognize and fight off foreign substances such as bacteria, viruses, parasites, etc.',
      '',
      'Also, vaccines are generally well-tolerated by most people, but some people may experience mild side effects such as redness at injection site, fever, chills, headache, fatigue, etc.',
      '',
      'It\'s important to note that not all vaccines work for everyone, and there are different types depending on the disease being protected against (e.g., mRNA-based vaccines vs. traditional vaccines). It\'s also crucial to discuss any health concerns before receiving a vaccine with your healthcare provider.',
    ].join('\n'),
  },
  { role: 'user', content: 'write a short email declining a meeting invitation for friday' },
  {
    role: 'assistant',
    content: [
      'Dear [Recipient],',
      'I am writing to inform you of my decision regarding our upcoming Friday meeting. I regret to inform you that we will not be able to meet on Friday due to unforeseen circumstances.',
      'Thank you for your understanding and consideration.',
      'Sincerely,',
      '[Your Name]',
    ].join('\n'),
  },
  { role: 'user', content: 'give me some tips for better sleep' },
  {
    role: 'assistant',
    content: [
      '1. Create a comfortable sleeping environment: Make sure your bedroom is quiet, dark, and cool. Avoid using electronic devices like computers, phones, tablets, etc.',
      '',
      '2. Exercise regularly: Regular exercise can improve your sleep quality by reducing stress levels, lowering heart rate, and releasing endorphins which can lead to relaxation.',
      '',
      '3. Practice meditation: Meditative exercises such as mindfulness, yoga, and deep-breathing exercises can help you relax and fall asleep faster.',
      '',
      '4. Drink plenty of fluids: Drinking water, herbal tea, and other fluids can keep you hydrated and may also enhance your sleep quality.',
      '',
      '5. Reduce screen time: Limit your exposure to screens like TVs, laptops, smartphones, etc. as these can contribute to decreased sleep quality.',
      '',
      '6. Go to bed earlier: Try going to bed earlier at night to allow your body to wind down before bedtime.',
      '',
      '7. Eat healthy meals: Eating nutritious food like fruits, vegetables, lean proteins, and whole grains can help regulate your sleep pattern.',
      '',
      '8. Maintain a regular routine: Try maintaining a regular routine by practicing certain activities every day such as reading a book, listening to calming music, or engaging in hobbies.',
      '',
      '9. Stay away from caffeine and alcohol: Reducing caffeine intake (such as coffee) and alcohol consumption can affect your sleep quality.',
      '',
      '10. Get enough sunlight: Exposure to sunlight during the day can increase melatonin production and promote better sleep quality.',
      '',
      'Remember, finding the right balance between work and life is important for optimal sleep quality. It\'s important to find a rhythm that works best for you.',
    ].join('\n'),
  },
  { role: 'user', content: 'summarize what we talked about' },
];

/** Store index of "how many cups are in a gallon": the unit tool answered, no generation ran. */
const UNIT_TOOL_TURN = 4;

/** Store indices of the user turns that reached the model (turns 1, 2, 4, 5, 6, 7). */
const GENERATED_TURNS = TRANSCRIPT.flatMap((m, i) =>
  m.role === 'user' && i !== UNIT_TOOL_TURN ? [i] : [],
);

/** One token id per three characters (see the header). */
const threeCharsPerToken = (text: string): Int32Array =>
  new Int32Array(Math.ceil(text.length / 3));

function catalogModel(id: string): ModelConfig {
  const model = getModel(id);
  if (!model) throw new Error(`catalog entry ${id} is missing`);
  return model;
}

/**
 * A loaded adapter on a fake engine. With `tokenizer`, the engine holds a
 * pipeline for the loaded model the way WebLLM 0.2.84's `MLCEngine` does;
 * without one, no pipeline is reachable and `countTokens` returns null.
 */
async function loadedAdapter(
  model: ModelConfig,
  tokenizer?: (text: string) => Int32Array,
): Promise<WebLLMAdapter> {
  const adapter = new WebLLMAdapter({
    engineFactory: async ({ modelId }): Promise<WebLLMEngine> => ({
      reload: async () => undefined,
      resetChat: async () => undefined,
      chat: { completions: { create: async () => (async function* () {})() } },
      interruptGenerate: () => undefined,
      unload: async () => undefined,
      ...(tokenizer
        ? {
            loadedModelIdToPipeline: new Map<string, unknown>([
              [
                modelId,
                {
                  tokenizer: { encode: tokenizer },
                  conversation: { config: {}, getPromptArray: () => [] },
                  config: {},
                  logitProcessor: undefined,
                },
              ],
            ]),
          }
        : {}),
    }),
  });
  await adapter.load(model);
  return adapter;
}

/** Messages evicted at each generated turn, and which counter chose each window. */
async function evictionsPerTurn(
  adapter: WebLLMAdapter,
  modelId: string,
  contextTokens: number,
  reserve: number,
): Promise<{ evicted: number[]; countedWithTokenizer: boolean[] }> {
  const evicted: number[] = [];
  const countedWithTokenizer: boolean[] = [];
  const countTokens = adapter.countTokens.bind(adapter);
  for (const index of GENERATED_TURNS) {
    const branch = TRANSCRIPT.slice(0, index + 1);
    const plan = assemble({
      modelId,
      messages: branch,
      branchRecaps: buildBranchRecaps(branch),
      customInstructions: '',
    });
    const selection = await selectWindow(plan.messages, {
      contextTokens,
      maxNewTokens: reserve,
      countTokens,
    });
    // The system turn is index 0, so the first kept message's index minus one
    // is how many conversation messages were evicted.
    evicted.push(selection.windowStartIndex - 1);
    countedWithTokenizer.push(selection.countedWithTokenizer);
  }
  return { evicted, countedWithTokenizer };
}

const ENTRIES = [
  {
    name: 'iPhone, Qwen2.5-0.5B 4-bit',
    modelId: 'candidate/qwen2.5-0.5b-mlc',
    contextTokens: 4096,
    reserve: 2048,
    // What the phone showed: 8 gone at the sleep-tips turn, 12 at the summary.
    evictedOnTheBound: [0, 0, 0, 8, 8, 12],
  },
  {
    name: 'desktop Safari, Qwen3-0.6B q0f16',
    modelId: 'candidate/qwen3-0.6b-mlc-q0f16',
    contextTokens: 4096,
    reserve: 512,
    evictedOnTheBound: [0, 0, 0, 0, 0, 10],
  },
] as const;

describe.each(ENTRIES)('the real-iPhone seven-turn chat on $name', (entry) => {
  it('evicts nothing through turn 7 when the adapter counts with the model tokenizer', async () => {
    const adapter = await loadedAdapter(catalogModel(entry.modelId), threeCharsPerToken);
    const result = await evictionsPerTurn(adapter, entry.modelId, entry.contextTokens, entry.reserve);
    expect(result.evicted).toEqual(GENERATED_TURNS.map(() => 0));
    expect(result.countedWithTokenizer).toEqual(GENERATED_TURNS.map(() => true));
  });

  it('reproduces the defect when no tokenizer is reachable (the one-per-character bound)', async () => {
    const adapter = await loadedAdapter(catalogModel(entry.modelId));
    const result = await evictionsPerTurn(adapter, entry.modelId, entry.contextTokens, entry.reserve);
    expect(result.evicted).toEqual(entry.evictedOnTheBound);
    expect(result.countedWithTokenizer).toEqual(GENERATED_TURNS.map(() => false));
  });
});
