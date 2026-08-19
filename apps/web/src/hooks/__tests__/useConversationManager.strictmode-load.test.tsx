// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The conversation-load effect must survive React StrictMode's double
 * invocation.
 *
 * StrictMode (dev only) runs an effect, tears it down, and runs it again on the
 * same component instance — so the refs the load effect uses to detect "did the
 * conversation actually change?" are already up to date on the second pass and
 * it early-returns. That no-op pass must not invalidate the FIRST pass's load:
 * if it bumps the request counter on its way out, the in-flight read finds its
 * own request id stale and throws away the messages it just read from
 * IndexedDB. The visible symptom was an existing conversation restoring as a
 * blank pane on the dev server while production (no StrictMode) was fine.
 *
 * The StrictMode case is the regression; the plain-render case below is the
 * control that says the load path itself works.
 */

import { StrictMode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useConversationManager } from "../useConversationManager";
import { useChatStore } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import { openEcoDB } from "../../lib/db";

const CONVERSATION_ID = "conv-strictmode";
const USER_ID = "msg-user";
const ASSISTANT_ID = "msg-assistant";
const ASK = "what did we say about the roof?";
const REPLY = "You decided to re-shingle it in the spring.";

async function seedConversation(): Promise<void> {
  const db = await openEcoDB();
  await db.put("conversations", {
    id: CONVERSATION_ID,
    title: "Seeded",
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

/** Render the manager pointed at the seeded conversation, optionally in StrictMode. */
function renderManager(options: { strict: boolean }) {
  return renderHook(
    () =>
      useConversationManager({
        messages: useChatStore.getState().messages,
        isStreaming: false,
        activeConversationId: CONVERSATION_ID,
        activeConversationLeafId: ASSISTANT_ID,
        sendMessage: vi.fn(),
        editMessage: vi.fn(),
        regenerateMessage: vi.fn(),
        clearComposerDraft: vi.fn(),
      }),
    options.strict ? { wrapper: StrictMode } : undefined,
  );
}

beforeEach(async () => {
  await seedConversation();
  useChatStore.setState({ messages: [], isStreaming: false, streamPhase: "idle" });
  useConversationStore.setState({
    activeConversationId: CONVERSATION_ID,
    conversations: [
      {
        id: CONVERSATION_ID,
        title: "Seeded",
        createdAt: 1,
        updatedAt: 2,
        activeLeafId: ASSISTANT_ID,
      },
    ],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useConversationManager conversation load", () => {
  it("restores the seeded conversation under StrictMode's double effect pass", async () => {
    const { result } = renderManager({ strict: true });

    await waitFor(() => {
      expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([ASK, REPLY]);
    });

    // The branch-navigation read is guarded by the same request id, so it is
    // discarded by the same defect.
    await waitFor(() => {
      expect(result.current.allMessages).toHaveLength(2);
    });

    // ...and so is the `finally` that lifts the restore gate.
    await waitFor(() => {
      expect(result.current.isConversationReady).toBe(true);
    });
    expect(result.current.pendingConversationRestoreRef.current).toBe(false);
  });

  it("restores the seeded conversation on a plain render (control)", async () => {
    const { result } = renderManager({ strict: false });

    await waitFor(() => {
      expect(useChatStore.getState().messages.map((m) => m.content)).toEqual([ASK, REPLY]);
    });
    await waitFor(() => {
      expect(result.current.allMessages).toHaveLength(2);
      expect(result.current.isConversationReady).toBe(true);
    });
  });
});
