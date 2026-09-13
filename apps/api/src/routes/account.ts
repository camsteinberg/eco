// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono, type Context } from 'hono'
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

/**
 * How recently an OAuth-only user's session must have been established for
 * account deletion to count as proven. Password users re-enter their password
 * instead; these users have no second factor we can ask for, so a sign-in they
 * performed moments ago is the proof.
 * CHOSEN 2026-09-13 (auth security review), not measured.
 */
export const SESSION_FRESH_WINDOW_MS = 10 * 60 * 1000

/**
 * The slice of better-auth's resolved `AuthContext` this route needs: the
 * configured password verifier and the user lookup that returns linked
 * accounts. Structural on purpose — the real context satisfies it, and a test
 * can supply four lines instead of a whole auth instance. Hashing is never
 * re-implemented here; `password.verify` is whatever better-auth itself uses
 * (better-auth 1.6.23, context/create-context.mjs:181-189 → crypto/password.mjs,
 * scrypt via @better-auth/utils).
 */
export type AccountAuthContext = {
  password: {
    verify: (data: { hash: string; password: string }) => Promise<boolean>
  }
  internalAdapter: {
    findUserByEmail: (
      email: string,
      options?: { includeAccounts: boolean },
    ) => Promise<{
      accounts: { providerId: string; password?: string | null | undefined }[]
    } | null>
  }
}

/** The credential provider id better-auth stores for email+password accounts. */
const CREDENTIAL_PROVIDER_ID = 'credential'

function reauthenticationRequired(c: Context<Env>, message: string) {
  return c.json(
    { error: { code: 'reauthentication_required', message } },
    403,
  )
}

/**
 * Read `{ password }` from the request body. A missing body, a non-JSON body or
 * a non-string password all mean "no proof offered", which is a refusal rather
 * than a 400 — the caller's next step is the same either way.
 */
async function readSubmittedPassword(c: {
  req: { json: () => Promise<unknown> }
}): Promise<string | null> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const password = (body as { password?: unknown }).password
  return typeof password === 'string' && password !== '' ? password : null
}

export function createAccountRouter({
  db,
  authContext,
}: {
  db: Db
  authContext: AccountAuthContext
}) {
  const router = new Hono<Env>()

  // DELETE / — Delete the authenticated user's account
  // Cascades: sessions and accounts via FK on Better Auth's user table
  // Wrapped in a transaction so partial deletes don't leave inconsistent state.
  //
  // A live session is NOT sufficient proof for a destructive, irreversible
  // action: a session cookie can be borrowed (an unlocked laptop, a stolen
  // token) and deletion has no undo. Password users re-enter their password;
  // OAuth-only users, who have no password to re-enter, must have signed in
  // within the last few minutes.
  router.delete('/', async (c) => {
    const currentUser = c.get('user')

    const accounts =
      (await authContext.internalAdapter.findUserByEmail(currentUser.email, {
        includeAccounts: true,
      }))?.accounts ?? []
    const credentialHash = accounts.find(
      (account) => account.providerId === CREDENTIAL_PROVIDER_ID,
    )?.password

    if (credentialHash) {
      const submitted = await readSubmittedPassword(c)
      if (!submitted) {
        return reauthenticationRequired(
          c,
          'Confirm your password to delete your account.',
        )
      }
      const correct = await authContext.password.verify({
        hash: credentialHash,
        password: submitted,
      })
      if (!correct) {
        return reauthenticationRequired(
          c,
          'That password is not correct. Confirm your password to delete your account.',
        )
      }
    } else {
      // OAuth-only (or an account with no usable credential row). An unknown
      // session age is treated as stale — fail closed.
      const createdAt = currentUser.sessionCreatedAt
      const isFresh =
        createdAt instanceof Date &&
        Date.now() - createdAt.getTime() <= SESSION_FRESH_WINDOW_MS
      if (!isFresh) {
        return reauthenticationRequired(
          c,
          'Sign in again, then delete your account within a few minutes.',
        )
      }
    }

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
