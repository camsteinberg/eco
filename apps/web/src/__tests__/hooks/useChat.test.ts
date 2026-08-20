// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest';

const conversationStoreMock = vi.hoisted(() => ({
  state: {
    activeConversationId: 'conv-123' as string | null,
    saveMessage: vi.fn(),
    updateConversation: vi.fn(),
  },
}));

vi.mock('../../lib/local-models', () => ({
  isLocalModel: (id: string) => id.startsWith('local/'),
  LOCAL_MODELS: [],
  DEFAULT_LOCAL_MODEL: { id: 'local/smollm3-3b' },
  getLaunchLocalModels: () => [
    { id: 'local/qwen3-0.6b', tier: 'quick', qualityTier: 'quick' },
    { id: 'local/smollm3-3b', tier: 'full', qualityTier: 'full' },
  ],
  getRoutableLocalModels: () => [
    { id: 'local/qwen3-0.6b', tier: 'quick', qualityTier: 'quick' },
    { id: 'local/smollm3-3b', tier: 'full', qualityTier: 'full' },
  ],
  getLocalModel: (id: string) =>
    id === 'local/qwen3-0.6b' || id === 'local/smollm3-3b'
      ? { id }
      : undefined,
  getLocalModelTechnicalName: (model: { id: string }) =>
    model.id === 'local/qwen3-0.6b' ? 'Qwen3 0.6B' : model.id,
  getLocalModelContextLength: () => 4096,
  getLocalModelUserFacingSurfaceBlockers: () => [],
  getQuickModel: () => undefined,
  getFullModel: () => undefined,
  getDownloadableModels: () => [],
}));

vi.mock('../../lib/local-model-state-matrix', () => ({
  getLocalModelStateMatrixRow: (modelId: string) => ({
    modelId,
    productState: 'manual-eligible',
    runtimeCapability: { contractReady: true },
  }),
}));

vi.mock('../../lib/system-prompt', () => ({
  getOnDeviceSystemPrompt: (_modelId: string) => 'You are Eco (on-device).',
}));

vi.mock('../../stores/conversationStore', () => ({
  useConversationStore: Object.assign(
    (selector?: (state: typeof conversationStoreMock.state) => unknown) =>
      selector ? selector(conversationStoreMock.state) : conversationStoreMock.state,
    {
      getState: () => conversationStoreMock.state,
    },
  ),
}));

import {
  buildChatRouteRecommendationSnapshot,
  buildSystemPrompt,
  createTokenBatcher,
  createGeneration,
  interruptActiveGeneration,
  setActiveGenerationForTesting,
} from '../../hooks/useChat';
import { persistConversationMessagesSnapshot } from '../../lib/chat-persistence';
import { buildLocalReadinessFailure } from '../../lib/chat-turns';
import { useChatStore } from '../../stores/chatStore';

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('returns the on-device identity prompt for local/* models', () => {
    const prompt = buildSystemPrompt('local/smollm3-3b', '');
    expect(prompt).toContain('You are Eco');
    expect(prompt).not.toContain('network');
  });

  it('treats eco-fast slot as on-device', () => {
    const prompt = buildSystemPrompt('eco-fast', '');
    expect(prompt).toContain('You are Eco');
    expect(prompt).not.toContain('network');
  });

  it('includes custom instructions when present', () => {
    const prompt = buildSystemPrompt('eco-fast', 'Be concise.');
    expect(prompt).toContain('Be concise.');
  });

  it('trims custom instructions', () => {
    const prompt = buildSystemPrompt('eco-fast', '  spaces  ');
    expect(prompt).toContain('spaces');
  });

  it('never injects user memories into the on-device prompt', () => {
    const prompt = buildSystemPrompt('local/qwen3-0.6b', 'Be concise.');
    expect(prompt).not.toContain('What you know about the user');
  });

  it('never injects a memory-extraction instruction', () => {
    const prompt = buildSystemPrompt('eco-fast', '');
    expect(prompt).not.toContain('<memory_instruction>');
  });
});

// ---------------------------------------------------------------------------
// createTokenBatcher
// ---------------------------------------------------------------------------

describe('createTokenBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('paints the first emission for a fresh msgId immediately (unmetered first paint)', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    // The metered drain carves out the FIRST emission per msgId so TTFT is
    // never taxed: the first token flushes synchronously, in full, no RAF.
    batcher.append('msg-1', 'Hello');
    expect(append).toHaveBeenCalledTimes(1);
    // 5th arg = tokenDelta: this emit carried 1 stream token.
    expect(append).toHaveBeenCalledWith('msg-1', 'Hello', undefined, 1, 1);
  });

  it('flushSync delivers all buffered tokens', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    // First token paints immediately (seq 1); the second is buffered and
    // released by flushSync (seq 2).
    batcher.append('msg-1', 'Hello');
    batcher.append('msg-1', ' world');
    batcher.flushSync();

    expect(append).toHaveBeenCalledTimes(2);
    // tokenDelta (5th arg): first paint carried 1 token, flush carried the 2nd.
    expect(append).toHaveBeenNthCalledWith(1, 'msg-1', 'Hello', undefined, 1, 1);
    expect(append).toHaveBeenNthCalledWith(2, 'msg-1', ' world', undefined, 2, 1);
  });

  it('handles rapid sequential appends (first paints, rest concatenated in one flush)', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    // 'A' is the immediate first paint; 'B'+'C' buffer and drain together.
    batcher.append('msg-1', 'A');
    batcher.append('msg-1', 'B');
    batcher.append('msg-1', 'C');
    batcher.flushSync();

    expect(append).toHaveBeenCalledTimes(2);
    // tokenDelta: first paint carried token 'A' (1); the flush of 'BC' carried
    // BOTH buffered tokens (2) — so the summed delta equals the true 3 tokens.
    expect(append).toHaveBeenNthCalledWith(1, 'msg-1', 'A', undefined, 1, 1);
    expect(append).toHaveBeenNthCalledWith(2, 'msg-1', 'BC', undefined, 2, 2);
  });

  it('no-op flush when buffer is empty', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    batcher.flushSync();
    expect(append).not.toHaveBeenCalled();
  });

  it('flushes a post-first-paint token via the metered rAF drain', () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    // First token paints immediately (seq 1), no frame queued.
    batcher.append('msg-1', 'first ');
    expect(rafCallbacks).toHaveLength(0);
    expect(append).toHaveBeenNthCalledWith(1, 'msg-1', 'first ', undefined, 1, 1);

    // A post-first-paint token is metered: it queues a frame. We fire the frame
    // (a partial metered slice) then flushSync the remainder, and assert the
    // post-first-paint content arrives intact with strictly increasing seq.
    batcher.append('msg-1', 'token');
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks[0]!(16);
    batcher.flushSync();

    const metered = append.mock.calls.slice(1); // drop the seq-1 first paint
    expect(metered.map((c) => c[1]).join('')).toBe('token');
    const seqs = append.mock.calls.map((c) => c[3]);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }

    vi.unstubAllGlobals();
  });

  it('multiple flushSync calls are safe', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    batcher.append('msg-1', 'data');
    batcher.flushSync();
    batcher.flushSync(); // second flush should be no-op

    expect(append).toHaveBeenCalledTimes(1);
  });

  it('passes generationId when set', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    batcher.setGenerationId('gen-42');
    batcher.append('msg-1', 'hello');
    batcher.flushSync();

    expect(append).toHaveBeenCalledWith('msg-1', 'hello', 'gen-42', 1, 1);
  });

  it('increments seq across multiple flushes', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    batcher.setGenerationId('gen-42');
    batcher.append('msg-1', 'A');
    batcher.flushSync();
    batcher.append('msg-1', 'B');
    batcher.flushSync();

    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, 'msg-1', 'A', 'gen-42', 1, 1);
    expect(append).toHaveBeenNthCalledWith(2, 'msg-1', 'B', 'gen-42', 2, 1);
  });

  it('resetSeq resets the counter', () => {
    const append = vi.fn();
    const batcher = createTokenBatcher(append);

    batcher.setGenerationId('gen-42');
    batcher.append('msg-1', 'A');
    batcher.flushSync();
    batcher.resetSeq();
    batcher.append('msg-1', 'B');
    batcher.flushSync();

    expect(append).toHaveBeenNthCalledWith(1, 'msg-1', 'A', 'gen-42', 1, 1);
    expect(append).toHaveBeenNthCalledWith(2, 'msg-1', 'B', 'gen-42', 1, 1);
  });
});

describe('interruptActiveGeneration', () => {
  beforeEach(() => {
    conversationStoreMock.state.activeConversationId = 'conv-123';
    conversationStoreMock.state.saveMessage.mockReset();
    conversationStoreMock.state.updateConversation.mockReset();
    setActiveGenerationForTesting(null);
    useChatStore.setState({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Hello',
          createdAt: 1,
          parentId: null,
          status: 'complete',
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Partial',
          createdAt: 2,
          parentId: 'user-1',
          status: 'streaming',
        },
      ],
      streamPhase: 'generating',
      isStreaming: true,
    });
  });

  it('flushes pending tokens and persists the interrupted branch snapshot', () => {
    // A real generation whose batcher holds an unflushed token. The
    // interrupt's `batcher.flushSync()` is what appends it to the store.
    const generation = createGeneration(useChatStore.getState().appendToMessage);
    const flushSpy = vi.spyOn(generation.batcher, 'flushSync');
    generation.batcher.append('assistant-1', ' answer');
    setActiveGenerationForTesting(generation);

    interruptActiveGeneration();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().messages.find((message) => message.id === 'assistant-1')).toMatchObject({
      content: 'Partial answer',
      status: 'complete',
      streamInterrupted: true,
    });
    expect(useChatStore.getState().isStreaming).toBe(false);
    expect(conversationStoreMock.state.saveMessage).toHaveBeenCalledTimes(2);
    expect(conversationStoreMock.state.saveMessage.mock.calls[1]?.[0]).toMatchObject({
      id: 'assistant-1',
      content: 'Partial answer',
      streamInterrupted: true,
    });
    expect(conversationStoreMock.state.updateConversation).toHaveBeenCalledWith('conv-123', {
      activeLeafId: 'assistant-1',
    });
  });

  it('can stop without flushing buffered tokens so explicit stop keeps only the visible partial', () => {
    const generation = createGeneration(useChatStore.getState().appendToMessage);
    const flushSpy = vi.spyOn(generation.batcher, 'flushSync');
    // First token paints immediately (immediate-first-paint) → it becomes part
    // of the visible partial. A second token is buffered behind the metered
    // drain and has NOT been painted yet.
    generation.batcher.append('assistant-1', ' first');
    generation.batcher.append('assistant-1', ' buffered');
    setActiveGenerationForTesting(generation);

    interruptActiveGeneration({ flushPendingTokens: false });

    // No flushSync, so the still-buffered ' buffered' is dropped; only the
    // already-visible 'Partial first' survives.
    expect(flushSpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().messages.find((message) => message.id === 'assistant-1')).toMatchObject({
      content: 'Partial first',
      status: 'complete',
      streamInterrupted: true,
    });
    expect(conversationStoreMock.state.saveMessage.mock.calls[1]?.[0]).toMatchObject({
      id: 'assistant-1',
      content: 'Partial first',
      streamInterrupted: true,
    });
  });
});

describe('chat helper seams', () => {
  it('builds prompt-aware local route recommendation snapshots without changing the selected route', () => {
    const quick = buildChatRouteRecommendationSnapshot({
      prompt: 'hi',
      selectedModel: 'eco-fast',
      researchMode: false,
    });
    const code = buildChatRouteRecommendationSnapshot({
      prompt: 'Fix this TypeScript component bug',
      selectedModel: 'eco-fast',
      researchMode: false,
    });
    const file = buildChatRouteRecommendationSnapshot({
      prompt: 'Summarize this',
      selectedModel: 'eco-fast',
      researchMode: false,
      fileAttachments: [
        {
          id: 'file-1',
          file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
          status: 'done',
        },
      ],
    });
    const research = buildChatRouteRecommendationSnapshot({
      prompt: 'What changed this week?',
      selectedModel: 'eco-fast',
      researchMode: true,
    });
    const longInput = buildChatRouteRecommendationSnapshot({
      prompt: 'A'.repeat(400),
      selectedModel: 'eco-fast',
      researchMode: false,
    });

    expect(quick.taskIntent).toBe('quick');
    expect(code.taskIntent).toBe('code');
    expect(file.taskIntent).toBe('file');
    expect(research.taskIntent).toBe('research');
    expect(longInput.taskIntent).toBe('deep');
    expect(code.selectedModel).toBe('eco-fast');
    expect(code.resolvedSelectedModel).toBe('eco-fast');
    expect(code.preservesUserChoice).toBe(true);
    // v1 shape: v1Slot replaces the legacy recommendations map (OQ-1)
    expect(code.v1Slot).toBeDefined();
    expect(code.v1Slot.slot).toBe('eco-fast');
    expect(research.v1Slot).toBeDefined();
    expect(research.v1Slot.slot).toBe('eco-fast');
  });

  it('builds local readiness recovery copy and metadata, unified as Eco', () => {
    const failure = buildLocalReadinessFailure({
      selectedModelChoice: 'eco-fast',
      model: 'local/qwen3-0.6b',
      lifecycleStatus: 'partial',
    });

    expect(failure).toMatchObject({
      message: expect.stringContaining('Eco is only partly downloaded'),
      // The branded display name, not the raw catalog name — recovery copy
      // names models the same way every choice surface does.
      modelName: 'Eco Compact (Qwen)',
      slotId: 'eco-fast',
      slotLabel: 'Eco',
      readinessStatus: 'partial',
    });
  });

  it('persists every visible message and records the active leaf', () => {
    const conversationStore = {
      saveMessage: vi.fn(),
      updateConversation: vi.fn(),
    };
    const messages = [
      {
        id: 'user-1',
        role: 'user' as const,
        content: 'Hello',
        createdAt: 1,
        parentId: null,
        status: 'complete' as const,
      },
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        content: 'Hi',
        createdAt: 2,
        parentId: 'user-1',
        status: 'complete' as const,
      },
    ];

    persistConversationMessagesSnapshot({
      conversationId: 'conv-123',
      messages,
      conversationStore,
    });

    expect(conversationStore.saveMessage).toHaveBeenCalledTimes(2);
    expect(conversationStore.updateConversation).toHaveBeenCalledWith('conv-123', {
      activeLeafId: 'assistant-1',
    });
  });
});
