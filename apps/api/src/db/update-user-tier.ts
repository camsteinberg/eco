// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { eq } from 'drizzle-orm'
import type { Db } from './index.js'
import { users } from './schema/users.js'
import type { SubscriptionTier } from '../lib/types/auth.js'

export function createUpdateUserTier(db: Db) {
  return async (userId: string, tier: SubscriptionTier, stripeCustomerId?: string): Promise<void> => {
    await db.update(users)
      .set({
        subscriptionTier: tier,
        ...(stripeCustomerId && { stripeCustomerId }),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
  }
}
