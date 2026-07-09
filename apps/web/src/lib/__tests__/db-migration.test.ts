// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openEcoDB } from "../db";
import { migrateFromLocalStorage } from "../db-migration";
import type { IDBPDatabase } from "idb";
import type { EcoDB } from "../db";

let db: IDBPDatabase<EcoDB>;

afterEach(() => {
  db?.close();
});

beforeEach(async () => {
  if (db) db.close();
  const { deleteDB } = await import("idb");
  await deleteDB("eco-chat");
  db = await openEcoDB();
  localStorage.clear();
});

describe("migrateFromLocalStorage", () => {
  it("is a no-op when localStorage has no eco-conversations key", async () => {
    await migrateFromLocalStorage(db);
    const convs = await db.getAll("conversations");
    expect(convs).toHaveLength(0);
  });

  it("handles empty localStorage value gracefully", async () => {
    localStorage.setItem("eco-conversations", "");
    await migrateFromLocalStorage(db);
    const convs = await db.getAll("conversations");
    expect(convs).toHaveLength(0);
  });

  it("handles corrupted/unparseable localStorage gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem("eco-conversations", "not-json{{{");
    await migrateFromLocalStorage(db);
    const convs = await db.getAll("conversations");
    expect(convs).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("correctly unwraps Zustand persist envelope and migrates conversations", async () => {
    const zustandData = {
      state: {
        conversations: [
          {
            id: "conv-1",
            title: "My Chat",
            messages: [
              { id: "m1", role: "user", content: "Hello", createdAt: 1000 },
              { id: "m2", role: "assistant", content: "Hi!", createdAt: 2000 },
              { id: "m3", role: "user", content: "How are you?", createdAt: 3000 },
            ],
            createdAt: 1000,
            updatedAt: 3000,
          },
        ],
        activeConversationId: "conv-1",
      },
      version: 0,
    };
    localStorage.setItem("eco-conversations", JSON.stringify(zustandData));

    await migrateFromLocalStorage(db);

    // Conversation should be migrated
    const conv = await db.get("conversations", "conv-1");
    expect(conv).toBeDefined();
    expect(conv!.title).toBe("My Chat");
    expect(conv!.activeLeafId).toBe("m3");

    // Messages should be migrated with tree structure
    const msgs = await db.getAllFromIndex("messages", "by-conversation", "conv-1");
    expect(msgs).toHaveLength(3);

    const msgMap = new Map(msgs.map((m) => [m.id, m]));
    // First message: parentId = null
    expect(msgMap.get("m1")!.parentId).toBeNull();
    // Second message: parentId = first message
    expect(msgMap.get("m2")!.parentId).toBe("m1");
    // Third message: parentId = second message
    expect(msgMap.get("m3")!.parentId).toBe("m2");
    expect(localStorage.getItem("eco-active-conversation")).toBe("conv-1");
  });

  it("sets activeLeafId to last message id", async () => {
    const zustandData = {
      state: {
        conversations: [
          {
            id: "conv-1",
            title: "Test",
            messages: [
              { id: "m1", role: "user", content: "Only message", createdAt: 1000 },
            ],
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        activeConversationId: null,
      },
      version: 0,
    };
    localStorage.setItem("eco-conversations", JSON.stringify(zustandData));

    await migrateFromLocalStorage(db);
    const conv = await db.get("conversations", "conv-1");
    expect(conv!.activeLeafId).toBe("m1");
  });

  it("handles conversation with no messages", async () => {
    const zustandData = {
      state: {
        conversations: [
          {
            id: "conv-empty",
            title: "Empty",
            messages: [],
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        activeConversationId: null,
      },
      version: 0,
    };
    localStorage.setItem("eco-conversations", JSON.stringify(zustandData));

    await migrateFromLocalStorage(db);
    const conv = await db.get("conversations", "conv-empty");
    expect(conv).toBeDefined();
    expect(conv!.activeLeafId).toBeNull();
    const msgs = await db.getAllFromIndex("messages", "by-conversation", "conv-empty");
    expect(msgs).toHaveLength(0);
  });

  it("migrates multiple conversations", async () => {
    const zustandData = {
      state: {
        conversations: [
          {
            id: "conv-1",
            title: "First",
            messages: [
              { id: "m1", role: "user", content: "Hello", createdAt: 1000 },
            ],
            createdAt: 1000,
            updatedAt: 1000,
          },
          {
            id: "conv-2",
            title: "Second",
            messages: [
              { id: "m2", role: "user", content: "World", createdAt: 2000 },
            ],
            createdAt: 2000,
            updatedAt: 2000,
          },
        ],
        activeConversationId: "conv-1",
      },
      version: 0,
    };
    localStorage.setItem("eco-conversations", JSON.stringify(zustandData));

    await migrateFromLocalStorage(db);
    const convs = await db.getAll("conversations");
    expect(convs).toHaveLength(2);
  });

  it("removes localStorage key only after successful write and read-back verification", async () => {
    const zustandData = {
      state: {
        conversations: [
          {
            id: "conv-1",
            title: "Verify",
            messages: [
              { id: "m1", role: "user", content: "Test", createdAt: 1000 },
            ],
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        activeConversationId: null,
      },
      version: 0,
    };
    localStorage.setItem("eco-conversations", JSON.stringify(zustandData));

    await migrateFromLocalStorage(db);
    // localStorage key should be removed after successful migration
    expect(localStorage.getItem("eco-conversations")).toBeNull();
  });

  it("is idempotent -- second call is a no-op when localStorage already removed", async () => {
    const zustandData = {
      state: {
        conversations: [
          {
            id: "conv-1",
            title: "Idem",
            messages: [
              { id: "m1", role: "user", content: "Test", createdAt: 1000 },
            ],
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        activeConversationId: null,
      },
      version: 0,
    };
    localStorage.setItem("eco-conversations", JSON.stringify(zustandData));

    await migrateFromLocalStorage(db);
    await migrateFromLocalStorage(db);

    const convs = await db.getAll("conversations");
    // Should still have exactly 1 conversation (put is idempotent by key)
    expect(convs).toHaveLength(1);
  });
});
