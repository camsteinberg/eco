// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { eq, and, gt } from 'drizzle-orm'
import { users } from '../db/schema/users.js'
import { session as sessionTable, user as userTable } from '../db/schema/auth.js'
import type { Db } from '../db/index.js'
import type { AuthUser, SubscriptionTier } from './types/auth.js'

// Note: the former bearer-token verifier (`createApiKeyVerifier`) was removed
// pre-launch (security-review 2026-07-03, M4). The v1.0 web app authenticates by
// session cookie only. The `api_keys` schema/table is retained for now — its
// drop is a post-launch migration.
export function createSessionCookieVerifier(db: Db) {
  return async (cookieValue: string): Promise<AuthUser | null> => {
    if (!cookieValue) return null

    // Better Auth session cookies are formatted as "token.signature" and may
    // be URL-encoded.  The database stores only the token portion.
    let decoded: string
    try {
      decoded = decodeURIComponent(cookieValue)
    } catch {
      return null
    }
    const token = decoded.split('.')[0]
    if (!token) return null

    const rows = await db
      .select({
        userId: sessionTable.userId,
        email: userTable.email,
        name: userTable.name,
      })
      .from(sessionTable)
      .innerJoin(userTable, eq(sessionTable.userId, userTable.id))
      .where(
        and(
          eq(sessionTable.token, token),
          gt(sessionTable.expiresAt, new Date()),
        ),
      )

    const row = rows[0]
    if (!row) return null

    // Better Auth's user table doesn't have subscriptionTier.
    // Look up the app users table for subscription info and stable legacy ids
    // if available.
    let appUserId = row.userId
    let resolvedName = row.name ?? null
    let subscriptionTier: SubscriptionTier = 'free'
    try {
      const appUserRows = await db
        .select({ id: users.id, name: users.name, subscriptionTier: users.subscriptionTier })
        .from(users)
        .where(eq(users.email, row.email))
        .limit(1)

      if (appUserRows[0]?.id) {
        appUserId = appUserRows[0].id
      }
      if (appUserRows[0]?.name) {
        resolvedName = appUserRows[0].name
      }
      if (appUserRows[0]?.subscriptionTier) {
        subscriptionTier = appUserRows[0].subscriptionTier as SubscriptionTier
      }
    } catch {
      // If the users table lookup fails, default to free tier
    }

    return {
      id: appUserId,
      email: row.email,
      name: resolvedName,
      subscriptionTier,
    }
  }
}
