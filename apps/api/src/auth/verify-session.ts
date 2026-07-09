// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { eq, and, gt } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { sessions } from '../db/schema/sessions.js'
import { users } from '../db/schema/users.js'
import type { AuthUser, SubscriptionTier } from '../lib/types/auth.js'

export function createSessionVerifier(db: Db) {
  return async (sessionToken: string): Promise<AuthUser | null> => {
    const now = new Date()
    const result = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        subscriptionTier: users.subscriptionTier,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.token, sessionToken),
          gt(sessions.expiresAt, now)
        )
      )
      .limit(1)

    if (result.length === 0) return null

    const row = result[0]!
    return {
      id: row.userId,
      email: row.email,
      name: row.name ?? null,
      subscriptionTier: (row.subscriptionTier as SubscriptionTier) ?? 'free',
    }
  }
}
