// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Clears stale local-runtime state on app boot so existing production users
 * who landed in a stuck state recover automatically. Runs exactly once from
 * the `AppShell` mount; must never crash app boot under any localStorage
 * shape, even fully corrupted entries.
 *
 * Two classes of state get healed:
 *
 *   1. Heavy-work leases (`eco-local-heavy-work-owner-v1`) — already
 *      self-expire via `expiresAt`, but calling `getActiveLocalHeavyWorkLease`
 *      is what triggers the clear. Idempotent.
 *
 *   2. Download in-progress markers (`eco-model-download-in-progress:*`) —
 *      these do NOT expire on their own. If a tab crashed mid-download, the
 *      marker stays in localStorage forever. Anything older than 5 minutes
 *      is by definition stale because real downloads write the completion
 *      marker (and clear the in-progress marker) when they finish.
 */

'use client';

import { getActiveLocalHeavyWorkLease } from './local-heavy-work-owner';
import { safeStorage } from './local-storage';

/** Inlined from the now-deleted lib/model-download.ts to avoid pulling in the legacy module. */
const MODEL_DOWNLOAD_IN_PROGRESS_PREFIX = 'eco-model-download-in-progress:';

const STALE_DOWNLOAD_MARKER_MS = 5 * 60 * 1000;

export function runLocalRuntimeSelfHeal(now: number = Date.now()): void {
  if (typeof window === 'undefined') return;
  try {
    clearStaleHeavyWorkLease();
  } catch {
    // Self-heal must never crash app boot.
  }
  try {
    clearStaleDownloadInProgressMarkers(now);
  } catch {
    // Same — failing here would block first paint.
  }
}

function clearStaleHeavyWorkLease(): void {
  // getActiveLocalHeavyWorkLease() clears expired leases as a side effect
  // (see local-heavy-work-owner.ts). Calling it on boot is the contract.
  getActiveLocalHeavyWorkLease();
}

function clearStaleDownloadInProgressMarkers(now: number): void {
  if (typeof localStorage === 'undefined') return;

  // Walk the snapshot of keys, not localStorage live, so removals don't
  // shift indexes mid-loop. safeStorage.keys() already returns a snapshot.
  const keysToCheck = safeStorage
    .keys()
    .filter((key) => key.startsWith(MODEL_DOWNLOAD_IN_PROGRESS_PREFIX));

  for (const key of keysToCheck) {
    const raw = safeStorage.get(key);
    if (!raw) continue;

    let startedAt: number | null = null;
    try {
      const parsed = JSON.parse(raw) as { startedAt?: unknown };
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.startedAt === 'number') {
        startedAt = parsed.startedAt;
      }
    } catch {
      // Corrupt marker — treat as stale.
      startedAt = null;
    }

    // Stale if older than threshold OR unreadable (no recoverable startedAt).
    const isStale = startedAt === null || now - startedAt > STALE_DOWNLOAD_MARKER_MS;
    if (!isStale) continue;

    // Advisory cleanup only — safeStorage swallows storage failures.
    safeStorage.remove(key);
  }
}
