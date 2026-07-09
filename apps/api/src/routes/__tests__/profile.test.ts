// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createProfileRouter } from '../profile.js'

const userId = 'user-abc-123'

function mockUser() {
  return { id: userId, email: 'test@eco.network', name: 'Old Name', subscriptionTier: 'free' as const }
}

let updatedNames: string[] = []
let updateCallCount = 0

const mockDb = {
  update: vi.fn(),
  transaction: vi.fn(),
}

function createApp() {
  updatedNames = []
  updateCallCount = 0

  // Mock db.update(table).set(values).where(condition)
  mockDb.update.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        updatedNames.push(values.name as string)
        updateCallCount++
        return Promise.resolve()
      },
    }),
  }))
  mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => {
    await fn(mockDb)
  })
  const router = createProfileRouter({ db: mockDb as never })
  const app = new Hono()

  // Mock auth middleware
  app.use('/*', async (c, next) => {
    c.set('user', mockUser())
    await next()
  })

  app.route('/v1/auth/profile', router)
  return app
}

describe('Profile routes', () => {
  let app: ReturnType<typeof createApp>
  const originalStripeSecret = process.env.STRIPE_SECRET_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.STRIPE_SECRET_KEY
    app = createApp()
  })

  afterEach(() => {
    if (originalStripeSecret === undefined) {
      delete process.env.STRIPE_SECRET_KEY
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeSecret
    }
  })

  describe('GET /v1/auth/profile', () => {
    it('returns subscription tier plus supporter membership billing details', async () => {
      const res = await app.request('/v1/auth/profile')

      expect(res.status).toBe(200)
      const body = await res.json() as {
        subscriptionTier: string
        supporterMembership: {
          supporterPriceMonthlyUsd: number
          billingConfigured: boolean
        }
      }

      expect(body.subscriptionTier).toBe('free')
      expect(body.supporterMembership).toEqual({
        supporterPriceMonthlyUsd: 15,
        billingConfigured: false,
      })
    })

    it('marks billing as configured when Stripe is enabled', async () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_configured'

      const res = await app.request('/v1/auth/profile')
      const body = await res.json() as {
        supporterMembership: { billingConfigured: boolean }
      }

      expect(body.supporterMembership.billingConfigured).toBe(true)
    })
  })

  describe('PATCH /v1/auth/profile', () => {
    it('updates user name successfully', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(updatedNames).toEqual(['New Name', 'New Name'])
      expect(updateCallCount).toBe(2)
    })

    it('trims whitespace from name', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  Trimmed Name  ' }),
      })

      expect(res.status).toBe(200)
      expect(updatedNames).toEqual(['Trimmed Name', 'Trimmed Name'])
    })

    it('rejects empty name after trim', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '   ' }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.message).toMatch(/name/i)
      expect(updateCallCount).toBe(0)
    })

    it('rejects name longer than 255 characters', async () => {
      const longName = 'A'.repeat(256)
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: longName }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.message).toMatch(/255/i)
      expect(updateCallCount).toBe(0)
    })

    it('accepts name exactly 255 characters', async () => {
      const exactName = 'B'.repeat(255)
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: exactName }),
      })

      expect(res.status).toBe(200)
      expect(updatedNames).toEqual([exactName, exactName])
    })

    it('rejects missing name field', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.message).toMatch(/name/i)
      expect(updateCallCount).toBe(0)
    })

    it('rejects non-string name', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 42 }),
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error.message).toMatch(/name/i)
      expect(updateCallCount).toBe(0)
    })

    it('rejects invalid JSON body', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      })

      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toEqual({
        message: 'Invalid JSON',
        type: 'invalid_request_error',
      })
      expect(updateCallCount).toBe(0)
    })

    it('refreshes the Better Auth profile row so the new name survives a fresh sign-in', async () => {
      const res = await app.request('/v1/auth/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Fresh Forest Name' }),
      })

      expect(res.status).toBe(200)
      expect(mockDb.transaction).toHaveBeenCalledTimes(1)
      expect(updatedNames).toEqual(['Fresh Forest Name', 'Fresh Forest Name'])
    })
  })
})
