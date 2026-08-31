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

// ─── Edge cases ───────────────────────────────────────────────────────

describe('normalizeMessagesForTemplate — edge cases', () => {
  it('handles empty messages array', () => {
    expect(normalizeMessagesForTemplate([], 'native')).toEqual([]);
  });

  it('returns unchanged when no system messages', () => {
    const messages = [USER_MSG, ASSISTANT_MSG];
    const result = normalizeMessagesForTemplate(messages, 'native');
    expect(result).toEqual(messages);
  });

  it('does not mutate the input array', () => {
    const messages = [SYSTEM_MSG, USER_MSG, ASSISTANT_MSG];
    const original = [...messages];
    normalizeMessagesForTemplate(messages, 'native');
    expect(messages).toEqual(original);
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
