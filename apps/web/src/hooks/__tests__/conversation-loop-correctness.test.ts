// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Conversation-loop correctness tests (CS-1 through CS-4).
 *
 * CS-1 (retryMessage duplicate user turn) and CS-2 (editMessage stream-phase
 * restore) are hook-internal behaviors. These tests verify the store-level
 * invariants and the exported helpers that the fixes rely on.
 *
 * The pure-function tests for CS-3 and CS-4 live alongside the existing
 * context-window test suite in `lib/__tests__/context-window.test.ts`.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "../../stores/chatStore";
import type { ChatMessage } from "../../stores/chatStore";
import { selectMessagesForContext } from "../../lib/context-window";
import { estimateRenderingOverhead } from "../useChat";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msg(
  role: "user" | "assistant",
  content: string,
  id?: string,
  parentId?: string | null,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id: id ?? crypto.randomUUID(),
    role,
    content,
    createdAt: Date.now(),
    parentId: parentId ?? null,
    ...extra,
  };
}

// ─── CS-1: retryMessage must not duplicate the user turn ──────────────────────

describe("CS-1: retry produces no duplicate user turns", () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
  });

  it("the regenerate-style retry pattern yields exactly one user turn per question", () => {
    // Simulate the conversation tree before retry:
    //   [user "hello"] → [assistant {error, empty}]
    const userMsg = msg("user", "hello", "u1", null);
    const failedAssistant = msg("assistant", "", "a1", "u1", {
      status: "error",
      errorMessage: "something went wrong",
    });

    // Populate the store as if sendMessage had run and the assistant errored
    const store = useChatStore.getState();
    store.setMessages([userMsg, failedAssistant]);

    // Now simulate the CS-1 fix (regenerate-style retry):
    // 1. Create a fresh sibling assistant with same parentId as the failed one
    const newAssistantId = store.addMessage({
      role: "assistant",
      content: "",
      parentId: failedAssistant.parentId,
    });

    // 2. Rebuild ancestors from failedAssistant.parentId
    const allMsgs = useChatStore.getState().messages;
    const msgById = new Map(allMsgs.map((m) => [m.id, m]));
    const ancestors: ChatMessage[] = [];
    let currentId: string | null = failedAssistant.parentId ?? null;
    while (currentId) {
      const m = msgById.get(currentId);
      if (!m) break;
      ancestors.push(m);
      currentId = m.parentId ?? null;
    }
    ancestors.reverse();

    // 3. setMessages to show ancestors + new assistant
    const newAssistant = allMsgs.find((m) => m.id === newAssistantId)!;
    store.setMessages([...ancestors, newAssistant]);

    // ASSERT: the active branch has exactly ONE user turn for "hello"
    const branch = useChatStore.getState().messages;
    const userTurns = branch.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]!.content).toBe("hello");

    // ASSERT: the apiMessages (what the model sees) have no consecutive user roles
    const apiMessages = branch.map((m) => ({ role: m.role, content: m.content }));
    for (let i = 1; i < apiMessages.length; i++) {
      if (apiMessages[i]!.role === "user") {
        expect(apiMessages[i - 1]!.role).not.toBe("user");
      }
    }
  });

  it("the OLD pattern (remove + sendMessage) would create a duplicate user turn", () => {
    // Demonstrate the bug that CS-1 fixes: the old code did
    // removeMessage(failedAssistant.id) then sendMessage(userMsg.content),
    // which adds a SECOND user message.
    const userMsg = msg("user", "hello", "u1", null);
    const failedAssistant = msg("assistant", "", "a1", "u1", {
      status: "error",
    });

    const store = useChatStore.getState();
    store.setMessages([userMsg, failedAssistant]);

    // Simulate the old code: remove failed assistant
    store.removeMessage("a1");
    // Then "sendMessage" adds a NEW user message (simulated)
    store.addMessage({
      role: "user",
      content: "hello",
      parentId: "u1",
    });

    // The old code produced TWO user turns with the same content
    const branch = useChatStore.getState().messages;
    const userTurns = branch.filter((m) => m.role === "user");
    expect(userTurns).toHaveLength(2); // BUG: duplicate
    expect(userTurns[0]!.content).toBe("hello");
    expect(userTurns[1]!.content).toBe("hello");

    // And consecutive user roles in the API messages
    const roles = branch.map((m) => m.role);
    expect(roles).toEqual(["user", "user"]); // BUG: consecutive users
  });
});

// ─── CS-2: editMessage must restore streamPhase after setMessages ─────────────

describe("CS-2: setMessages resets streamPhase (proving the bug)", () => {
  beforeEach(() => {
    useChatStore.getState().clearMessages();
  });

  it("setMessages resets streamPhase to idle and isStreaming to false", () => {
    const store = useChatStore.getState();
    store.setStreamPhase("generating");
    expect(useChatStore.getState().isStreaming).toBe(true);
    expect(useChatStore.getState().streamPhase).toBe("generating");

    store.setMessages([msg("user", "hello")]);

    // After setMessages, phase is reset to idle — this IS the bug when
    // editMessage calls setMessages without restoring the phase.
    expect(useChatStore.getState().streamPhase).toBe("idle");
    expect(useChatStore.getState().isStreaming).toBe(false);
  });

  it("calling setStreamPhase after setMessages restores the streaming state", () => {
    const store = useChatStore.getState();

    // Simulate the CS-2 fix: setMessages then restore
    store.setMessages([msg("user", "hello")]);
    store.setStreamPhase("thinking");

    expect(useChatStore.getState().streamPhase).toBe("thinking");
    expect(useChatStore.getState().isStreaming).toBe(true);
  });

  it("the restored phase is not idle before the first token (the CS-2 invariant)", () => {
    // The fix ensures that after editMessage kicks off, isStreaming is true
    // and streamPhase is not idle. This simulates the sequence.
    const store = useChatStore.getState();

    // 1. editMessage sets streamPhase before setMessages
    store.setStreamPhase("thinking");
    expect(useChatStore.getState().isStreaming).toBe(true);

    // 2. editMessage calls setMessages (resets to idle)
    store.setMessages([msg("user", "edited content")]);
    expect(useChatStore.getState().isStreaming).toBe(false); // BUG without fix

    // 3. CS-2 fix: restore the phase immediately after setMessages
    store.setStreamPhase("thinking");
    expect(useChatStore.getState().isStreaming).toBe(true); // FIXED
    expect(useChatStore.getState().streamPhase).not.toBe("idle"); // FIXED
  });
});

// ─── CS-4: estimateRenderingOverhead ──────────────────────────────────────────

describe("CS-4: estimateRenderingOverhead", () => {
  it("scales with user turn count", () => {
    const fewTurns = [
      { role: "user" }, { role: "assistant" },
    ];
    const manyTurns = [
      { role: "user" }, { role: "assistant" },
      { role: "user" }, { role: "assistant" },
      { role: "user" }, { role: "assistant" },
      { role: "user" }, { role: "assistant" },
      { role: "user" }, { role: "assistant" },
    ];
    const few = estimateRenderingOverhead(fewTurns, 4096);
    const many = estimateRenderingOverhead(manyTurns, 4096);
    expect(many).toBeGreaterThan(few);
  });

  it("caps at 10% of context length", () => {
    // 100 user turns × 24 = 2400, but cap at 10% of 4096 = 409
    const messages = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
    }));
    const overhead = estimateRenderingOverhead(messages, 4096);
    expect(overhead).toBeLessThanOrEqual(Math.floor(4096 * 0.10));
  });

  it("returns a positive value even for a single user turn", () => {
    const messages = [{ role: "user" }];
    expect(estimateRenderingOverhead(messages, 4096)).toBeGreaterThan(0);
  });

  it("integrated: selectMessagesForContext with overhead prevents safety failure", () => {
    // End-to-end: a window that would pass 0.75 raw but fail 0.90 rendered
    // now evicts enough to pass safety.
    const ctx = 4096;
    const systemPrompt = "s".repeat(400); // 100 tokens
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 29; i++) {
      messages.push(msg("user", "u".repeat(200), `u${i}`));
      messages.push(msg("assistant", "a".repeat(200), `a${i}`));
    }
    // 58 messages × 50 tokens = 2900 raw tokens

    const overhead = estimateRenderingOverhead(messages, ctx);
    const selected = selectMessagesForContext(messages, ctx, systemPrompt, {
      reservedOverheadTokens: overhead,
    });

    // The selected + overhead + system must fit 0.90·ctx
    const selectedTokens = selected.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0,
    );
    const renderedTotal = selectedTokens + overhead + Math.ceil(systemPrompt.length / 4);
    expect(renderedTotal).toBeLessThanOrEqual(Math.floor(ctx * 0.90));
  });
});
