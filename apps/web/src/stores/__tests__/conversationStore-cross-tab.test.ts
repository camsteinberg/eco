// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock BroadcastChannel — shared registry, delivers to OTHER instances only
// (never self), matching the real API. Lets us observe the store's outgoing
// cross-tab broadcasts and stand in for "another tab".
// ---------------------------------------------------------------------------

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  name: string;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) return;
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && inst.name === this.name && !inst.closed && inst.onmessage) {
        inst.onmessage({ data });
      }
    }
  }

  close(): void {
    this.closed = true;
    const idx = MockBroadcastChannel.instances.indexOf(this);
    if (idx >= 0) MockBroadcastChannel.instances.splice(idx, 1);
  }
}

const CONV_ID = "conv-shared";

async function seedDivergedBranches() {
  const { openEcoDB } = await import("../../lib/db");
  const db = await openEcoDB();
  // A conversation whose persisted leaf is branch B (another tab advanced it).
  await db.put("conversations", {
    id: CONV_ID,
    title: "Shared",
    createdAt: 1000,
    updatedAt: 3000,
    activeLeafId: "leaf-b",
    preview: "",
    pinnedAt: null,
  });
  // root, then two sibling leaves off it (branch A and branch B).
  await db.put("messages", {
    id: "root", conversationId: CONV_ID, parentId: null, role: "user",
    content: "root", createdAt: 1000,
  });
  await db.put("messages", {
    id: "leaf-a", conversationId: CONV_ID, parentId: "root", role: "assistant",
    content: "branch A turn", createdAt: 2000,
  });
  await db.put("messages", {
    id: "leaf-b", conversationId: CONV_ID, parentId: "root", role: "assistant",
    content: "branch B turn", createdAt: 3000,
  });
  db.close();
}

async function resetDb() {
  const { openEcoDB } = await import("../../lib/db");
  const db = await openEcoDB();
  for (const store of ["conversations", "messages"] as const) {
    const tx = db.transaction(store, "readwrite");
    await tx.store.clear();
    await tx.done;
  }
  db.close();
}

async function waitForHydration(store: { getState(): { hasHydrated: boolean } }) {
  for (let i = 0; i < 50; i += 1) {
    if (store.getState().hasHydrated) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("store did not hydrate");
}

beforeEach(async () => {
  localStorage.clear();
  MockBroadcastChannel.instances = [];
  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);
  vi.resetModules();
  await resetDb();
});

afterEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation store — cross-tab sync (orphaned-turn fix)", () => {
  it("a remote leaf update flips a stale in-memory leaf so the branch converges", async () => {
    await seedDivergedBranches();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    // Simulate THIS tab holding a stale leaf (it advanced to branch A while
    // another tab advanced the persisted conversation to branch B).
    useConversationStore.setState((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === CONV_ID ? { ...c, activeLeafId: "leaf-a" } : c,
      ),
    }));

    // Before the remote update: the stale in-memory leaf wins, so the tab is
    // on branch A and branch B's turn is unreachable — the orphan.
    const staleBranch = await useConversationStore.getState().loadConversationMessages(CONV_ID);
    expect(staleBranch.map((m) => m.id)).toEqual(["root", "leaf-a"]);

    // Receiving the other tab's broadcast advances this tab's in-memory leaf.
    useConversationStore.getState().applyRemoteConversationUpdate(CONV_ID, "leaf-b");
    expect(
      useConversationStore.getState().conversations.find((c) => c.id === CONV_ID)?.activeLeafId,
    ).toBe("leaf-b");

    // Now the tab converges to branch B — branch A becomes the navigable
    // sibling, and no turn is orphaned.
    const converged = await useConversationStore.getState().loadConversationMessages(CONV_ID);
    expect(converged.map((m) => m.id)).toEqual(["root", "leaf-b"]);
  });

  it("applyRemoteConversationUpdate is a no-op for unknown conversations and unchanged leaves", async () => {
    await seedDivergedBranches();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    const before = useConversationStore.getState().conversations;
    // Unknown conversation — nothing changes.
    useConversationStore.getState().applyRemoteConversationUpdate("nope", "leaf-x");
    expect(useConversationStore.getState().conversations).toBe(before);
    // Same leaf — no state churn (would needlessly re-run the reload effect).
    useConversationStore.getState().applyRemoteConversationUpdate(CONV_ID, "leaf-b");
    expect(useConversationStore.getState().conversations).toBe(before);
  });

  it("updateConversation broadcasts a leaf advance to other tabs, but not a title-only edit", async () => {
    await seedDivergedBranches();
    const { useConversationStore } = await import("../conversationStore");
    await waitForHydration(useConversationStore);

    // Stand in for another tab listening on the same channel.
    const otherTab = new MockBroadcastChannel("eco-conversation-sync");
    const received: unknown[] = [];
    otherTab.onmessage = (e) => received.push(e.data);

    useConversationStore.getState().updateConversation(CONV_ID, { activeLeafId: "leaf-a" });
    // The DB write + broadcast happen in a persistence task; let it settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toContainEqual({
      type: "conversation-updated",
      conversationId: CONV_ID,
      leafId: "leaf-a",
    });

    received.length = 0;
    useConversationStore.getState().updateConversation(CONV_ID, { title: "Renamed" });
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([]);
  });
});
