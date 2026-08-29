// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The branch-navigation read used to fail in total silence.
 *
 * `loadAllMessages` feeds sibling arrows and reactions, so when it fails the
 * cost to a person is some navigation, not their words — a notice there would
 * be noise. But a bare `catch {}` also meant a storage problem left no trace
 * anywhere, which is undiagnosable. It must warn, and it must still NOT raise
 * a user-facing persistence notice.
 *
 * The rejection here is real: the store has already cached its database handle
 * by the time opens start failing, so only this read breaks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Hoisted: the conversation store hydrates during module import, which calls
// `openEcoDB` before any plain `let` in this file has been initialised.
const dbState = vi.hoisted(() => ({ failOpens: false }));

vi.mock("../../lib/db", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
  return {
    ...actual,
    openEcoDB(options?: Parameters<typeof actual.openEcoDB>[0]) {
      if (dbState.failOpens) {
        return Promise.reject(new DOMException("storage unavailable", "InvalidStateError"));
      }
      return actual.openEcoDB(options);
    },
  };
});

import { useConversationManager } from "../useConversationManager";
import { useChatStore } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import { openEcoDB } from "../../lib/db";
import { logger } from "../../lib/logger";

const CONVERSATION_ID = "conv-branch-load-failure";
const USER_ID = "msg-user";

async function seedConversation(): Promise<void> {
  const db = await openEcoDB();
  await db.put("conversations", {
    id: CONVERSATION_ID,
    title: "Seeded",
    createdAt: 1,
    updatedAt: 2,
    activeLeafId: USER_ID,
  });
  await db.put("messages", {
    id: USER_ID,
    conversationId: CONVERSATION_ID,
    parentId: null,
    role: "user",
    content: "what did we say about the roof?",
    createdAt: 1,
    status: "complete",
  });
  db.close();
}

function renderManager() {
  return renderHook(() =>
    useConversationManager({
      messages: useChatStore.getState().messages,
      isStreaming: false,
      activeConversationId: CONVERSATION_ID,
      activeConversationLeafId: USER_ID,
      sendMessage: vi.fn(),
      editMessage: vi.fn(),
      regenerateMessage: vi.fn(),
      clearComposerDraft: vi.fn(),
    }),
  );
}

beforeEach(async () => {
  dbState.failOpens = false;
  await seedConversation();
  // The store opens (and caches) its own handle before opens start failing, so
  // the failure below lands only on the branch-navigation read.
  await waitFor(() => expect(useConversationStore.getState().hasHydrated).toBe(true));
  useChatStore.setState({ messages: [], isStreaming: false, streamPhase: "idle" });
  useConversationStore.setState({
    activeConversationId: CONVERSATION_ID,
    persistenceError: null,
    conversations: [
      {
        id: CONVERSATION_ID,
        title: "Seeded",
        createdAt: 1,
        updatedAt: 2,
        activeLeafId: USER_ID,
      },
    ],
  });
});

afterEach(() => {
  dbState.failOpens = false;
  vi.restoreAllMocks();
});

describe("useConversationManager branch-navigation load failure", () => {
  it("T6: a failed loadAllMessages warns and raises no user-facing notice", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    dbState.failOpens = true;

    const { result } = renderManager();

    await waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/branch navigation/i),
        expect.anything(),
      );
    });

    expect(result.current.allMessages).toEqual([]);
    expect(useConversationStore.getState().persistenceError).toBeNull();
  });
});
