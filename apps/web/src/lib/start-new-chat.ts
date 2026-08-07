// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { useChatStore } from "../stores/chatStore";
import { useConversationStore } from "../stores/conversationStore";
import { interruptActiveGeneration } from "../hooks/useChat";
import { clearGuestLocalContext } from "./guest-local-context";
import { toDbMessage } from "./db";

/**
 * The deliberate "start a new chat" routine, shared by the New chat button
 * (AppShell) and the /chat/new route. Flushes anything in flight, then clears
 * the active conversation through `setActive(null)` — the only path that both
 * removes the persisted active-conversation key and leaves the deliberate
 * new-chat marker. Clearing only in-memory state is not enough: the restore
 * effects on the chat page read localStorage directly and would reopen the
 * old conversation.
 */
export function startNewChat(): void {
  const chatState = useChatStore.getState();
  const conversationStore = useConversationStore.getState();

  if (chatState.isStreaming) {
    interruptActiveGeneration();
  }

  const activeId = conversationStore.activeConversationId;
  if (activeId) {
    const currentMessages = useChatStore.getState().messages;
    for (const message of currentMessages) {
      void conversationStore.saveMessage(toDbMessage(message, activeId));
    }

    const lastMessage = currentMessages[currentMessages.length - 1];
    if (lastMessage) {
      conversationStore.updateConversation(activeId, { activeLeafId: lastMessage.id });
    }
  }

  clearGuestLocalContext();
  conversationStore.setActive(null);
  chatState.clearMessages();
  chatState.restorePersistedPreferences();
}
