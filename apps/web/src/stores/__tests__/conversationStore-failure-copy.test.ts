// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What a person is told when browser storage fails them.
 *
 * The store has one notice slot, and it used to say the same sentence for every
 * failure: "Eco updated this conversation in memory, but browser storage could
 * not load messages for conversation 3f2a…". Beside an empty transcript that is
 * untrue (nothing was updated), it leaks a UUID at people, and it never once
 * said the real cause when the real cause was a full disk.
 *
 * These tests drive REAL rejections through the real store paths: the database
 * is the real (fake-indexeddb) one, and a single method is armed to reject the
 * way a browser would.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The one database method a test has armed to reject, if any. */
let armedFailure: { method: string; error: unknown } | null = null;

vi.mock("../../lib/db", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
  return {
    ...actual,
    async openEcoDB(options?: Parameters<typeof actual.openEcoDB>[0]) {
      const db = await actual.openEcoDB(options);
      // A pass-through to the REAL database. Everything the store does still
      // really happens; only the armed method rejects, so the code under test
      // (the message it picks) is never itself stubbed.
      return new Proxy(db, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (armedFailure && armedFailure.method === property) {
              return Promise.reject(armedFailure.error);
            }
            return (value as (...callArgs: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
});

const CONVERSATION_ID = "3f2a91c4-7b60-4d5e-9a11-8c0f2e6d4b73";
const MESSAGE_ID = "c81d4e2f-6a3b-4f90-b7c2-15ad9e0f3c48";

/** Anything shaped like a UUID has no business in copy shown to a person. */
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

async function loadStore() {
  vi.resetModules();
  const storeModule = await import("../conversationStore");
  await vi.waitFor(() => {
    expect(storeModule.useConversationStore.getState().hasHydrated).toBe(true);
  });
  // Hydration itself is not under test here; start each case from a clean slot.
  storeModule.useConversationStore.setState({ persistenceError: null });
  return storeModule;
}

function notice(store: { getState(): { persistenceError: string | null } }): string {
  const message = store.getState().persistenceError;
  expect(message).not.toBeNull();
  return message ?? "";
}

/**
 * Save a message with the write armed to reject. `makeError` receives the
 * freshly-loaded module so a case can throw that module's own
 * `DbOpenTimeoutError` — a class from an earlier module registry would fail
 * the `instanceof` the store actually uses.
 */
async function saveWithFailingWrite(
  makeError: (storeModule: typeof import("../conversationStore")) => unknown,
) {
  const storeModule = await loadStore();
  armedFailure = { method: "put", error: makeError(storeModule) };
  await storeModule.useConversationStore.getState().saveMessage({
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    parentId: null,
    role: "user",
    content: "does this survive?",
    createdAt: 1,
    status: "complete",
  });
  return storeModule.useConversationStore;
}

beforeEach(() => {
  armedFailure = null;
  localStorage.clear();
});

afterEach(() => {
  armedFailure = null;
  vi.restoreAllMocks();
});

describe("conversation persistence failure copy", () => {
  it("T1: a failed READ does not claim anything was saved, and carries no ids", async () => {
    const { useConversationStore } = await loadStore();
    armedFailure = { method: "get", error: new Error("read failed") };

    const restored = await useConversationStore
      .getState()
      .loadConversationMessages(CONVERSATION_ID);
    expect(restored).toEqual([]);

    const message = notice(useConversationStore);
    expect(message).toMatch(/could not load this conversation/i);
    // The lie the old copy told, standing next to an empty transcript.
    expect(message).not.toMatch(/updated this conversation in memory/i);
    expect(message).not.toMatch(/in memory/i);
    // ...and it reassures rather than implies loss.
    expect(message).toMatch(/nothing already saved is lost/i);
    expect(message).not.toContain(CONVERSATION_ID);
    expect(message).not.toMatch(UUID_SHAPE);
  });

  it("T2: a failed WRITE still says the words are in memory but unsaved, with no ids", async () => {
    const useConversationStore = await saveWithFailingWrite(() => new Error("write failed"));

    const message = notice(useConversationStore);
    expect(message).toMatch(/in memory/i);
    expect(message).toMatch(/could not save your last message/i);
    expect(message).toMatch(/export a copy/i);
    expect(message).not.toContain(MESSAGE_ID);
    expect(message).not.toContain(CONVERSATION_ID);
    expect(message).not.toMatch(UUID_SHAPE);
  });

  it("T3: a QuotaExceededError write says the device is out of space", async () => {
    const useConversationStore = await saveWithFailingWrite(
      () => new DOMException("quota", "QuotaExceededError"),
    );

    const message = notice(useConversationStore);
    expect(message).toMatch(/out of storage space/i);
    expect(message).toMatch(/free up space/i);
    expect(message).toMatch(/delete old conversations/i);
    // Not the download layer's copy: this is about conversations, not models.
    expect(message).not.toMatch(/model/i);
  });

  it("T3b: a READ that fails on quota is never reported as a failed save", async () => {
    const { useConversationStore } = await loadStore();
    armedFailure = { method: "get", error: new DOMException("quota", "QuotaExceededError") };

    await useConversationStore.getState().loadConversationMessages(CONVERSATION_ID);

    const message = notice(useConversationStore);
    // Running out of room is a write-side failure; saying "could not save" about a
    // read tells the person the wrong thing about their own data.
    expect(message).not.toMatch(/could not save/i);
    expect(message).toMatch(/could not load this conversation/i);
  });

  it("T4: an outdated build still wins its own message, ahead of the quota branch", async () => {
    const plain = await saveWithFailingWrite(() => new DOMException("upgrade", "VersionError"));
    expect(notice(plain)).toMatch(/updated in another tab/i);

    // A VersionError that ALSO looks like a quota failure (legacy code 22)
    // must still be told to reload — that is the thing they can act on.
    const both = await saveWithFailingWrite(() => {
      const ambiguous = new DOMException("upgrade", "VersionError");
      Object.defineProperty(ambiguous, "code", { value: 22 });
      return ambiguous;
    });
    const message = notice(both);
    expect(message).toMatch(/updated in another tab/i);
    expect(message).not.toMatch(/out of storage space/i);
  });

  it("T4: a blocked database open still wins its own message, ahead of the quota branch", async () => {
    const plain = await saveWithFailingWrite((storeModule) => new storeModule.DbOpenTimeoutError());
    expect(notice(plain)).toMatch(/another eco tab is holding storage open/i);

    // Same ambiguity, other direction: a blocked open wearing the quota name.
    const both = await saveWithFailingWrite((storeModule) => {
      const ambiguous = new storeModule.DbOpenTimeoutError();
      ambiguous.name = "QuotaExceededError";
      return ambiguous;
    });
    const message = notice(both);
    expect(message).toMatch(/another eco tab is holding storage open/i);
    expect(message).not.toMatch(/out of storage space/i);
  });

  it("T5: a later failure does not overwrite an unresolved notice, but running out of space does", async () => {
    const useConversationStore = await saveWithFailingWrite(() => new Error("write failed"));
    const first = notice(useConversationStore);

    // A second, different failure must not rewrite the notice out from under them.
    armedFailure = { method: "get", error: new Error("read failed") };
    await useConversationStore.getState().loadConversationMessages(CONVERSATION_ID);
    expect(useConversationStore.getState().persistenceError).toBe(first);

    // Out of space is the one cause a person can act on, so it takes the slot.
    armedFailure = { method: "put", error: new DOMException("quota", "QuotaExceededError") };
    await useConversationStore.getState().saveMessage({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      parentId: null,
      role: "user",
      content: "and now the disk is full",
      createdAt: 2,
      status: "complete",
    });
    const outOfSpace = notice(useConversationStore);
    expect(outOfSpace).toMatch(/out of storage space/i);

    // ...and nothing vaguer displaces it afterwards.
    armedFailure = { method: "get", error: new Error("read failed") };
    await useConversationStore.getState().loadConversationMessages(CONVERSATION_ID);
    expect(useConversationStore.getState().persistenceError).toBe(outOfSpace);

    // Dismissing frees the slot again.
    useConversationStore.getState().clearPersistenceError();
    armedFailure = { method: "get", error: new Error("read failed") };
    await useConversationStore.getState().loadConversationMessages(CONVERSATION_ID);
    expect(useConversationStore.getState().persistenceError).toMatch(
      /could not load this conversation/i,
    );
  });
});
