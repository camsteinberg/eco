// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Expired-row sweep for the Better Auth tables.
//
// Better Auth validates a session's `expires_at` on every request, so an expired
// row is never honoured — but nothing deletes it. Left alone, the `session`
// table accumulates a permanent record of every sign-in a user ever made,
// including its IP address and user agent, and the `verification` table keeps
// spent password-reset and magic-link tokens forever. Neither is data the
// product needs after the row stops being usable, and holding it is a breach
// blast-radius we chose by omission rather than on purpose.
//
// The sweep also enforces an ABSOLUTE session lifetime. Better Auth's
// `updateAge` slides `expires_at` forward on activity, so a session that is used
// at least once a month never expires on its own; a stolen token stays valid
// indefinitely. The absolute cap puts a ceiling on that.

import { lt, or } from 'drizzle-orm'
import { session, verification } from '../db/schema/auth.js'
import type { Db } from '../db/index.js'

/**
 * The longest a session may live from creation, regardless of activity.
 * CHOSEN 2026-09-13 (auth security review), not measured.
 */
export const SESSION_ABSOLUTE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export type SweepOptions = {
  /** "Now" for the comparison; injected so the sweep is testable. */
  now: Date
  /** Absolute session lifetime from `created_at`. */
  absoluteMaxAgeMs: number
}

export type SweepResult = {
  sessions: number
  verifications: number
}

/**
 * Delete expired sessions (and sessions past the absolute lifetime) and expired
 * verification rows. One statement per table. Returns the rows removed by each.
 */
export async function sweepAuthRows(
  db: Db,
  { now, absoluteMaxAgeMs }: SweepOptions,
): Promise<SweepResult> {
  const absoluteCutoff = new Date(now.getTime() - absoluteMaxAgeMs)

  // `returning()` takes no selection here: `Db` is a union of the postgres-js
  // and neon-serverless drizzle types and the column-selecting overload does not
  // survive the union. The rows are discarded either way — only the count is
  // used.
  const deletedSessions = await db
    .delete(session)
    .where(or(lt(session.expiresAt, now), lt(session.createdAt, absoluteCutoff)))
    .returning()

  const deletedVerifications = await db
    .delete(verification)
    .where(lt(verification.expiresAt, now))
    .returning()

  return {
    sessions: deletedSessions.length,
    verifications: deletedVerifications.length,
  }
}
