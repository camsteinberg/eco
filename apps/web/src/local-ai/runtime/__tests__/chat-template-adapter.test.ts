// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  normalizeMessagesForTemplate,
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
