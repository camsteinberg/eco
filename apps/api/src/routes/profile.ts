// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema/users.js'
import { user as authUser } from '../db/schema/auth.js'
import type { Db } from '../db/index.js'
import type { AuthUser } from '../lib/types/auth.js'

type Env = {
  Variables: {
    user: AuthUser
  }
}

export function createProfileRouter({ db }: { db: Db }) {
  const router = new Hono<Env>()

  // GET / — Get the user profile
  router.get('/', async (c) => {
    const user = c.get('user')

    return c.json({
      id: user.id,
      email: user.email,
      name: user.name,
    })
  })

  // PATCH / — Update user profile name
  router.patch('/', async (c) => {
    const user = c.get('user')

    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON', type: 'invalid_request_error' } },
        400,
      )
    }

    if (typeof body.name !== 'string') {
      return c.json(
        { error: { message: 'name is required and must be a string', type: 'validation_error' } },
        400,
      )
    }

    const trimmed = body.name.trim()

    if (trimmed.length === 0) {
      return c.json(
        { error: { message: 'name must not be empty after trimming', type: 'validation_error' } },
        400,
      )
    }

    if (trimmed.length > 255) {
      return c.json(
        { error: { message: 'name must be at most 255 characters', type: 'validation_error' } },
        400,
      )
    }

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ name: trimmed })
        .where(eq(users.id, user.id))

      await tx
        .update(authUser)
        .set({ name: trimmed })
        .where(eq(authUser.email, user.email))
    })

    return c.json({ ok: true })
  })

  return router
}
