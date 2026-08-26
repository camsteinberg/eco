// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock BroadcastChannel — a shared registry that delivers a posted message to
// every OTHER instance on the same channel name (never back to the sender),
// matching the real API's cross-context, no-self-echo semantics.
// ---------------------------------------------------------------------------

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name && !inst.closed && inst.onmessage) {
        inst.onmessage({ data });
      }
    }
  }

  close(): void {
    this.closed = true;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }
}

async function loadModule() {
  return import('../conversation-sync');
}

const CHANNEL_NAME = 'eco-conversation-sync';

beforeEach(() => {
  MockBroadcastChannel.instances = [];
  vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
});

afterEach(async () => {
  const mod = await loadModule();
  mod.__resetConversationSyncForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('conversation-sync', () => {
  it('delivers another tab’s update to a subscriber', async () => {
    const { subscribeConversationUpdates } = await loadModule();
    const received: unknown[] = [];
    subscribeConversationUpdates((m) => received.push(m));

    // Simulate the OTHER tab broadcasting.
    const otherTab = new MockBroadcastChannel(CHANNEL_NAME);
    otherTab.postMessage({ type: 'conversation-updated', conversationId: 'c1', leafId: 'leaf-9' });

    expect(received).toEqual([{ type: 'conversation-updated', conversationId: 'c1', leafId: 'leaf-9' }]);
  });

  it('broadcasts this tab’s update to other tabs', async () => {
    const { broadcastConversationUpdate, subscribeConversationUpdates } = await loadModule();
    // Ensure this tab's channel exists.
    subscribeConversationUpdates(() => {});

    const otherTab = new MockBroadcastChannel(CHANNEL_NAME);
    const seen: unknown[] = [];
    otherTab.onmessage = (e) => seen.push(e.data);

    broadcastConversationUpdate('c2', 'leaf-42');

    expect(seen).toEqual([{ type: 'conversation-updated', conversationId: 'c2', leafId: 'leaf-42' }]);
  });

  it('never delivers a tab its own broadcast (no self-echo)', async () => {
    const { broadcastConversationUpdate, subscribeConversationUpdates } = await loadModule();
    const received: unknown[] = [];
    subscribeConversationUpdates((m) => received.push(m));

    broadcastConversationUpdate('c3', 'leaf-1');

    expect(received).toEqual([]);
  });

  it('ignores malformed messages', async () => {
    const { subscribeConversationUpdates } = await loadModule();
    const received: unknown[] = [];
    subscribeConversationUpdates((m) => received.push(m));

    const otherTab = new MockBroadcastChannel(CHANNEL_NAME);
    otherTab.postMessage({ type: 'something-else' });
    otherTab.postMessage({ conversationId: 42 });
    otherTab.postMessage(null);

    expect(received).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const { subscribeConversationUpdates } = await loadModule();
    const received: unknown[] = [];
    const unsubscribe = subscribeConversationUpdates((m) => received.push(m));

    const otherTab = new MockBroadcastChannel(CHANNEL_NAME);
    otherTab.postMessage({ type: 'conversation-updated', conversationId: 'c1', leafId: 'a' });
    unsubscribe();
    otherTab.postMessage({ type: 'conversation-updated', conversationId: 'c1', leafId: 'b' });

    expect(received).toHaveLength(1);
  });

  it('is a safe no-op when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { broadcastConversationUpdate, subscribeConversationUpdates, isConversationSyncActive } =
      await loadModule();

    const received: unknown[] = [];
    const unsubscribe = subscribeConversationUpdates((m) => received.push(m));
    // Must not throw.
    expect(() => broadcastConversationUpdate('c1', 'leaf')).not.toThrow();
    expect(isConversationSyncActive()).toBe(false);
    expect(received).toEqual([]);
    unsubscribe();
  });
});
