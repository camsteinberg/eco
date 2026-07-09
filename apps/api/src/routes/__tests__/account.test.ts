// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createAccountRouter } from '../account.js'

const userId = 'user-abc-123'

function mockUser() {
  return { id: userId, email: 'test@eco.network', name: 'Test User', subscriptionTier: 'free' as const }
}

function createMockDb() {
  const mockDb = {
    delete: vi.fn().mockImplementation(() => ({
      where: vi.fn().mockImplementation(() => Promise.resolve()),
    })),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn(mockDb)
    }),
  }

  return { mockDb }
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

  beforeEach(() => {
    vi.clearAllMocks()
    const mock = createMockDb()
    mockDb = mock.mockDb
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

    it('calls delete three times (api_keys, users, auth user)', async () => {
      await app.request('/v1/auth/account', {
        method: 'DELETE',
      })

      // Should call db.delete() three times: api_keys, users, auth user
      expect(mockDb.delete).toHaveBeenCalledTimes(3)
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
