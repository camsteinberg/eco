// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hydration reads IndexedDB asynchronously, and the store deliberately releases
 * the UI after 3 seconds even when that read has not come back yet. So a user
 * can start a conversation while the read is still in flight — after which
 * hydration must not overwrite them with the snapshot it took beforehand.
 *
 * The gate below parks the conversations read so that window is deterministic.
 */
const conversationsRead = vi.hoisted(() => {
  let release = () => {};
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { parked, release: () => release() };
});

vi.mock("../../lib/db", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");

  return {
    ...actual,
    openEcoDB: async () => {
      const db = await actual.openEcoDB();

      return new Proxy(db, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== "function") {
            return value;
          }

          const method = value.bind(target) as (
            ...args: readonly unknown[]
          ) => unknown;
          if (property !== "getAllFromIndex") {
            return method;
          }

          return async (...args: readonly unknown[]) => {
            const rows = await method(...args);
            if (args[0] === "conversations") {
              await conversationsRead.parked;
            }
            return rows;
          };
        },
      });
    },
  };
});

async function resetConversationDb() {
  const { openEcoDB } = await vi.importActual<typeof import("../../lib/db")>(
    "../../lib/db",
  );
  const db = await openEcoDB();

  const conversationTx = db.transaction("conversations", "readwrite");
  await conversationTx.store.clear();
  await conversationTx.done;

  db.close();
}

describe("conversation store hydration race", () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    await resetConversationDb();
  });

  afterEach(async () => {
    localStorage.clear();
    await resetConversationDb();
  });

  it("keeps a conversation started while the hydration read was still in flight", async () => {
    const { openEcoDB } = await vi.importActual<typeof import("../../lib/db")>(
      "../../lib/db",
    );
    const seed = await openEcoDB();
    await seed.put("conversations", {
      id: "conv-prior",
      title: "Prior conversation",
      createdAt: 1,
      updatedAt: 2,
      activeLeafId: null,
      preview: "prior",
      pinnedAt: null,
    });
    seed.close();

    vi.resetModules();
    const { useConversationStore } = await import("../conversationStore");

    // Hydration is now parked inside the conversations read.
    await new Promise((resolve) => setTimeout(resolve, 10));

    useConversationStore.getState().addConversation({
      id: "conv-new",
      title: "Fresh question",
      createdAt: 10,
      updatedAt: 10,
      activeLeafId: null,
      preview: "fresh",
      pinnedAt: null,
    });

    conversationsRead.release();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (useConversationStore.getState().hasHydrated) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const state = useConversationStore.getState();
    const activeTitle = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    )?.title;

    // The header reads the active conversation's title, so being repointed at
    // the older thread here is what puts its title on the new conversation.
    expect(state.activeConversationId).toBe("conv-new");
    expect(activeTitle).toBe("Fresh question");
    expect(state.conversations.map((conversation) => conversation.id)).toContain(
      "conv-prior",
    );
  });
});
