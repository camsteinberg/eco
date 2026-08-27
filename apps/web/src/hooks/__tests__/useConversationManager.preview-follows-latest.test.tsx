// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The sidebar preview must follow the latest turn.
 *
 * A conversation's preview used to be written once — the first 60 characters
 * of the first message — and never touched again. Since the title is the first
 * 50 characters of the same message, every sidebar row showed its title twice.
 * After a turn completes, the preview should be the latest message instead.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useConversationManager } from "../useConversationManager";
import { useChatStore } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import { openEcoDB } from "../../lib/db";

const CONVERSATION_ID = "conv-preview";
const USER_ID = "msg-user";
const ASSISTANT_ID = "msg-assistant";
const ASK = "what did we say about the roof?";
const REPLY = "You decided to re-shingle it in the spring.";
const FOLLOW_UP = "and the gutters?";
const FOLLOW_UP_REPLY = "**Replace** the gutters at the same time so the crew only comes out once.";

async function seedConversation(): Promise<void> {
  const db = await openEcoDB();
  await db.put("conversations", {
    id: CONVERSATION_ID,
    title: ASK,
    preview: ASK,
    createdAt: 1,
    updatedAt: 2,
    activeLeafId: ASSISTANT_ID,
  });
  await db.put("messages", {
    id: USER_ID,
    conversationId: CONVERSATION_ID,
    parentId: null,
    role: "user",
    content: ASK,
    createdAt: 1,
    status: "complete",
  });
  await db.put("messages", {
    id: ASSISTANT_ID,
    conversationId: CONVERSATION_ID,
    parentId: USER_ID,
    role: "assistant",
    content: REPLY,
    createdAt: 2,
    status: "complete",
  });
  db.close();
}

beforeEach(async () => {
  await seedConversation();
  useChatStore.setState({ messages: [], isStreaming: false, streamPhase: "idle" });
  useConversationStore.setState({
    activeConversationId: CONVERSATION_ID,
    conversations: [
      {
        id: CONVERSATION_ID,
        title: ASK,
        preview: ASK,
        createdAt: 1,
        updatedAt: 2,
        activeLeafId: ASSISTANT_ID,
      },
    ],
  });
});

describe("useConversationManager sidebar preview", () => {
  it("moves the preview to the latest reply once a turn completes", async () => {
    const { result, rerender } = renderHook(() =>
      useConversationManager({
        messages: useChatStore.getState().messages,
        isStreaming: useChatStore.getState().isStreaming,
        activeConversationId: CONVERSATION_ID,
        activeConversationLeafId: ASSISTANT_ID,
        sendMessage: vi.fn(),
        editMessage: vi.fn(),
        regenerateMessage: vi.fn(),
        clearComposerDraft: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.isConversationReady).toBe(true);
      expect(useChatStore.getState().messages).toHaveLength(2);
    });

    // A new turn lands in the chat store and streaming ends.
    act(() => {
      useChatStore.setState((state) => ({
        messages: [
          ...state.messages,
          { id: "msg-user-2", role: "user", content: FOLLOW_UP, parentId: ASSISTANT_ID, status: "complete", createdAt: 3 },
          { id: "msg-assistant-2", role: "assistant", content: FOLLOW_UP_REPLY, parentId: "msg-user-2", status: "complete", createdAt: 4 },
        ],
        isStreaming: false,
      }));
    });
    rerender();

    await waitFor(() => {
      const conv = useConversationStore.getState().conversations.find((c) => c.id === CONVERSATION_ID);
      // Latest message, Markdown stripped, capped at 60 characters.
      expect(conv?.preview).toBe("Replace the gutters at the same time so the crew only comes");
    });
    // The sync also reloads the branch view; let it land so nothing is in
    // flight when the environment tears down.
    await waitFor(() => {
      expect(result.current.allMessages).toHaveLength(4);
    });
  });
});
