// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createAccountRouter, SESSION_FRESH_WINDOW_MS } from '../account.js'

const userId = 'user-abc-123'
const authUserId = 'better-auth-user-xyz'
const dialect = new PgDialect()

const CORRECT_PASSWORD = 'correct horse battery staple'

function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: userId,
    email: 'test@eco.network',
    name: 'Test User',
    sessionCreatedAt: new Date(),
    ...overrides,
  }
}

/**
 * A stand-in for better-auth's resolved context. `password.verify` mimics the
 * real verifier's contract (hash + candidate in, boolean out) without hashing
 * anything; the point under test is that the route asks and honours the answer.
 */
function createAuthContext({ hasCredential = true }: { hasCredential?: boolean } = {}) {
  return {
    password: {
      verify: vi.fn(async ({ password }: { hash: string; password: string }) =>
        password === CORRECT_PASSWORD,
      ),
    },
    internalAdapter: {
      findUserByEmail: vi.fn(async () => ({
        accounts: hasCredential
          ? [{ providerId: 'credential', password: 'scrypt$stored-hash' }]
          : [{ providerId: 'google', password: null }],
      })),
    },
  }
}

function createMockDb() {
  // Every `where` condition the route builds, in call order, so a predicate can
  // be asserted rather than merely counted.
  const deleteConditions: SQL[] = []

  const mockDb = {
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation((condition: SQL) => {
        deleteConditions.push(condition)
        return Promise.resolve()
      }),
    })),
    select: vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: authUserId }]),
        }),
      }),
    })),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(mockDb)
    }),
  }

  return { mockDb, deleteConditions }
}

function createApp(
  mockDb: ReturnType<typeof createMockDb>['mockDb'],
  {
    authContext = createAuthContext(),
    user = mockUser(),
  }: {
    authContext?: ReturnType<typeof createAuthContext>
    user?: ReturnType<typeof mockUser>
  } = {},
) {
  const router = createAccountRouter({ db: mockDb as never, authContext })
  const app = new Hono()

  // Mock auth middleware — inject user
  app.use('/*', async (c, next) => {
    c.set('user', user)
    await next()
  })

  app.route('/v1/auth/account', router)
  return app
}

/** A DELETE carrying the password body the route now requires. */
function deleteWithPassword(password?: string) {
  return {
    method: 'DELETE',
    ...(password === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        }),
  }
}

describe('Account routes', () => {
  let app: ReturnType<typeof createApp>
  let mockDb: ReturnType<typeof createMockDb>['mockDb']
  let deleteConditions: SQL[]

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = createMockDb()
    mockDb = mock.mockDb
    deleteConditions = mock.deleteConditions
    app = createApp(mockDb)
  })

  describe('DELETE /v1/auth/account — proof of possession', () => {
    it('deletes the account when the submitted password is correct', async () => {
      const authContext = createAuthContext()
      app = createApp(mockDb, { authContext })

      const res = await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      expect(res.status).toBe(200)
      expect(authContext.password.verify).toHaveBeenCalledWith({
        hash: 'scrypt$stored-hash',
        password: CORRECT_PASSWORD,
      })
    })

    it('refuses a wrong password with 403 and deletes nothing', async () => {
      const res = await app.request('/v1/auth/account', deleteWithPassword('not my password'))

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error.code).toBe('reauthentication_required')
      expect(mockDb.delete).not.toHaveBeenCalled()
      expect(mockDb.transaction).not.toHaveBeenCalled()
    })

    it('refuses a request with no body at all', async () => {
      const res = await app.request('/v1/auth/account', deleteWithPassword())

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error.code).toBe('reauthentication_required')
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('refuses a body whose password is empty or not a string', async () => {
      for (const password of ['', 42, null]) {
        const res = await app.request('/v1/auth/account', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        })
        expect(res.status).toBe(403)
      }
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('lets an OAuth-only user delete on a fresh session, without a password', async () => {
      const authContext = createAuthContext({ hasCredential: false })
      app = createApp(mockDb, {
        authContext,
        user: mockUser({ sessionCreatedAt: new Date(Date.now() - 60_000) }),
      })

      const res = await app.request('/v1/auth/account', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(authContext.password.verify).not.toHaveBeenCalled()
    })

    it('refuses an OAuth-only user whose session is older than the freshness window', async () => {
      app = createApp(mockDb, {
        authContext: createAuthContext({ hasCredential: false }),
        user: mockUser({
          sessionCreatedAt: new Date(Date.now() - (SESSION_FRESH_WINDOW_MS + 1_000)),
        }),
      })

      const res = await app.request('/v1/auth/account', { method: 'DELETE' })

      expect(res.status).toBe(403)
      const body = await res.json()
      expect(body.error.code).toBe('reauthentication_required')
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('treats an unknown session age as stale (fail closed)', async () => {
      app = createApp(mockDb, {
        authContext: createAuthContext({ hasCredential: false }),
        user: mockUser({ sessionCreatedAt: undefined }),
      })

      const res = await app.request('/v1/auth/account', { method: 'DELETE' })

      expect(res.status).toBe(403)
      expect(mockDb.delete).not.toHaveBeenCalled()
    })
  })

  describe('DELETE /v1/auth/account', () => {
    it('deletes the user account and returns ok', async () => {
      const res = await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })

    it('calls delete four times (api_keys, users, auth user, verification)', async () => {
      await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      expect(mockDb.delete).toHaveBeenCalledTimes(4)
    })

    it('deletes verification rows for the email and for the pending password reset', async () => {
      await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      const query = dialect.sqlToQuery(deleteConditions[3]!)
      expect(query.sql).toContain('"identifier" =')
      expect(query.sql).toContain('"identifier" like')
      expect(query.sql).toContain('"value" =')
      expect(query.sql).toContain(' or ')
      expect(query.params).toEqual([
        'test@eco.network',
        'reset-password:%',
        authUserId,
      ])
    })

    it('falls back to the email-only predicate when no Better Auth row exists', async () => {
      mockDb.select.mockImplementation(() => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
      }))

      await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      const query = dialect.sqlToQuery(deleteConditions[3]!)
      expect(query.sql).not.toContain('like')
      expect(query.params).toEqual(['test@eco.network'])
    })

    it('returns 500 if api_keys delete fails', async () => {
      let callIndex = 0
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          callIndex++
          if (callIndex === 1) return Promise.reject(new Error('FK error'))
          return Promise.resolve()
        }),
      }))

      const res = await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      expect(res.status).toBe(500)
    })

    it('returns 500 if app users delete fails', async () => {
      let callIndex = 0
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          callIndex++
          if (callIndex === 2) return Promise.reject(new Error('not found'))
          return Promise.resolve()
        }),
      }))

      const res = await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      expect(res.status).toBe(500)
    })

    it('returns 500 if the verification delete fails', async () => {
      let callIndex = 0
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          callIndex++
          if (callIndex === 4) return Promise.reject(new Error('verification delete failed'))
          return Promise.resolve()
        }),
      }))

      const res = await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      expect(res.status).toBe(500)
    })

    it('propagates error if auth user delete fails', async () => {
      let callIndex = 0
      mockDb.delete.mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => {
          callIndex++
          if (callIndex === 3) return Promise.reject(new Error('cascade fail'))
          return Promise.resolve()
        }),
      }))

      const res = await app.request('/v1/auth/account', deleteWithPassword(CORRECT_PASSWORD))

      // Auth user delete is not caught — should result in 500
      expect(res.status).toBe(500)
    })
  })
})
