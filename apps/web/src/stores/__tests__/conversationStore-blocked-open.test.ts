// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A tab on an older build that never closes its connection blocks this tab's
// open forever. Every write chained on that open would sit in memory and die
// with the tab — silently. The store must give up and tell the person.
vi.mock("../../lib/db", async () => {
  const actual = await vi.importActual<typeof import("../../lib/db")>("../../lib/db");
  return {
    ...actual,
    openEcoDB: () => new Promise<never>(() => {}),
  };
});

describe("conversation store with a blocked IndexedDB open", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces a persistence error instead of hanging forever", async () => {
    const { useConversationStore, DB_OPEN_TIMEOUT_MS } = await import("../conversationStore");

    await vi.advanceTimersByTimeAsync(3000);
    // UI is released after the hydration timeout…
    expect(useConversationStore.getState().hasHydrated).toBe(true);

    await vi.advanceTimersByTimeAsync(DB_OPEN_TIMEOUT_MS);
    // …and once the open is declared dead, the person is told why saves fail.
    expect(useConversationStore.getState().persistenceError).toMatch(/another eco tab/i);
  });
});
