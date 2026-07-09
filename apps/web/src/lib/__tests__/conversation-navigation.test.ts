// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumePendingConversationSearch,
  consumePendingMessageFocus,
  readPendingMessageFocus,
  rememberPendingConversationSearch,
  rememberPendingMessageFocus,
  resolveBranchLeafId,
} from "../conversation-navigation";

describe("resolveBranchLeafId", () => {
  it("returns the matched message when it is already a leaf", () => {
    expect(
      resolveBranchLeafId(
        [
          { id: "root", parentId: null, createdAt: 1 },
          { id: "leaf", parentId: "root", createdAt: 2 },
        ],
        "leaf",
      ),
    ).toBe("leaf");
  });

  it("returns the newest descendant leaf on the matched branch", () => {
    expect(
      resolveBranchLeafId(
        [
          { id: "root", parentId: null, createdAt: 1 },
          { id: "branch-a", parentId: "root", createdAt: 2 },
          { id: "branch-b", parentId: "root", createdAt: 3 },
          { id: "leaf-a", parentId: "branch-a", createdAt: 4 },
          { id: "leaf-b", parentId: "branch-a", createdAt: 5 },
        ],
        "branch-a",
      ),
    ).toBe("leaf-b");
  });

  it("returns null when the matched message does not exist", () => {
    expect(
      resolveBranchLeafId([{ id: "root", parentId: null, createdAt: 1 }], "missing"),
    ).toBeNull();
  });
});

describe("pending conversation navigation helpers", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("round-trips pending message focus through session storage", () => {
    rememberPendingMessageFocus({
      conversationId: "conv-1",
      messageId: "msg-2",
    });

    expect(readPendingMessageFocus()).toEqual({
      conversationId: "conv-1",
      messageId: "msg-2",
    });
    expect(consumePendingMessageFocus()).toEqual({
      conversationId: "conv-1",
      messageId: "msg-2",
    });
    expect(readPendingMessageFocus()).toBeNull();
  });

  it("round-trips pending conversation search requests", () => {
    rememberPendingConversationSearch();

    expect(consumePendingConversationSearch()).toBe(true);
    expect(consumePendingConversationSearch()).toBe(false);
  });
});
