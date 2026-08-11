// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizeMessagesForTemplate,
  tokenizeRenderedTemplate,
  type ChatMessage,
  type SystemRoleSupport,
} from '../chat-template-adapter';

// ─── Fixtures ────────────────────────────────────────────────────────────

const SYSTEM_MSG: ChatMessage = { role: 'system', content: 'You are a helpful assistant.' };
const USER_MSG: ChatMessage = { role: 'user', content: 'Hello!' };
const ASSISTANT_MSG: ChatMessage = { role: 'assistant', content: 'Hi there.' };
const USER_MSG_2: ChatMessage = { role: 'user', content: 'How are you?' };

// ─── "native" strategy ──────────────────────────────────────────────────

describe('normalizeMessagesForTemplate — native', () => {
  const strategy: SystemRoleSupport = 'native';

  it('passes through messages unchanged', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual(messages);
  });

  it('returns same reference for native (no copy needed)', () => {
    const messages = [SYSTEM_MSG, USER_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toBe(messages);
  });

  it('handles empty array', () => {
    expect(normalizeMessagesForTemplate([], strategy)).toEqual([]);
  });

  it('handles messages with no system role', () => {
    const messages = [USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toBe(messages);
  });
});

// ─── "prepend-user" strategy ────────────────────────────────────────────

describe('normalizeMessagesForTemplate — prepend-user', () => {
  const strategy: SystemRoleSupport = 'prepend-user';

  it('converts a single system message to a user message at the front', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi there.' },
    ]);
  });

  it('concatenates multiple system messages with \\n\\n', () => {
    const sys1: ChatMessage = { role: 'system', content: 'Be concise.' };
    const sys2: ChatMessage = { role: 'system', content: 'Respond in English.' };
    const messages = [sys1, sys2, USER_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'Be concise.\n\nRespond in English.' },
      { role: 'user', content: 'Hello!' },
    ]);
  });

  it('returns unchanged when no system messages', () => {
    const messages = [USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual(messages);
  });

  it('handles system-only messages (no user/assistant)', () => {
    const messages = [SYSTEM_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.' },
    ]);
  });

  it('preserves non-system message order', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG, USER_MSG_2];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'How are you?' },
    ]);
  });

  it('handles system message interspersed between non-system messages', () => {
    const midSystem: ChatMessage = { role: 'system', content: 'Extra context.' };
    const messages = [SYSTEM_MSG, USER_MSG, midSystem, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.\n\nExtra context.' },
      { role: 'user', content: 'Hello!' },
      { role: 'assistant', content: 'Hi there.' },
    ]);
  });
});

// ─── "merge-first-user" strategy ────────────────────────────────────────

describe('normalizeMessagesForTemplate — merge-first-user', () => {
  const strategy: SystemRoleSupport = 'merge-first-user';

  it('merges system content into the first user message', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.\n\nHello!' },
      { role: 'assistant', content: 'Hi there.' },
    ]);
  });

  it('concatenates multiple system messages before merging', () => {
    const sys1: ChatMessage = { role: 'system', content: 'Be concise.' };
    const sys2: ChatMessage = { role: 'system', content: 'Respond in English.' };
    const messages = [sys1, sys2, USER_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'Be concise.\n\nRespond in English.\n\nHello!' },
    ]);
  });

  it('falls back to prepend-user when no user message follows system', () => {
    const messages = [SYSTEM_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.' },
      { role: 'assistant', content: 'Hi there.' },
    ]);
  });

  it('falls back to prepend-user when only system messages exist', () => {
    const messages = [SYSTEM_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.' },
    ]);
  });

  it('returns unchanged when no system messages', () => {
    const messages = [USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual(messages);
  });

  it('preserves non-system message order', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG, USER_MSG_2];
    const result = normalizeMessagesForTemplate(messages, strategy);
    expect(result).toEqual([
      { role: 'user', content: 'You are a helpful assistant.\n\nHello!' },
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'How are you?' },
    ]);
  });

  it('handles empty array', () => {
    expect(normalizeMessagesForTemplate([], strategy)).toEqual([]);
  });

  it('only merges into the FIRST user message, not subsequent ones', () => {
    const messages = [SYSTEM_MSG, ASSISTANT_MSG, USER_MSG, USER_MSG_2];
    const result = normalizeMessagesForTemplate(messages, strategy);
    // First user message in the non-system list is USER_MSG (index 1 after ASSISTANT_MSG)
    expect(result).toEqual([
      { role: 'assistant', content: 'Hi there.' },
      { role: 'user', content: 'You are a helpful assistant.\n\nHello!' },
      { role: 'user', content: 'How are you?' },
    ]);
  });
});

// ─── Edge cases across all strategies ───────────────────────────────────

describe('normalizeMessagesForTemplate — cross-strategy edge cases', () => {
  it.each<SystemRoleSupport>(['native', 'prepend-user', 'merge-first-user'])(
    'handles empty messages array for strategy=%s',
    (strategy) => {
      expect(normalizeMessagesForTemplate([], strategy)).toEqual([]);
    },
  );

  it.each<SystemRoleSupport>(['native', 'prepend-user', 'merge-first-user'])(
    'returns unchanged when no system messages for strategy=%s',
    (strategy) => {
      const messages = [USER_MSG, ASSISTANT_MSG];
      const result = normalizeMessagesForTemplate(messages, strategy);
      expect(result).toEqual(messages);
    },
  );

  it('does not mutate the input array', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG];
    const original = [...messages];
    normalizeMessagesForTemplate(messages, 'merge-first-user');
    expect(messages).toEqual(original);
  });

  it('does not mutate original message objects', () => {
    const user: ChatMessage = { role: 'user', content: 'Hello!' };
    const messages = [SYSTEM_MSG, user];
    normalizeMessagesForTemplate(messages, 'merge-first-user');
    expect(user.content).toBe('Hello!');
  });
});

// ─── tokenizeRenderedTemplate — the double-BOS guard ────────────────────────

describe('tokenizeRenderedTemplate', () => {
  const BOS = 1;

  /**
   * A tokenizer whose post-processor prepends BOS UNLESS add_special_tokens is
   * false — the behavior of LFM2.5's real tokenizer. The rendered template
   * string is assumed to already begin with its own BOS token (id 1), as
   * apply_chat_template({ tokenize: false }) produces.
   */
  function makeBosPrependingTokenizer() {
    const calls: Array<Record<string, unknown>> = [];
    const tokenizer = (_text: string, options: Record<string, unknown>) => {
      calls.push(options);
      const fromTemplate = [BOS, 6, 7]; // <bos>, <|im_start|>, …
      const ids = options.add_special_tokens === false ? fromTemplate : [BOS, ...fromTemplate];
      return Promise.resolve({ input_ids: ids });
    };
    return { tokenizer, calls };
  }

  it('passes add_special_tokens:false to the tokenizer', async () => {
    const { tokenizer, calls } = makeBosPrependingTokenizer();
    await tokenizeRenderedTemplate(tokenizer, '<bos><|im_start|>…', { return_tensor: 'pt' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.add_special_tokens).toBe(false);
  });

  it('preserves caller extraOptions alongside the forced flag', async () => {
    const { tokenizer, calls } = makeBosPrependingTokenizer();
    await tokenizeRenderedTemplate(tokenizer, '<bos>…', { return_tensor: 'pt' });
    expect(calls[0]!.return_tensor).toBe('pt');
    expect(calls[0]!.add_special_tokens).toBe(false);
  });

  it('never lets extraOptions override add_special_tokens back to true', async () => {
    const { tokenizer, calls } = makeBosPrependingTokenizer();
    await tokenizeRenderedTemplate(tokenizer, '<bos>…', { add_special_tokens: true });
    expect(calls[0]!.add_special_tokens).toBe(false);
  });

  it('does NOT double the BOS the template already emitted (the LFM2.5 bug)', async () => {
    const { tokenizer } = makeBosPrependingTokenizer();
    const out = (await tokenizeRenderedTemplate(tokenizer, '<bos><|im_start|>…', {
      return_tensor: 'pt',
    })) as { input_ids: number[] };
    // Single leading BOS — the fromTemplate sequence, not [BOS, BOS, …].
    expect(out.input_ids).toEqual([BOS, 6, 7]);
    expect(out.input_ids[0] === BOS && out.input_ids[1] === BOS).toBe(false);
  });

  it('contrast: the tokenizer WOULD double the BOS with the default add_special_tokens', async () => {
    const { tokenizer } = makeBosPrependingTokenizer();
    // Calling the raw tokenizer the way the pre-fix worker did (no override).
    const out = (await tokenizer('<bos><|im_start|>…', { return_tensor: 'pt' })) as {
      input_ids: number[];
    };
    expect(out.input_ids).toEqual([BOS, BOS, 6, 7]); // doubled — the defect the helper prevents
  });
});

// ─── Worker call-site guard ─────────────────────────────────────────────────
//
// The helper tests above verify tokenizeRenderedTemplate's contract in isolation,
// but the double-BOS fix only holds if the WORKER actually routes its
// rendered-prompt tokenization through it. The worker imports
// @huggingface/transformers and so can't be imported under vitest — this reads
// its SOURCE as text and asserts the wiring, so a future revert to a bare
// `tokenizer(inputText, …)` (which re-adds special tokens and doubles LFM2.5's
// BOS) fails CI instead of silently regressing.

describe('worker routes rendered-template tokenization through the double-BOS-safe helper', () => {
  // vitest runs the @eco/web package with cwd at apps/web (its package root).
  const workerSource = readFileSync(
    resolve(process.cwd(), 'src/workers/local-ai-transformers-worker.ts'),
    'utf8',
  );

  it('uses tokenizeRenderedTemplate for the rendered prompt', () => {
    expect(workerSource).toContain('tokenizeRenderedTemplate');
  });

  it('never re-tokenizes the rendered prompt with a bare tokenizer(inputText, …) call', () => {
    // The exact pre-fix defect pattern: `await tokenizer(inputText, { return_tensor: 'pt' })`
    // used the tokenizer's default add_special_tokens:true, doubling the BOS.
    expect(workerSource).not.toMatch(/\btokenizer\(\s*inputText\b/);
  });
});
