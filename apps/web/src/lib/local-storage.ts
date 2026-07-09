// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Safe `localStorage` wrapper.
 *
 * Every browser `localStorage` access in the web app routes through this
 * module so that two failure modes can never crash a caller:
 *
 *   1. Server-side rendering — there is no `window`/`localStorage`.
 *   2. Restricted/private-mode storage — access throws `SecurityError` or a
 *      `QuotaExceededError`.
 *
 * Semantics match raw `localStorage` exactly on the happy path:
 *   - `get(key)` returns the stored string or `null` on a miss (never
 *     `undefined`), so existing `=== null` / falsy checks are unchanged.
 *   - `set(key, value)` stores the value.
 *   - `remove(key)` removes the key.
 *   - `keys()` returns a snapshot array of all keys (replacing manual
 *     `localStorage.length` / `localStorage.key(i)` iteration).
 *
 * On SSR or any thrown error, reads degrade to `null`/`[]` and writes/removes
 * become no-ops. Failures are recorded as low-noise `debug` log entries rather
 * than thrown, matching the previous hand-rolled try/catch behavior of callers
 * (which swallowed errors silently).
 */

import { logger } from "./logger";

function getStore(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    // Accessing `window.localStorage` itself can throw in some sandboxed
    // contexts (e.g. cross-origin iframes, disabled storage).
    return null;
  }
}

export const safeStorage = {
  /** Read a value. Returns the stored string, or `null` on miss/SSR/error. */
  get(key: string): string | null {
    const store = getStore();
    if (!store) return null;
    try {
      return store.getItem(key);
    } catch (error) {
      logger.debug("[safeStorage] get failed", key, error);
      return null;
    }
  },

  /** Write a value. No-op on SSR or when storage is unavailable. */
  set(key: string, value: string): void {
    const store = getStore();
    if (!store) return;
    try {
      store.setItem(key, value);
    } catch (error) {
      logger.debug("[safeStorage] set failed", key, error);
    }
  },

  /** Remove a key. No-op on SSR or when storage is unavailable. */
  remove(key: string): void {
    const store = getStore();
    if (!store) return;
    try {
      store.removeItem(key);
    } catch (error) {
      logger.debug("[safeStorage] remove failed", key, error);
    }
  },

  /** Snapshot of all keys currently in storage. Empty on SSR/error. */
  keys(): string[] {
    const store = getStore();
    if (!store) return [];
    try {
      const result: string[] = [];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (key !== null) {
          result.push(key);
        }
      }
      return result;
    } catch (error) {
      logger.debug("[safeStorage] keys failed", error);
      return [];
    }
  },
} as const;

/**
 * Well-known static storage keys.
 *
 * Dynamic keys (e.g. `eco-conversation-${id}`, `eco-history-${id}`) are not
 * listed here — `safeStorage` accepts any string. Keys that already live as
 * exported constants close to their single owning module (e.g. the chat
 * workspace keys in `chat-workspace-storage.ts`, the local-AI ledger key) keep
 * those definitions; this registry centralizes the cross-referenced ones.
 */
export const STORAGE_KEYS = {
  /** Theme preference (`light` | `dark` | `system`). */
  THEME: "eco-theme",
  /** Appearance font-size preference. */
  FONT_SIZE: "eco-font-size",
  /** Onboarding store persisted envelope. */
  ONBOARDING: "eco-onboarding",
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
