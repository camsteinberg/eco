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

  it("keeps a deliberately started new chat empty across a reload", async () => {
    await seedConversations();

    const { ACTIVE_CONVERSATION_STORAGE_KEY } = await import(
      "../../lib/chat-workspace-storage"
    );
    localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, "conv-newer");

    vi.resetModules();
    const first = await import("../conversationStore");
    await waitForHydration(first.useConversationStore);
    expect(first.useConversationStore.getState().activeConversationId).toBe("conv-newer");

    // "New chat" — the user leaves the previous thread on purpose, and has not
    // typed anything yet.
    first.useConversationStore.getState().setActive(null);

    // Reload the tab.
    vi.resetModules();
    const reloaded = await import("../conversationStore");
    await waitForHydration(reloaded.useConversationStore);

    const state = reloaded.useConversationStore.getState();
    // The header reads the active conversation's title, so re-adopting the
    // previous thread here is what surfaces its title on the new chat.
    const activeTitle = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    )?.title;

    expect(state.activeConversationId).toBeNull();
    expect(activeTitle).toBeUndefined();
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

  it("restores the truncation notice and its Continue affordance on reload", async () => {
    const { openEcoDB } = await import("../../lib/db");
    const db = await openEcoDB();

    await db.put("conversations", {
      id: "conv-truncated",
      title: "Truncated conversation",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: "assistant-complete",
      preview: "truncated preview",
      pinnedAt: null,
    });

    await db.put("messages", {
      id: "user-long",
      conversationId: "conv-truncated",
      parentId: null,
      role: "user",
      content: "Explain the whole history of the Roman Republic.",
      createdAt: 1,
    });

    await db.put("messages", {
      id: "assistant-truncated",
      conversationId: "conv-truncated",
      parentId: "user-long",
      role: "assistant",
      content: "The Republic began in 509 BC and",
      createdAt: 2,
      status: "complete",
      inferenceMethod: "local",
      possiblyTruncated: true,
      localCompletionTokens: 256,
      localMaxTokens: 256,
    });

    await db.put("messages", {
      id: "user-short",
      conversationId: "conv-truncated",
      parentId: "assistant-truncated",
      role: "user",
      content: "Thanks.",
      createdAt: 3,
    });

    await db.put("messages", {
      id: "assistant-complete",
      conversationId: "conv-truncated",
      parentId: "user-short",
      role: "assistant",
      content: "You're welcome.",
      createdAt: 4,
      status: "complete",
      inferenceMethod: "local",
      possiblyTruncated: false,
      localCompletionTokens: 40,
      localMaxTokens: 256,
    });

    db.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    useConversationStore.setState({
      conversations: [
        {
          id: "conv-truncated",
          title: "Truncated conversation",
          createdAt: 1,
          updatedAt: 2,
          activeLeafId: "assistant-complete",
          preview: "truncated preview",
          pinnedAt: null,
        },
      ],
      activeConversationId: "conv-truncated",
    });

    const branch = await useConversationStore
      .getState()
      .loadConversationMessages("conv-truncated");

    const truncated = branch.find((m) => m.id === "assistant-truncated");
    const complete = branch.find((m) => m.id === "assistant-complete");

    // The reply that hit its limit keeps the flag the notice + Continue render off,
    // along with the counts that justify it.
    expect(truncated?.possiblyTruncated).toBe(true);
    expect(truncated?.localCompletionTokens).toBe(256);
    expect(truncated?.localMaxTokens).toBe(256);

    // A reply that finished on its own restores explicitly unflagged.
    expect(complete?.possiblyTruncated).toBe(false);
    expect(complete?.localCompletionTokens).toBe(40);
    expect(complete?.localMaxTokens).toBe(256);
  });

  it("leaves a reply saved before the truncation receipt existed unflagged, not falsely complete", async () => {
    const { openEcoDB } = await import("../../lib/db");
    const db = await openEcoDB();

    await db.put("conversations", {
      id: "conv-legacy",
      title: "Legacy conversation",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: "assistant-legacy",
      preview: "legacy preview",
      pinnedAt: null,
    });

    await db.put("messages", {
      id: "user-legacy",
      conversationId: "conv-legacy",
      parentId: null,
      role: "user",
      content: "An older question.",
      createdAt: 1,
    });

    await db.put("messages", {
      id: "assistant-legacy",
      conversationId: "conv-legacy",
      parentId: "user-legacy",
      role: "assistant",
      content: "An older answer, saved before these fields were persisted.",
      createdAt: 2,
      status: "complete",
    });

    db.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    useConversationStore.setState({
      conversations: [
        {
          id: "conv-legacy",
          title: "Legacy conversation",
          createdAt: 1,
          updatedAt: 2,
          activeLeafId: "assistant-legacy",
          preview: "legacy preview",
          pinnedAt: null,
        },
      ],
      activeConversationId: "conv-legacy",
    });

    const branch = await useConversationStore
      .getState()
      .loadConversationMessages("conv-legacy");

    const legacy = branch.find((m) => m.id === "assistant-legacy");

    // Absence must survive as absence: downstream guards fail open on undefined,
    // so a restored `false`/`0` would be a claim the record never made.
    expect(legacy?.possiblyTruncated).toBeUndefined();
    expect(legacy?.localCompletionTokens).toBeUndefined();
    expect(legacy?.localMaxTokens).toBeUndefined();
  });

  it("marks a reply a crash left mid-stream as interrupted on reload", async () => {
    const { openEcoDB } = await import("../../lib/db");
    const db = await openEcoDB();

    await db.put("conversations", {
      id: "conv-crashed",
      title: "Crashed mid-reply",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: "assistant-stuck",
      preview: "crashed preview",
      pinnedAt: null,
    });

    await db.put("messages", {
      id: "user-asked",
      conversationId: "conv-crashed",
      parentId: null,
      role: "user",
      content: "Explain photosynthesis.",
      createdAt: 1,
    });

    // A reply the crash caught before it finalized: persisted with its live
    // "streaming" status and no content (no tokens landed before the crash).
    await db.put("messages", {
      id: "assistant-stuck",
      conversationId: "conv-crashed",
      parentId: "user-asked",
      role: "assistant",
      content: "",
      createdAt: 2,
      status: "streaming",
    });

    db.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    useConversationStore.setState({
      conversations: [
        {
          id: "conv-crashed",
          title: "Crashed mid-reply",
          createdAt: 1,
          updatedAt: 2,
          activeLeafId: "assistant-stuck",
          preview: "crashed preview",
          pinnedAt: null,
        },
      ],
      activeConversationId: "conv-crashed",
    });

    const branch = await useConversationStore
      .getState()
      .loadConversationMessages("conv-crashed");

    const stuck = branch.find((m) => m.id === "assistant-stuck");
    // No longer a bare, forever-streaming bubble: it restores as a finished but
    // interrupted reply, with the marker + Try again.
    expect(stuck?.status).toBe("complete");
    expect(stuck?.streamInterrupted).toBe(true);
    expect(stuck?.interruptedReason).toBe("restore-detected");

    // The user turn is left exactly as stored.
    const asked = branch.find((m) => m.id === "user-asked");
    expect(asked?.streamInterrupted).toBeUndefined();
  });

  it("round-trips a persisted interruptedReason unchanged for a finished reply", async () => {
    const { openEcoDB } = await import("../../lib/db");
    const db = await openEcoDB();

    await db.put("conversations", {
      id: "conv-stopped",
      title: "User-stopped reply",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: "assistant-stopped",
      preview: "stopped preview",
      pinnedAt: null,
    });

    await db.put("messages", {
      id: "user-stopped",
      conversationId: "conv-stopped",
      parentId: null,
      role: "user",
      content: "Write a long essay.",
      createdAt: 1,
    });

    // A reply the user stopped: already finalized (complete + interrupted) with
    // its reason persisted. The restore sweep must leave it exactly as stored.
    await db.put("messages", {
      id: "assistant-stopped",
      conversationId: "conv-stopped",
      parentId: "user-stopped",
      role: "assistant",
      content: "Here is the start of the essay",
      createdAt: 2,
      status: "complete",
      streamInterrupted: true,
      interruptedReason: "user-stop",
    });

    db.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    useConversationStore.setState({
      conversations: [
        {
          id: "conv-stopped",
          title: "User-stopped reply",
          createdAt: 1,
          updatedAt: 2,
          activeLeafId: "assistant-stopped",
          preview: "stopped preview",
          pinnedAt: null,
        },
      ],
      activeConversationId: "conv-stopped",
    });

    const branch = await useConversationStore
      .getState()
      .loadConversationMessages("conv-stopped");

    const stopped = branch.find((m) => m.id === "assistant-stopped");
    expect(stopped?.streamInterrupted).toBe(true);
    expect(stopped?.interruptedReason).toBe("user-stop");
    expect(stopped?.content).toBe("Here is the start of the essay");
  });

});
