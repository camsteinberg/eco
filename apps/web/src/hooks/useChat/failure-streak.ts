// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Module-scoped consecutive-failure counter for on-device generation, keyed by
 * the resolved model id. Lets `useChat` escalate the error copy on a SECOND
 * back-to-back failure of the same model (the first-failure copy invites a
 * retry; the second admits the model may be the problem and nudges a lighter
 * one). Any success — or a switch to a different model — resets the streak.
 *
 * Deliberately module-scoped rather than store state: it is transient UI signal
 * that must not persist across reloads or leak into the conversation record.
 */

let streak: { modelKey: string; count: number } | null = null;

/**
 * Record a generation failure for `modelKey`. Increments when the previous
 * failure was for the same model; otherwise starts a fresh streak at 1. Returns
 * the new consecutive-failure count.
 */
export function recordLocalGenerationFailure(modelKey: string): number {
  if (streak && streak.modelKey === modelKey) {
    streak.count += 1;
  } else {
    streak = { modelKey, count: 1 };
  }
  return streak.count;
}

/** Clear the streak — call on any successful generation. */
export function resetLocalGenerationFailureStreak(): void {
  streak = null;
}

/** Test-only: reset module state between cases. */
export function _resetFailureStreakForTesting(): void {
  streak = null;
}
