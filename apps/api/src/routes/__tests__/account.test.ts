// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { createAccountRouter } from '../account.js'

const userId = 'user-abc-123'
const authUserId = 'better-auth-user-xyz'
const dialect = new PgDialect()

function mockUser() {
  return { id: userId, email: 'test@eco.network', name: 'Test User' }
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

function createApp(mockDb: ReturnType<typeof createMockDb>['mockDb']) {
  const router = createAccountRouter({ db: mockDb as never })
  const app = new Hono()

  // Mock auth middleware — inject user
  app.use('/*', async (c, next) => {
    c.set('user', mockUser())
    await next()
  })

  app.route('/v1/auth/account', router)
  return app
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

  describe('DELETE /v1/auth/account', () => {
    it('deletes the user account and returns ok', async () => {
      const res = await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
    })

    it('calls delete four times (api_keys, users, auth user, verification)', async () => {
      await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

      expect(mockDb.delete).toHaveBeenCalledTimes(4)
    })

    it('deletes verification rows for the email and for the pending password reset', async () => {
      await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

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

      await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

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

      const res = await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

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

      const res = await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

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

      const res = await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

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

      const res = await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

      // Auth user delete is not caught — should result in 500
      expect(res.status).toBe(500)
    })
  })
})
