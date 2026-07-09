// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chatStore';

describe('ChatMessage inferenceMethod field', () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
  });

  it('adding a message does NOT set inferenceMethod (undefined by default)', () => {
    const id = useChatStore.getState().addMessage({ role: 'user', content: 'Hello' });
    const msg = useChatStore.getState().messages.find((m) => m.id === id);
    expect(msg).toBeDefined();
    expect(msg!.inferenceMethod).toBeUndefined();
  });

  it('updateMessage with inferenceMethod: local sets the field', () => {
    const id = useChatStore.getState().addMessage({ role: 'assistant', content: 'Hi' });
    useChatStore.getState().updateMessage(id, { inferenceMethod: 'local' });
    const msg = useChatStore.getState().messages.find((m) => m.id === id);
    expect(msg!.inferenceMethod).toBe('local');
  });

  it('updateMessage with inferenceMethod: remote sets the field', () => {
    const id = useChatStore.getState().addMessage({ role: 'assistant', content: 'Hi' });
    useChatStore.getState().updateMessage(id, { inferenceMethod: 'remote' });
    const msg = useChatStore.getState().messages.find((m) => m.id === id);
    expect(msg!.inferenceMethod).toBe('remote');
  });

  it('existing updateMessage fields work alongside inferenceMethod', () => {
    const id = useChatStore.getState().addMessage({ role: 'assistant', content: 'Hi' });
    useChatStore.getState().updateMessage(id, {
      status: 'complete',
      inferenceMethod: 'local',
      resolvedModel: 'local/smollm3-3b',
    });
    const msg = useChatStore.getState().messages.find((m) => m.id === id);
    expect(msg!.status).toBe('complete');
    expect(msg!.inferenceMethod).toBe('local');
    expect(msg!.resolvedModel).toBe('local/smollm3-3b');
  });
});
