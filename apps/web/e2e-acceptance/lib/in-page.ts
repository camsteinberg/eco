// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Functions that run INSIDE the page, not in the lane.
 *
 * Every one of them is self-contained: no imports, no module state and nothing
 * captured from outside its own body, because it travels to the page as
 * source text. Playwright sends it through `page.evaluate(fn, arg)` /
 * `page.waitForFunction(fn, arg)`, which serialise `fn.toString()`; a driver
 * without Playwright (raw WebDriver) sends the same `toString()` to its
 * execute endpoint. That is why they live here rather than inline in the
 * walk: two drivers, one reading of the page.
 *
 * Nothing here may import the walk (`./walk`) or the spec.
 */

import type { GenerationReceipt } from "../../src/local-ai/lifecycle/generation-receipt";

/** The newest generation's id, or null before any generation has run. */
export function newestGenerationIdInPage(): string | null {
  return window.__ecoPerf?.receipts(1)[0]?.generationId ?? null;
}

/** The catalog id the runtime holds right now, or null. */
export function activeModelIdInPage(): string | null {
  return window.__ecoPerf?.activeModelId() ?? null;
}

/** No receipt is still being hashed, so `receipts()` describes every finished turn. */
export function receiptsSettledInPage(): boolean {
  return (window.__ecoPerf?.pendingReceipts() ?? 1) === 0;
}

/** A generation newer than `previousId` has recorded its receipt. */
export function newGenerationStartedInPage(previousId: string | null): boolean {
  const newest = window.__ecoPerf?.receipts(1)[0];
  return newest !== undefined && newest.generationId !== previousId;
}

/**
 * Every receipt of the newest generation, in execution order — or none, when
 * the newest generation is still `previousId` (a tool answered the turn).
 */
export function receiptsOfNewGenerationInPage(previousId: string | null): GenerationReceipt[] {
  const all = window.__ecoPerf?.receipts() ?? [];
  const newest = all[0];
  if (!newest || newest.generationId === previousId) return [];
  return all.filter((r) => r.generationId === newest.generationId).reverse();
}

/**
 * The last user/assistant pair of the newest conversation, from the app's own
 * storage (IndexedDB `eco-chat`), or null when nothing is stored.
 */
export async function readLatestExchangeInPage(): Promise<
  { user?: string; assistant?: string } | null
> {
  type Row = {
    role: string;
    content: string;
    createdAt: number;
    conversationId: string;
  };
  const open = (): Promise<IDBDatabase | null> =>
    new Promise((resolve) => {
      const request = indexedDB.open("eco-chat");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        // The database does not exist yet; abandon rather than create one.
        request.transaction?.abort();
        resolve(null);
      };
    });
  const db = await open();
  if (!db) return null;
  try {
    if (!db.objectStoreNames.contains("messages")) return null;
    const rows = await new Promise<Row[]>((resolve) => {
      const tx = db.transaction("messages", "readonly");
      const req = tx.objectStore("messages").getAll();
      req.onsuccess = () => resolve(req.result as Row[]);
      req.onerror = () => resolve([]);
    });
    if (rows.length === 0) return null;
    const newest = rows.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    const inConversation = rows
      .filter((r) => r.conversationId === newest.conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const assistant = [...inConversation].reverse().find((r) => r.role === "assistant");
    const user = [...inConversation].reverse().find((r) => r.role === "user");
    const result: { user?: string; assistant?: string } = {};
    if (user) result.user = user.content;
    if (assistant) result.assistant = assistant.content;
    return result;
  } finally {
    db.close();
  }
}

/** The service worker has captured this page's chat shell (`eco-shell-v1`, see `public/sw.js`). */
export async function shellCapturedInPage(): Promise<boolean> {
  const cache = await caches.open("eco-shell-v1");
  return (await cache.match(location.pathname)) !== undefined;
}
