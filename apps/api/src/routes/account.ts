// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { apiKeys } from '../db/schema/api-keys.js'
import { users } from '../db/schema/users.js'
import { user as authUser } from '../db/schema/auth.js'
import type { Db } from '../db/index.js'
import type { AuthUser } from '../lib/types/auth.js'

type Env = {
  Variables: {
    user: AuthUser
  }
}

export function createAccountRouter({ db }: { db: Db }) {
  const router = new Hono<Env>()

  // DELETE / — Delete the authenticated user's account
  // Cascades: sessions and accounts via FK on Better Auth's user table
  // Wrapped in a transaction so partial deletes don't leave inconsistent state.
  router.delete('/', async (c) => {
    const currentUser = c.get('user')

    await db.transaction(async (tx) => {
      // 1. Delete all API keys belonging to the user
      await tx.delete(apiKeys).where(eq(apiKeys.userId, currentUser.id))

      // 2. Delete from app users table
      await tx.delete(users).where(eq(users.id, currentUser.id))

      // 3. Delete from Better Auth user table by email.
      // Session-authenticated legacy members can keep an older app-user id,
      // so the Better Auth row may not share the same primary key.
      await tx.delete(authUser).where(eq(authUser.email, currentUser.email))
    })

    return c.json({ ok: true })
  })

  return router
}
