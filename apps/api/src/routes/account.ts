// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { and, eq, like, or } from 'drizzle-orm'
import { apiKeys } from '../db/schema/api-keys.js'
import { users } from '../db/schema/users.js'
import { user as authUser, verification } from '../db/schema/auth.js'
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

    // This deletes database rows only: API keys, the app user, the Better Auth
    // user (which cascades to its sessions and linked accounts), and the
    // `verification` rows that survive that cascade because they reference the
    // user by value rather than by foreign key.
    await db.transaction(async (tx) => {
      // 1. Delete all API keys belonging to the user
      await tx.delete(apiKeys).where(eq(apiKeys.userId, currentUser.id))

      // 2. Delete from app users table
      await tx.delete(users).where(eq(users.id, currentUser.id))

      // 3. Read the Better Auth user id before the row goes away — pending
      // password-reset rows store it as their `value`.
      const authRows = await tx
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, currentUser.email))
        .limit(1)
      const authUserId = authRows[0]?.id

      // 4. Delete from Better Auth user table by email.
      // Session-authenticated legacy members can keep an older app-user id,
      // so the Better Auth row may not share the same primary key.
      await tx.delete(authUser).where(eq(authUser.email, currentUser.email))

      // 5. Delete the user's `verification` rows. The table has no FK to
      // `user`, so nothing cascades. In better-auth 1.6.23 a pending password
      // reset is stored as identifier `reset-password:<token>` with the user
      // id as its value (api/routes/password.mjs), and email-keyed rows come
      // from the change-email flow. Email verification itself writes no row at
      // all — it is a signed JWT (api/routes/email-verification.mjs) — and a
      // pending magic link is keyed by a token hash with the email inside a
      // JSON value, which expires five minutes later and is removed by the
      // expired-row sweep rather than matched on here.
      const verificationMatch = authUserId
        ? or(
            eq(verification.identifier, currentUser.email),
            and(
              like(verification.identifier, 'reset-password:%'),
              eq(verification.value, authUserId),
            ),
          )
        : eq(verification.identifier, currentUser.email)
      await tx.delete(verification).where(verificationMatch)
    })

    return c.json({ ok: true })
  })

  return router
}
