// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Cross-tab conversation sync.
 *
 * Each tab keeps its own in-memory Zustand conversation state, and chat writes
 * are last-write-wins on the `activeLeafId` pointer with no cross-tab awareness.
 * Two tabs on the same conversation therefore diverge silently: a send parents
 * onto the last message in *this* tab's visible list, so if another tab already
 * advanced the conversation, this tab writes a sibling branch and the other
 * tab's turn is orphaned (proven live — a reloaded tab loses a turn it wrote).
 *
 * This module is the missing link. After a write persists, the writer
 * broadcasts "conversation X advanced" on a BroadcastChannel; a tab viewing that
 * conversation reloads the latest branch (live sync) instead of writing on top
 * of a stale leaf. The reload is the fix — updating only the leaf pointer is not
 * enough, because a send parents onto the visible transcript, not the pointer.
 *
 * Feature-detected: where BroadcastChannel is unavailable (SSR, older engines)
 * every export is a safe no-op and single-tab behaviour is byte-for-byte
 * unchanged.
 */

const CHANNEL_NAME = 'eco-conversation-sync';

export type ConversationSyncMessage = {
  type: 'conversation-updated';
  /** The conversation that just advanced in the sending tab. */
  conversationId: string;
  /** The activeLeafId the writer advanced to, when known (else null). */
  leafId: string | null;
};

type Handler = (message: ConversationSyncMessage) => void;

// One channel per tab (module singleton). BroadcastChannel never delivers a
// message back to the instance that posted it, so a tab never hears its own
// broadcasts — no self-echo filtering needed.
let channel: BroadcastChannel | null = null;
let started = false;
const handlers = new Set<Handler>();

function broadcastAvailable(): boolean {
  return typeof BroadcastChannel !== 'undefined';
}

function ensureChannel(): BroadcastChannel | null {
  if (!broadcastAvailable()) {
    return null;
  }
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as ConversationSyncMessage | undefined;
      if (!data || data.type !== 'conversation-updated' || typeof data.conversationId !== 'string') {
        return;
      }
      for (const handler of handlers) {
        handler(data);
      }
    };
  }
  return channel;
}

/**
 * Announce that `conversationId` advanced to `leafId` in this tab, so other
 * tabs viewing it can live-sync. Safe to call when BroadcastChannel is absent
 * (no-op). Call this only AFTER the messages and conversation record have
 * persisted, so a receiver that reloads sees the new turn.
 */
export function broadcastConversationUpdate(
  conversationId: string,
  leafId: string | null,
): void {
  const ch = ensureChannel();
  if (!ch) {
    return;
  }
  try {
    ch.postMessage({
      type: 'conversation-updated',
      conversationId,
      leafId,
    } satisfies ConversationSyncMessage);
  } catch {
    // A closed channel or a non-cloneable payload must never break a chat write.
  }
}

/**
 * Subscribe to conversation updates broadcast by OTHER tabs. Returns an
 * unsubscribe function. No-op (returns a no-op unsubscribe) when BroadcastChannel
 * is unavailable.
 */
export function subscribeConversationUpdates(handler: Handler): () => void {
  started = true;
  ensureChannel();
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Whether cross-tab sync is active in this environment. */
export function isConversationSyncActive(): boolean {
  return started && channel !== null;
}

/** Test-only teardown of module state. */
export function __resetConversationSyncForTests(): void {
  if (channel) {
    channel.close();
    channel = null;
  }
  started = false;
  handlers.clear();
}
