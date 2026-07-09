// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect } from "react";
import type { ChatMessage } from "../stores/chatStore";
import {
  consumePendingMessageFocus,
  readPendingMessageFocus,
} from "../lib/conversation-navigation";

/**
 * Scroll a message into view and flash a highlight. Wires the `scrollToMessage`
 * window event (fired by search-result selection) and consumes a pending
 * message focus when the active conversation loads.
 */
export function useScrollToMessage(
  activeConversationId: string | null,
  messages: ChatMessage[],
): void {
  const scrollToMessageWithHighlight = useCallback((messageId: string, attempt = 0) => {
    const el = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!el) {
      if (attempt < 6) {
        window.setTimeout(() => {
          scrollToMessageWithHighlight(messageId, attempt + 1);
        }, 120);
      }
      return;
    }

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("message-highlight");
    window.setTimeout(() => {
      el.classList.remove("message-highlight");
    }, 2000);
  }, []);

  useEffect(() => {
    function handleScrollToMessage(e: Event) {
      const { messageId } = (e as CustomEvent<{ messageId: string }>).detail;
      if (!messageId) return;
      scrollToMessageWithHighlight(messageId);
    }

    window.addEventListener("scrollToMessage", handleScrollToMessage);
    return () => window.removeEventListener("scrollToMessage", handleScrollToMessage);
  }, [scrollToMessageWithHighlight]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    const pendingFocus = readPendingMessageFocus();
    if (
      pendingFocus
      && pendingFocus.conversationId === activeConversationId
      && messages.some((message) => message.id === pendingFocus.messageId)
    ) {
      consumePendingMessageFocus();
      scrollToMessageWithHighlight(pendingFocus.messageId);
    }
  }, [activeConversationId, messages, scrollToMessageWithHighlight]);
}
