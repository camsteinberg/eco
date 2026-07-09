// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBranchNavigation } from "../useBranchNavigation";
import type { DbMessage } from "../../lib/db";
import type { ChatMessage } from "../../stores/chatStore";

// Mock the conversation store
const mockUpdateConversation = vi.fn();
vi.mock("../../stores/conversationStore", () => ({
  useConversationStore: {
    getState: () => ({
      activeConversationId: "conv-1",
      updateConversation: mockUpdateConversation,
    }),
  },
}));

function makeMsg(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" = "user",
  createdAt = Date.now()
): DbMessage {
  return {
    id,
    conversationId: "conv-1",
    parentId,
    role,
    content: `content-${id}`,
    createdAt,
  };
}

function toChatMessage(m: DbMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    parentId: m.parentId,
  };
}

describe("useBranchNavigation", () => {
  it("computes siblingInfo for each message in activeBranch", () => {
    // Tree: root -> [a1, a2, a3]
    const root = makeMsg("root", null, "user", 1);
    const a1 = makeMsg("a1", "root", "assistant", 2);
    const a2 = makeMsg("a2", "root", "assistant", 3);
    const a3 = makeMsg("a3", "root", "assistant", 4);

    const allMessages = [root, a1, a2, a3];
    const activeBranch = [toChatMessage(root), toChatMessage(a2)];

    const { result } = renderHook(() =>
      useBranchNavigation(allMessages, activeBranch)
    );

    // root has no siblings (it's the only root message)
    const rootInfo = result.current.siblingInfo.get("root");
    expect(rootInfo).toBeDefined();
    expect(rootInfo!.total).toBe(1);

    // a2 has 3 siblings (a1, a2, a3) and currentIndex = 1
    const a2Info = result.current.siblingInfo.get("a2");
    expect(a2Info).toBeDefined();
    expect(a2Info!.total).toBe(3);
    expect(a2Info!.currentIndex).toBe(1);
  });

  it("navigateToBranch calls updateConversation with the deepest leaf's id", () => {
    // Tree: root -> a1 -> leaf1
    //        root -> a2 -> leaf2
    const root = makeMsg("root", null, "user", 1);
    const a1 = makeMsg("a1", "root", "assistant", 2);
    const a2 = makeMsg("a2", "root", "assistant", 3);
    const leaf1 = makeMsg("leaf1", "a1", "user", 4);
    const leaf2 = makeMsg("leaf2", "a2", "user", 5);

    const allMessages = [root, a1, a2, leaf1, leaf2];
    const activeBranch = [toChatMessage(root), toChatMessage(a1), toChatMessage(leaf1)];

    const { result } = renderHook(() =>
      useBranchNavigation(allMessages, activeBranch)
    );

    // Navigate from a1 to a2 (next sibling)
    act(() => {
      result.current.navigateToBranch("a1", "next");
    });

    // Should update activeLeafId to leaf2 (deepest leaf of a2's subtree)
    expect(mockUpdateConversation).toHaveBeenCalledWith("conv-1", {
      activeLeafId: "leaf2",
    });
  });

  it("returns empty siblingInfo for empty activeBranch", () => {
    const { result } = renderHook(() =>
      useBranchNavigation([], [])
    );

    expect(result.current.siblingInfo.size).toBe(0);
  });

  it("navigateToBranch with prev direction goes to previous sibling", () => {
    const root = makeMsg("root", null, "user", 1);
    const a1 = makeMsg("a1", "root", "assistant", 2);
    const a2 = makeMsg("a2", "root", "assistant", 3);

    const allMessages = [root, a1, a2];
    const activeBranch = [toChatMessage(root), toChatMessage(a2)];

    const { result } = renderHook(() =>
      useBranchNavigation(allMessages, activeBranch)
    );

    act(() => {
      result.current.navigateToBranch("a2", "prev");
    });

    // a1 has no children, so a1 itself is the deepest leaf
    expect(mockUpdateConversation).toHaveBeenCalledWith("conv-1", {
      activeLeafId: "a1",
    });
  });
});
