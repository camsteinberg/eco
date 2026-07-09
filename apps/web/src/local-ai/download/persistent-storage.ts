// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Persistent-storage request for model weights.
 *
 * Chrome treats origin storage as "best-effort" by default and evicts it
 * under disk pressure — observed for real on 2026-06-11: every multi-GB
 * model cache on this origin was wiped at ~872MB free disk, forcing full
 * re-downloads. `navigator.storage.persist()` flips the origin's bucket to
 * persistent, exempting it from automatic eviction (the user can still clear
 * it manually — and Eco's own delete flows are unaffected).
 *
 * Requested ONCE per session, fired at the start of a model download — the
 * moment of explicit user intent to store large weights, which is also when
 * browsers are most willing to grant. Best-effort by design: a denial or a
 * missing API degrades to today's behavior, never blocks or fails the
 * download.
 *
 * Privacy: persist() stores nothing new and sends nothing anywhere. It only
 * asks the browser not to auto-evict what the user already chose to keep.
 */

import { logger } from '../../lib/logger';

type StorageManagerLike = {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
};

export type PersistentStorageOutcome =
  /** The origin's storage is persistent (already was, or the request was granted). */
  | 'persistent'
  /** The browser declined the request — storage stays best-effort. */
  | 'denied'
  /** No Storage API in this environment (or it threw) — nothing to request. */
  | 'unavailable';

let outcomeOnce: Promise<PersistentStorageOutcome> | null = null;

function defaultStorageManager(): StorageManagerLike | undefined {
  return typeof navigator !== 'undefined'
    ? (navigator as { storage?: StorageManagerLike }).storage
    : undefined;
}

/**
 * Ask the browser to make this origin's storage persistent. Memoized for the
 * session — concurrent/repeated downloads share one request, and a settled
 * outcome is never re-prompted.
 */
export function requestPersistentStorage(
  storageManager: StorageManagerLike | undefined = defaultStorageManager(),
): Promise<PersistentStorageOutcome> {
  outcomeOnce ??= resolveOutcome(storageManager).then((outcome) => {
    if (process.env.NODE_ENV !== 'production') {
      logger.info('[eco/persistent-storage]', outcome);
    }
    return outcome;
  });
  return outcomeOnce;
}

async function resolveOutcome(
  storageManager: StorageManagerLike | undefined,
): Promise<PersistentStorageOutcome> {
  if (typeof storageManager?.persist !== 'function') {
    return 'unavailable';
  }
  try {
    if (typeof storageManager.persisted === 'function' && (await storageManager.persisted())) {
      return 'persistent';
    }
    return (await storageManager.persist()) ? 'persistent' : 'denied';
  } catch {
    // A throwing Storage API behaves like a missing one.
    return 'unavailable';
  }
}

/** Test-only: clear the memoized outcome between tests. */
export function _resetPersistentStorageForTesting(): void {
  outcomeOnce = null;
}
