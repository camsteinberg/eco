// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import * as authSchema from '../db/schema/auth.js'
import { syncUserToAppTable } from '../db/sync-user.js'

type FinalizeNewUserParams = {
  db: Db
  user: {
    id: string
    email: string
    name?: string | null
  }
  context: {
    path?: string | null | undefined
    request?: Request | undefined
    headers?: Headers | undefined
  } | null
}

export async function finalizeNewUser({
  db,
  user,
}: FinalizeNewUserParams): Promise<void> {
  try {
    await syncUserToAppTable(db, user.id, user.email, user.name)
  } catch (error) {
    // If syncing the Better Auth user into the app `users` table fails, roll
    // back the freshly created auth `user` row so a failed signup never leaves
    // a half-created account behind.
    await db
      .delete(authSchema.user)
      .where(eq(authSchema.user.id, user.id))
      .catch(() => undefined)

    throw error
  }
}
