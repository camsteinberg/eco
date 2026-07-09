// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { eq } from 'drizzle-orm'
import { users } from './schema/users.js'
import type { Db } from './index.js'

export type SyncUserToAppTableResult = {
  appUserId: string
  createdNewAppUser: boolean
}

/**
 * Ensure that a Better Auth user has a corresponding row in the app `users` table.
 * Returning members may already have legacy app data keyed to an older app-user id,
 * so we preserve any existing `users.id` row found by email instead of rewriting it.
 */
export async function syncUserToAppTable(
  db: Db,
  authUserId: string,
  email: string,
  name?: string | null,
): Promise<SyncUserToAppTableResult> {
  const existingUsers = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.email, email))

  const existingUser = existingUsers[0]
  if (existingUser) {
    await db
      .update(users)
      .set({
        name: name ?? existingUser.name ?? null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existingUser.id))

    return {
      appUserId: existingUser.id,
      createdNewAppUser: false,
    }
  }

  await db
    .insert(users)
    .values({
      id: authUserId,
      email,
      name: name ?? null,
      subscriptionTier: 'free',
    })

  return {
    appUserId: authUserId,
    createdNewAppUser: true,
  }
}
