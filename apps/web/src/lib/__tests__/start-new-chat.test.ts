// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it, vi } from "vitest";

const chatHookMocks = vi.hoisted(() => ({
  interruptActiveGeneration: vi.fn(),
}));

vi.mock("../../hooks/useChat", () => ({
  interruptActiveGeneration: chatHookMocks.interruptActiveGeneration,
}));

import { startNewChat } from "../start-new-chat";
import { useConversationStore } from "../../stores/conversationStore";
import { useChatStore } from "../../stores/chatStore";
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  NEW_CHAT_STORAGE_KEY,
} from "../chat-workspace-storage";
import type { Conversation } from "../types/conversation";

const makeConversation = (id: string): Conversation => ({
  id,
  title: "Test",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  activeLeafId: null,
  pinnedAt: null,
});

beforeEach(() => {
  localStorage.clear();
  chatHookMocks.interruptActiveGeneration.mockReset();
  useConversationStore.setState({
    conversations: [],
    activeConversationId: null,
  });
});

describe("startNewChat", () => {
  it("clears the active conversation and leaves the deliberate-new-chat marker", () => {
    useConversationStore.getState().addConversation(makeConversation("conv-1"));
    useConversationStore.getState().setActive("conv-1");

    startNewChat();

    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(NEW_CHAT_STORAGE_KEY)).toBe("true");
  });

  it("interrupts an in-flight generation before switching away", () => {
    useChatStore.setState({ isStreaming: true });

    startNewChat();

    expect(chatHookMocks.interruptActiveGeneration).toHaveBeenCalledTimes(1);
  });
});
