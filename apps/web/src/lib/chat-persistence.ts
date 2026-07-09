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

  for (const message of messages) {
    void conversationStore.saveMessage(toDbMessage(message, conversationId));
  }

  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    conversationStore.updateConversation(conversationId, {
      activeLeafId: lastMessage.id,
    });
  }
}
