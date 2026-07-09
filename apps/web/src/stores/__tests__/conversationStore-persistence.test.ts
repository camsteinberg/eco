// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function seedConversations() {
  const { openEcoDB } = await import("../../lib/db");
  const db = await openEcoDB();

  await db.put("conversations", {
    id: "conv-older",
    title: "Older conversation",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    activeLeafId: "older-leaf",
    preview: "Older preview",
    pinnedAt: null,
  });

  await db.put("conversations", {
    id: "conv-newer",
    title: "Newer conversation",
    createdAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
    activeLeafId: "newer-leaf",
    preview: "Newer preview",
    pinnedAt: null,
  });

  db.close();
}

async function resetConversationDb() {
  const { openEcoDB } = await import("../../lib/db");
  const db = await openEcoDB();

  const conversationTx = db.transaction("conversations", "readwrite");
  await conversationTx.store.clear();
  await conversationTx.done;

  const messageTx = db.transaction("messages", "readwrite");
  await messageTx.store.clear();
  await messageTx.done;

  db.close();
}

async function waitForHydration(
  useConversationStore: {
    getState(): { hasHydrated: boolean; activeConversationId: string | null };
  },
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (useConversationStore.getState().hasHydrated) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error("Conversation store did not hydrate in time");
}

describe("conversation store persistence", () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    await resetConversationDb();
  });

  afterEach(async () => {
    localStorage.clear();
    await resetConversationDb();
  });

  it("hydrates the last active conversation from localStorage", async () => {
    await seedConversations();

    const { ACTIVE_CONVERSATION_STORAGE_KEY } = await import(
      "../../lib/chat-workspace-storage"
    );
    localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, "conv-older");

    vi.resetModules();
    const reloaded = await import("../conversationStore");
    await waitForHydration(reloaded.useConversationStore);

    expect(reloaded.useConversationStore.getState().activeConversationId).toBe(
      "conv-older",
    );
    expect(localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY)).toBe("conv-older");
  });

  it("falls back to the most recent conversation when the saved id is missing", async () => {
    await seedConversations();

    const { ACTIVE_CONVERSATION_STORAGE_KEY } = await import(
      "../../lib/chat-workspace-storage"
    );
    localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, "missing-conversation");

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    expect(useConversationStore.getState().activeConversationId).toBe("conv-newer");
    expect(localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY)).toBe("conv-newer");
  });

  it("keeps a draft-first revisit in new chat when no active conversation was saved", async () => {
    await seedConversations();

    const { COMPOSER_DRAFT_STORAGE_KEY } = await import(
      "../../lib/chat-workspace-storage"
    );
    localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, "Still typing locally");

    vi.resetModules();
    const { ACTIVE_CONVERSATION_STORAGE_KEY, useConversationStore } = await import(
      "../conversationStore"
    );
    await waitForHydration(useConversationStore);

    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY)).toBeNull();
  });

  it("prefers the in-memory active leaf when reloading a branch right after navigation", async () => {
    const { openEcoDB } = await import("../../lib/db");
    const db = await openEcoDB();

    await db.put("conversations", {
      id: "conv-branch",
      title: "Branching conversation",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: "assistant-1",
      preview: "branch preview",
      pinnedAt: null,
    });

    await db.put("messages", {
      id: "user-1",
      conversationId: "conv-branch",
      parentId: null,
      role: "user",
      content: "Original prompt",
      createdAt: 1,
    });

    await db.put("messages", {
      id: "assistant-1",
      conversationId: "conv-branch",
      parentId: "user-1",
      role: "assistant",
      content: "Original answer",
      createdAt: 2,
    });

    await db.put("messages", {
      id: "assistant-2",
      conversationId: "conv-branch",
      parentId: "user-1",
      role: "assistant",
      content: "Alternate answer",
      createdAt: 3,
    });

    db.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    useConversationStore.setState({
      conversations: [
        {
          id: "conv-branch",
          title: "Branching conversation",
          createdAt: 1,
          updatedAt: 2,
          activeLeafId: "assistant-2",
          preview: "branch preview",
          pinnedAt: null,
        },
      ],
      activeConversationId: "conv-branch",
    });

    const branch = await useConversationStore
      .getState()
      .loadConversationMessages("conv-branch");

    expect(branch.map((message) => message.id)).toEqual(["user-1", "assistant-2"]);
  });

  it("restores grounding citations and the uncertainty marker on reload", async () => {
    const { openEcoDB } = await import("../../lib/db");
    const db = await openEcoDB();

    await db.put("conversations", {
      id: "conv-grounded",
      title: "Grounded conversation",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: "assistant-unverified",
      preview: "grounded preview",
      pinnedAt: null,
    });

    await db.put("messages", {
      id: "user-cited",
      conversationId: "conv-grounded",
      parentId: null,
      role: "user",
      content: "How tall is the Eiffel Tower?",
      createdAt: 1,
    });

    await db.put("messages", {
      id: "assistant-cited",
      conversationId: "conv-grounded",
      parentId: "user-cited",
      role: "assistant",
      content: "The Eiffel Tower is 330 metres tall.",
      createdAt: 2,
      citations: [
        {
          id: 1,
          title: "Eiffel Tower",
          url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
          source: "Wikipedia",
          asOf: "2023",
        },
      ],
    });

    await db.put("messages", {
      id: "user-unverified",
      conversationId: "conv-grounded",
      parentId: "assistant-cited",
      role: "user",
      content: "Who is the mayor of Atlantis?",
      createdAt: 3,
    });

    await db.put("messages", {
      id: "assistant-unverified",
      conversationId: "conv-grounded",
      parentId: "user-unverified",
      role: "assistant",
      content: "I couldn't confirm that against a source.",
      createdAt: 4,
      verification: { status: "unverified" },
    });

    db.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    useConversationStore.setState({
      conversations: [
        {
          id: "conv-grounded",
          title: "Grounded conversation",
          createdAt: 1,
          updatedAt: 2,
          activeLeafId: "assistant-unverified",
          preview: "grounded preview",
          pinnedAt: null,
        },
      ],
      activeConversationId: "conv-grounded",
    });

    const branch = await useConversationStore
      .getState()
      .loadConversationMessages("conv-grounded");

    const cited = branch.find((m) => m.id === "assistant-cited");
    const unverified = branch.find((m) => m.id === "assistant-unverified");

    // The grounded answer keeps its source chip, and nothing else.
    expect(cited?.citations).toEqual([
      {
        id: 1,
        title: "Eiffel Tower",
        url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
        source: "Wikipedia",
        asOf: "2023",
      },
    ]);
    expect(cited?.verification).toBeUndefined();

    // The unconfirmed answer stays honestly flagged, with no spurious chip.
    expect(unverified?.verification).toEqual({ status: "unverified" });
    expect(unverified?.citations).toBeUndefined();
  });

});
