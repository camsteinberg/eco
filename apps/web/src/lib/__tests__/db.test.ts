// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  openEcoDB,
  getActiveBranch,
  getSiblings,
  toDbMessage,
  addReactionToMessage,
  removeReactionFromMessage,
} from "../db";
import type { IDBPDatabase } from "idb";
import type { EcoDB, DbConversation, DbMessage, MessageReaction } from "../db";
import type { ChatMessage } from "../../stores/chatStore";

let db: IDBPDatabase<EcoDB>;

afterEach(() => {
  db?.close();
});

beforeEach(async () => {
  // Close any existing connection before deleting
  if (db) db.close();
  const { deleteDB } = await import("idb");
  await deleteDB("eco-chat");
  db = await openEcoDB();
});

describe("openEcoDB", () => {
  it("returns a database with conversations and messages object stores", () => {
    expect(db.objectStoreNames).toContain("conversations");
    expect(db.objectStoreNames).toContain("messages");
  });

  it("conversations store has by-updated index", () => {
    const tx = db.transaction("conversations", "readonly");
    const store = tx.objectStore("conversations");
    expect(store.indexNames).toContain("by-updated");
  });

  it("messages store has by-conversation and by-parent indexes", () => {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    expect(store.indexNames).toContain("by-conversation");
    expect(store.indexNames).toContain("by-parent");
  });
});

describe("CRUD operations", () => {
  it("can add a conversation and retrieve it by id", async () => {
    const conv: DbConversation = {
      id: "conv-1",
      title: "Test Chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      activeLeafId: null,
    };
    await db.put("conversations", conv);
    const retrieved = await db.get("conversations", "conv-1");
    expect(retrieved).toEqual(conv);
  });

  it("can add messages with parentId and retrieve by conversationId index", async () => {
    const msg1: DbMessage = {
      id: "msg-1",
      conversationId: "conv-1",
      parentId: null,
      role: "user",
      content: "Hello",
      createdAt: 1000,
    };
    const msg2: DbMessage = {
      id: "msg-2",
      conversationId: "conv-1",
      parentId: "msg-1",
      role: "assistant",
      content: "Hi there",
      createdAt: 2000,
    };
    await db.put("messages", msg1);
    await db.put("messages", msg2);

    const messages = await db.getAllFromIndex("messages", "by-conversation", "conv-1");
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id)).toContain("msg-1");
    expect(messages.map((m) => m.id)).toContain("msg-2");
  });
});

describe("getActiveBranch", () => {
  it("walks parentId chain from leaf to root and returns ordered path", async () => {
    // Create a linear chain: msg1 -> msg2 -> msg3
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "A", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "B", createdAt: 2 },
      { id: "m3", conversationId: "c1", parentId: "m2", role: "user", content: "C", createdAt: 3 },
    ];
    for (const m of msgs) {
      await db.put("messages", m);
    }

    const branch = await getActiveBranch(db, "c1", "m3");
    expect(branch.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("returns only the branch path when there are sibling messages", async () => {
    // Tree:  m1 -> m2 (branch A)
    //        m1 -> m3 (branch B) -> m4
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "Root", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "Branch A", createdAt: 2 },
      { id: "m3", conversationId: "c1", parentId: "m1", role: "assistant", content: "Branch B", createdAt: 3 },
      { id: "m4", conversationId: "c1", parentId: "m3", role: "user", content: "Follow-up B", createdAt: 4 },
    ];
    for (const m of msgs) {
      await db.put("messages", m);
    }

    const branchA = await getActiveBranch(db, "c1", "m2");
    expect(branchA.map((m) => m.id)).toEqual(["m1", "m2"]);

    const branchB = await getActiveBranch(db, "c1", "m4");
    expect(branchB.map((m) => m.id)).toEqual(["m1", "m3", "m4"]);
  });

  it("returns empty array when leafId is null and the conversation has no messages", async () => {
    const branch = await getActiveBranch(db, "c1", null);
    expect(branch).toEqual([]);
  });

  it("returns empty array when leaf is not found and the conversation has no messages", async () => {
    const branch = await getActiveBranch(db, "c1", "nonexistent");
    expect(branch).toEqual([]);
  });

  it("falls back to the newest message when leafId is null but messages exist", async () => {
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "A", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "B", createdAt: 2 },
    ];
    for (const m of msgs) {
      await db.put("messages", m);
    }

    const branch = await getActiveBranch(db, "c1", null);
    expect(branch.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("falls back to the newest message when the leaf id is dangling", async () => {
    // The dangling-leaf shape task #28 restores from: the conversation record
    // points at a message whose save never landed (e.g. dropped under storage
    // pressure), while earlier messages persisted fine.
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "A", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "B", createdAt: 2 },
      { id: "m3", conversationId: "c1", parentId: "m2", role: "user", content: "C", createdAt: 3 },
    ];
    for (const m of msgs) {
      await db.put("messages", m);
    }

    const branch = await getActiveBranch(db, "c1", "never-saved");
    expect(branch.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("fallback stays on the newest branch when siblings exist", async () => {
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "Root", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "Branch A", createdAt: 2 },
      { id: "m3", conversationId: "c1", parentId: "m1", role: "assistant", content: "Branch B", createdAt: 3 },
      { id: "m4", conversationId: "c1", parentId: "m3", role: "user", content: "Follow-up B", createdAt: 4 },
    ];
    for (const m of msgs) {
      await db.put("messages", m);
    }

    const branch = await getActiveBranch(db, "c1", null);
    expect(branch.map((m) => m.id)).toEqual(["m1", "m3", "m4"]);
  });

  it("truncates instead of hanging on a corrupt parentId cycle", async () => {
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: "m2", role: "user", content: "A", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "B", createdAt: 2 },
    ];
    for (const m of msgs) {
      await db.put("messages", m);
    }

    const branch = await getActiveBranch(db, "c1", "m2");
    expect(branch.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});

describe("getSiblings", () => {
  it("returns siblings sharing the same parentId sorted by createdAt", () => {
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "Root", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "First", createdAt: 2 },
      { id: "m3", conversationId: "c1", parentId: "m1", role: "assistant", content: "Second", createdAt: 3 },
      { id: "m4", conversationId: "c1", parentId: "m1", role: "assistant", content: "Third", createdAt: 4 },
    ];

    const result = getSiblings(msgs, "m3", "m1");
    expect(result.siblings.map((m) => m.id)).toEqual(["m2", "m3", "m4"]);
    expect(result.currentIndex).toBe(1);
  });

  it("returns siblings for root messages (parentId = null)", () => {
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "First root", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: null, role: "user", content: "Second root", createdAt: 2 },
    ];

    const result = getSiblings(msgs, "m1", null);
    expect(result.siblings.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.currentIndex).toBe(0);
  });

  it("returns single sibling when message has no brothers", () => {
    const msgs: DbMessage[] = [
      { id: "m1", conversationId: "c1", parentId: null, role: "user", content: "Root", createdAt: 1 },
      { id: "m2", conversationId: "c1", parentId: "m1", role: "assistant", content: "Only child", createdAt: 2 },
    ];

    const result = getSiblings(msgs, "m2", "m1");
    expect(result.siblings).toHaveLength(1);
    expect(result.currentIndex).toBe(0);
  });
});

describe("toDbMessage", () => {
  it("maps all ChatMessage fields correctly to DbMessage", () => {
    const chatMsg: ChatMessage = {
      id: "msg-1",
      role: "user",
      content: "Hello world",
      createdAt: 1700000000000,
      parentId: "parent-1",
      status: "complete",
      errorMessage: undefined,
      tokenCount: 42,
      streamStartTime: 1700000000100,
    };

    const result = toDbMessage(chatMsg, "conv-1");

    expect(result).toEqual({
      id: "msg-1",
      conversationId: "conv-1",
      parentId: "parent-1",
      role: "user",
      content: "Hello world",
      createdAt: 1700000000000,
      status: "complete",
      errorMessage: undefined,
      tokenCount: 42,
      streamStartTime: 1700000000100,
    });
  });

  it("maps parentId undefined to null", () => {
    const chatMsg: ChatMessage = {
      id: "msg-2",
      role: "assistant",
      content: "Hi",
      createdAt: 1700000000000,
    };

    const result = toDbMessage(chatMsg, "conv-2");

    expect(result.parentId).toBeNull();
  });

  it("preserves optional fields (status, errorMessage, tokenCount, streamStartTime)", () => {
    const chatMsg: ChatMessage = {
      id: "msg-3",
      role: "assistant",
      content: "Error occurred",
      createdAt: 1700000000000,
      status: "error",
      errorMessage: "Something went wrong",
      tokenCount: 10,
      streamStartTime: null,
    };

    const result = toDbMessage(chatMsg, "conv-3");

    expect(result.status).toBe("error");
    expect(result.errorMessage).toBe("Something went wrong");
    expect(result.tokenCount).toBe(10);
    expect(result.streamStartTime).toBeNull();
  });

  it("preserves runtime truth metadata used by chat surfaces", () => {
    const chatMsg: ChatMessage = {
      id: "msg-4",
      role: "assistant",
      content: "Kept working locally",
      createdAt: 1700000000000,
      status: "complete",
      inferenceMethod: "local",
      offlineDivider: true,
    };

    const result = toDbMessage(chatMsg, "conv-4");

    expect(result.offlineDivider).toBe(true);
    expect(result.inferenceMethod).toBe("local");
  });

  it("preserves grounding citations so a reloaded answer keeps its source chip", () => {
    const chatMsg: ChatMessage = {
      id: "msg-cited",
      role: "assistant",
      content: "The Eiffel Tower is 330 metres tall.",
      createdAt: 1700000000000,
      status: "complete",
      citations: [
        {
          id: 1,
          title: "Eiffel Tower",
          url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
          source: "Wikipedia",
          asOf: "2023",
        },
      ],
    };

    const result = toDbMessage(chatMsg, "conv-cited");

    expect(result.citations).toEqual(chatMsg.citations);
    expect(result.verification).toBeUndefined();
  });

  it("preserves the grounding uncertainty marker so a reloaded answer stays honestly flagged", () => {
    const chatMsg: ChatMessage = {
      id: "msg-unverified",
      role: "assistant",
      content: "I couldn't confirm that against a source.",
      createdAt: 1700000000000,
      status: "complete",
      verification: { status: "unverified" },
    };

    const result = toDbMessage(chatMsg, "conv-unverified");

    expect(result.verification).toEqual({ status: "unverified" });
    expect(result.citations).toBeUndefined();
  });

  it("persists the canonicalToolAnswer flag so a reloaded exact-answer turn stays canonical (plain, exact copy)", () => {
    const chatMsg: ChatMessage = {
      id: "msg-canonical",
      role: "assistant",
      content: "17 * 23 = 391",
      createdAt: 1700000000000,
      status: "complete",
      canonicalToolAnswer: true,
    };

    const result = toDbMessage(chatMsg, "conv-canonical");

    expect(result.canonicalToolAnswer).toBe(true);
    // The exact host-computed value is the persisted content — the source of truth
    // for scroll-back render and copy/export.
    expect(result.content).toBe("17 * 23 = 391");
  });

  it("omits canonicalToolAnswer for an ordinary assistant message", () => {
    const chatMsg: ChatMessage = {
      id: "msg-plain",
      role: "assistant",
      content: "Here is a normal reply.",
      createdAt: 1700000000000,
      status: "complete",
    };

    const result = toDbMessage(chatMsg, "conv-plain");

    expect(result.canonicalToolAnswer).toBeUndefined();
  });
});

describe("IndexedDB v3 — reactions", () => {
  it("opens database with version 3", () => {
    expect(db.version).toBe(3);
  });

  it("MessageReaction type has emoji (string) and timestamp (number)", () => {
    const reaction: MessageReaction = { emoji: "heart", timestamp: 1700000000000 };
    expect(typeof reaction.emoji).toBe("string");
    expect(typeof reaction.timestamp).toBe("number");
  });

  it("existing messages without reactions field load correctly (undefined is valid)", async () => {
    const msg: DbMessage = {
      id: "msg-no-reactions",
      conversationId: "conv-1",
      parentId: null,
      role: "assistant",
      content: "Hello",
      createdAt: Date.now(),
    };
    await db.put("messages", msg);
    const retrieved = await db.get("messages", "msg-no-reactions");
    expect(retrieved).toBeDefined();
    expect(retrieved!.reactions).toBeUndefined();
    expect(retrieved!.content).toBe("Hello");
  });

  it("DbMessage with reactions array round-trips through IndexedDB", async () => {
    const reactions: MessageReaction[] = [
      { emoji: "thumbs-up", timestamp: 1700000000000 },
      { emoji: "leaf", timestamp: 1700000000001 },
    ];
    const msg: DbMessage = {
      id: "msg-with-reactions",
      conversationId: "conv-1",
      parentId: null,
      role: "assistant",
      content: "Test",
      createdAt: Date.now(),
      reactions,
    };
    await db.put("messages", msg);
    const retrieved = await db.get("messages", "msg-with-reactions");
    expect(retrieved!.reactions).toEqual(reactions);
  });
});

describe("addReactionToMessage / removeReactionFromMessage", () => {
  it("adds a reaction to a message", async () => {
    const msg: DbMessage = {
      id: "msg-react-add",
      conversationId: "conv-1",
      parentId: null,
      role: "assistant",
      content: "Test",
      createdAt: Date.now(),
    };
    await db.put("messages", msg);
    // Close the shared connection so the helper can open its own
    db.close();

    await addReactionToMessage("msg-react-add", "heart");
    // Reopen for assertions
    db = await openEcoDB();
    const retrieved = await db.get("messages", "msg-react-add");
    expect(retrieved!.reactions).toHaveLength(1);
    expect(retrieved!.reactions![0]!.emoji).toBe("heart");
    expect(typeof retrieved!.reactions![0]!.timestamp).toBe("number");
  });

  it("removes a reaction from a message", async () => {
    const msg: DbMessage = {
      id: "msg-react-remove",
      conversationId: "conv-1",
      parentId: null,
      role: "assistant",
      content: "Test",
      createdAt: Date.now(),
      reactions: [
        { emoji: "heart", timestamp: 1700000000000 },
        { emoji: "leaf", timestamp: 1700000000001 },
      ],
    };
    await db.put("messages", msg);
    // Close the shared connection so the helper can open its own
    db.close();

    await removeReactionFromMessage("msg-react-remove", "heart");
    // Reopen for assertions
    db = await openEcoDB();
    const retrieved = await db.get("messages", "msg-react-remove");
    expect(retrieved!.reactions).toHaveLength(1);
    expect(retrieved!.reactions![0]!.emoji).toBe("leaf");
  });
});
