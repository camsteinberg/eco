// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { ChatMessage } from "../stores/chatStore";
import { toDbMessage } from "./db";

type ConversationSnapshotStore = {
  saveMessage: (message: ReturnType<typeof toDbMessage>) => unknown;
  updateConversation: (
    conversationId: string,
    patch: { activeLeafId: string },
  ) => unknown;
};

export function persistConversationMessagesSnapshot({
  conversationId,
  messages,
  conversationStore,
}: {
  conversationId: string | null;
  messages: ChatMessage[];
  conversationStore: ConversationSnapshotStore;
}): void {
  if (!conversationId || messages.length === 0) {
    return;
  }

  // Fire-and-forget to callers, but internally sequence the writes: persist the
  // messages BEFORE advancing the leaf. `updateConversation` broadcasts the new
  // leaf cross-tab (conversation-sync), and a receiving tab reloads from that
  // leaf — so the messages must be durable first, or the other tab could reload
  // a branch that is missing this turn.
  void persistSnapshot(conversationId, messages, conversationStore);
}

async function persistSnapshot(
  conversationId: string,
  messages: ChatMessage[],
  conversationStore: ConversationSnapshotStore,
): Promise<void> {
  await Promise.all(
    messages.map((message) =>
      Promise.resolve(conversationStore.saveMessage(toDbMessage(message, conversationId))),
    ),
  );

  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    conversationStore.updateConversation(conversationId, {
      activeLeafId: lastMessage.id,
    });
  }
}
