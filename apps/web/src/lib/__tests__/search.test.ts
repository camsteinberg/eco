// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeAll } from "vitest";
import { searchMessages } from "../search";
import { openEcoDB } from "../db";
import type { DbConversation, DbMessage } from "../db";

beforeAll(async () => {
  // Delete any existing database
  const { deleteDB } = await import("idb");
  await deleteDB("eco-chat");

  const db = await openEcoDB();

  // Seed test data
  const conversations: DbConversation[] = [
    { id: "conv-1", title: "Chat about Rust", createdAt: 1000, updatedAt: 5000, activeLeafId: null },
    { id: "conv-2", title: "Python tutorial", createdAt: 2000, updatedAt: 4000, activeLeafId: null },
    { id: "conv-3", title: "Empty conversation", createdAt: 3000, updatedAt: 3000, activeLeafId: null },
  ];

  const messages: DbMessage[] = [
    { id: "m1", conversationId: "conv-1", parentId: null, role: "user", content: "Tell me about Rust programming", createdAt: 1000 },
    { id: "m2", conversationId: "conv-1", parentId: "m1", role: "assistant", content: "Rust is a systems programming language focused on safety", createdAt: 2000 },
    { id: "m3", conversationId: "conv-1", parentId: "m2", role: "user", content: "What about memory safety in Rust?", createdAt: 3000 },
    { id: "m4", conversationId: "conv-2", parentId: null, role: "system", content: "You are a helpful assistant for programming questions", createdAt: 1000 },
    { id: "m5", conversationId: "conv-2", parentId: null, role: "user", content: "How do I learn Python programming?", createdAt: 2000 },
    { id: "m6", conversationId: "conv-2", parentId: "m5", role: "assistant", content: "Start with the official Python tutorial and practice daily", createdAt: 3000 },
    { id: "m7", conversationId: "conv-1", parentId: "m3", role: "assistant", content: "Rust guarantees memory safety without garbage collection", createdAt: 4000 },
  ];

  for (const conv of conversations) {
    await db.put("conversations", conv);
  }
  for (const msg of messages) {
    await db.put("messages", msg);
  }

  // Keep the connection open -- searchMessages will open its own
  // fake-indexeddb supports multiple connections
});

describe("searchMessages", () => {
  it("finds messages containing the search query", async () => {
    const results = await searchMessages("Rust");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.conversationId === "conv-1")).toBe(true);
  });

  it("returns snippet with correct context around match", async () => {
    const results = await searchMessages("safety");
    expect(results.length).toBeGreaterThan(0);

    const result = results[0]!;
    expect(result.snippet).toContain("safety");
    expect(result.highlightStart).toBeGreaterThanOrEqual(0);
    expect(result.highlightEnd).toBeGreaterThan(result.highlightStart);
  });

  it("performs case-insensitive matching", async () => {
    const results = await searchMessages("rust");
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.conversationId === "conv-1")).toBe(true);
  });

  it("skips system messages", async () => {
    const results = await searchMessages("helpful assistant");
    expect(results.length).toBe(0);
  });

  it("limits results to 20 by default", async () => {
    const results = await searchMessages("programming");
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("deduplicates by conversation (one result per conversation)", async () => {
    // "Rust" appears in multiple messages in conv-1
    const results = await searchMessages("Rust");
    const conv1Results = results.filter((r) => r.conversationId === "conv-1");
    expect(conv1Results.length).toBe(1);
  });

  it("returns empty array for no matches", async () => {
    const results = await searchMessages("zzzznonexistent");
    expect(results).toEqual([]);
  });

  it("returns empty array for empty query", async () => {
    const results = await searchMessages("");
    expect(results).toEqual([]);
  });

  it("includes conversationTitle in results", async () => {
    const results = await searchMessages("Python");
    const pythonResult = results.find((r) => r.conversationId === "conv-2");
    expect(pythonResult).toBeDefined();
    expect(pythonResult!.conversationTitle).toBe("Python tutorial");
  });

  it("sorts results by most recent conversation first", async () => {
    const results = await searchMessages("programming");
    if (results.length >= 2) {
      // conv-1 has updatedAt=5000, conv-2 has updatedAt=4000
      expect(results[0]!.conversationId).toBe("conv-1");
    }
  });
});
