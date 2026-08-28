// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A reply that is cut off mid-stream (crash, reload, tab killed) must not lose
 * the words that already arrived.
 *
 * The full sync to IndexedDB only runs when streaming stops. Before this test,
 * the assistant record on disk stayed the empty stub written when the turn
 * started, so a crash mid-answer threw away every token — the restore path
 * marked the reply "interrupted" but had nothing to show. The manager now
 * checkpoints the streaming reply on a throttle while tokens land.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useConversationManager, STREAMING_CHECKPOINT_MS } from "../useConversationManager";
import { useChatStore } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import { openEcoDB } from "../../lib/db";

const CONVERSATION_ID = "conv-midstream";
const USER_ID = "msg-user";
const ASSISTANT_ID = "msg-assistant";
const ASK = "explain photosynthesis";
const BATCHES = ["Plants turn light", " into sugar", " using chlorophyll."];

async function readAssistantOnDisk(): Promise<string | undefined> {
  const db = await openEcoDB();
  const record = await db.get("messages", ASSISTANT_ID);
  db.close();
  return record?.content;
}

beforeEach(async () => {
  const db = await openEcoDB();
  await db.put("conversations", {
    id: CONVERSATION_ID, title: ASK, preview: ASK, createdAt: 1, updatedAt: 2, activeLeafId: USER_ID,
  });
  await db.put("messages", {
    id: USER_ID, conversationId: CONVERSATION_ID, parentId: null, role: "user", content: ASK, createdAt: 1, status: "complete",
  });
  db.close();
  useChatStore.setState({ messages: [], isStreaming: false, streamPhase: "idle" });
  useConversationStore.setState({
    activeConversationId: CONVERSATION_ID,
    conversations: [{ id: CONVERSATION_ID, title: ASK, preview: ASK, createdAt: 1, updatedAt: 2, activeLeafId: USER_ID }],
  });
});


describe("useConversationManager mid-stream checkpoint", () => {
  it("persists the partial reply while streaming, without the completion sync", async () => {
    const { result, rerender } = renderHook(() =>
      useConversationManager({
        messages: useChatStore.getState().messages,
        isStreaming: useChatStore.getState().isStreaming,
        activeConversationId: CONVERSATION_ID,
        activeConversationLeafId: USER_ID,
        sendMessage: vi.fn(),
        editMessage: vi.fn(),
        regenerateMessage: vi.fn(),
        clearComposerDraft: vi.fn(),
      }),
    );
    await waitFor(() => {
      expect(result.current.isConversationReady).toBe(true);
      expect(useChatStore.getState().messages).toHaveLength(1);
    });

    // The turn starts: empty assistant stub, streaming on. This mirrors what
    // useChat writes to disk at send time.
    act(() => {
      useChatStore.setState((state) => ({
        messages: [
          ...state.messages,
          { id: ASSISTANT_ID, role: "assistant", content: "", parentId: USER_ID, status: "streaming", createdAt: 2 },
        ],
        isStreaming: true,
      }));
    });
    rerender();
    await useConversationStore.getState().saveMessage({
      id: ASSISTANT_ID, conversationId: CONVERSATION_ID, parentId: USER_ID, role: "assistant", content: "", createdAt: 2, status: "streaming",
    });

    // Tokens land in three batches; streaming never ends (the "crash").
    let content = "";
    for (const batch of BATCHES) {
      content += batch;
      const snapshot = content;
      act(() => {
        useChatStore.setState((state) => ({
          messages: state.messages.map((m) => (m.id === ASSISTANT_ID ? { ...m, content: snapshot } : m)),
        }));
      });
      rerender();
      await new Promise((resolve) => setTimeout(resolve, STREAMING_CHECKPOINT_MS + 20));
    }

    await waitFor(async () => {
      expect(await readAssistantOnDisk()).toBe(BATCHES.join(""));
    });
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it("flushes the words still waiting on the throttle when the page is hidden", async () => {
    const { result, rerender } = renderHook(() =>
      useConversationManager({
        messages: useChatStore.getState().messages,
        isStreaming: useChatStore.getState().isStreaming,
        activeConversationId: CONVERSATION_ID,
        activeConversationLeafId: USER_ID,
        sendMessage: vi.fn(),
        editMessage: vi.fn(),
        regenerateMessage: vi.fn(),
        clearComposerDraft: vi.fn(),
      }),
    );
    await waitFor(() => {
      expect(result.current.isConversationReady).toBe(true);
      expect(useChatStore.getState().messages).toHaveLength(1);
    });
    act(() => {
      useChatStore.setState((state) => ({
        messages: [
          ...state.messages,
          { id: ASSISTANT_ID, role: "assistant", content: "", parentId: USER_ID, status: "streaming", createdAt: 2 },
        ],
        isStreaming: true,
      }));
    });
    rerender();
    await useConversationStore.getState().saveMessage({
      id: ASSISTANT_ID, conversationId: CONVERSATION_ID, parentId: USER_ID, role: "assistant", content: "", createdAt: 2, status: "streaming",
    });

    const setContent = (content: string) => {
      act(() => {
        useChatStore.setState((state) => ({
          messages: state.messages.map((m) => (m.id === ASSISTANT_ID ? { ...m, content } : m)),
        }));
      });
      rerender();
    };

    // First token: the throttle's first write is immediate.
    setContent("Eco,");
    await waitFor(async () => {
      expect(await readAssistantOnDisk()).toBe("Eco,");
    });

    // More arrives inside the throttle window, then a phone backgrounds the
    // tab (which may then kill it): the words must not wait out the timer.
    setContent("Eco, let's dive into the tale of the lighthouse keeper.");
    expect(await readAssistantOnDisk()).toBe("Eco,");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // Well inside the throttle window: only the flush can have written this.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await readAssistantOnDisk()).toBe("Eco, let's dive into the tale of the lighthouse keeper.");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});
