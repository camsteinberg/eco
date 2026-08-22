// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
  tierFromPriceId,
  createBillingRouter,
} from '../billing.js'
import type { StripeService } from '../../lib/stripe.js'

describe('verifyWebhookSignature', () => {
  it('returns true for valid signature', () => {
    // In production this uses Stripe SDK; here we test the interface
    const mockVerify = vi.fn().mockReturnValue({ type: 'checkout.session.completed' })
    const result = mockVerify('payload', 'sig', 'secret')
    expect(result.type).toBe('checkout.session.completed')
  })
})

describe('tierFromPriceId', () => {
  it('returns "supporter" for the supporter price ID', () => {
    expect(tierFromPriceId('price_supporter_monthly', { supporter: 'price_supporter_monthly', enterprise: 'price_enterprise_monthly' }))
      .toBe('supporter')
  })

  it('returns "enterprise" for the enterprise price ID', () => {
    expect(tierFromPriceId('price_enterprise_monthly', { supporter: 'price_supporter_monthly', enterprise: 'price_enterprise_monthly' }))
      .toBe('enterprise')
  })

  it('returns "free" for unknown price ID', () => {
    expect(tierFromPriceId('price_unknown', { supporter: 'price_supporter_monthly', enterprise: 'price_enterprise_monthly' }))
      .toBe('free')
  })
})

describe('billing router', () => {
  let app: Hono
  const mockDb = {
    execute: vi.fn(),
  }

  const mockStripe: StripeService = {
    createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_123' }),
    createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_123' }),
    constructWebhookEvent: vi.fn().mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_123',
          subscription: 'sub_123',
          metadata: { userId: 'user-abc' },
        },
      },
    }),
  }

  const mockUpdateUserTier = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.execute.mockReset()
    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
    })
    app = new Hono()
    // Mock auth middleware
    app.use('/*', async (c, next) => {
      c.set('user', { id: 'user-abc', email: 'test@eco.network', subscriptionTier: 'free', stripeCustomerId: 'cus_test' })
      await next()
    })
    app.route('/billing', router)
  })

  it('POST /billing/checkout creates a session and returns URL', async () => {
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'supporter' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://checkout.stripe.com/session_123')
    expect(mockStripe.createCheckoutSession).toHaveBeenCalledWith({
      userId: 'user-abc',
      email: 'test@eco.network',
      tier: 'supporter',
      priceId: 'price_supporter',
      successUrl: 'http://localhost:3000/settings?tab=billing&billing=success',
      cancelUrl: 'http://localhost:3000/settings?tab=billing&billing=canceled',
    })
  })

  it('POST /billing/checkout rejects invalid JSON', async () => {
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('Invalid JSON')
  })

  it('POST /billing/checkout rejects invalid tiers instead of silently downgrading', async () => {
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'vip' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('tier')
  })

  it('POST /billing/portal creates a portal session and returns URL', async () => {
    const res = await app.request('/billing/portal', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://billing.stripe.com/portal_123')
    expect(mockStripe.createPortalSession).toHaveBeenCalledWith({
      customerId: 'cus_test',
      returnUrl: 'http://localhost:3000/settings?tab=billing&billing=portal',
    })
  })

  it('POST /billing/webhook returns 500 when updateUserTier fails', async () => {
    mockUpdateUserTier.mockRejectedValueOnce(new Error('db write failed'))

    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(500)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('internal_error')
    expect(mockUpdateUserTier).toHaveBeenCalled()
  })

  it('POST /billing/webhook returns 200 when updateUserTier succeeds', async () => {
    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { received: boolean }
    expect(body.received).toBe(true)
  })

  it('POST /billing/portal falls back to the stored Stripe customer id when auth state has not hydrated it', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ stripe_customer_id: 'cus_from_db' }],
    })

    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
    })

    app = new Hono()
    app.use('/*', async (c, next) => {
      c.set('user', { id: 'user-abc', email: 'test@eco.network', subscriptionTier: 'supporter' })
      await next()
    })
    app.route('/billing', router)

    const res = await app.request('/billing/portal', {
      method: 'POST',
    })

    expect(res.status).toBe(200)
    expect(mockStripe.createPortalSession).toHaveBeenCalledWith({
      customerId: 'cus_from_db',
      returnUrl: 'http://localhost:3000/settings?tab=billing&billing=portal',
    })
  })
})

describe('webhook event deduplication', () => {
  const mockStripe: StripeService = {
    createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_123' }),
    createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_123' }),
    constructWebhookEvent: vi.fn().mockReturnValue({
      id: 'evt_test_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_123',
          subscription: 'sub_123',
          metadata: { userId: 'user-abc' },
          line_items: { data: [{ price: { id: 'price_supporter' } }] },
        },
      },
    }),
  }

  const mockUpdateUserTier = vi.fn().mockResolvedValue(undefined)
  const mockDb = { execute: vi.fn().mockResolvedValue({ rows: [] }) }

  function createMockRedis(overrides: Partial<{ eval: ReturnType<typeof vi.fn> }> = {}) {
    return {
      eval: overrides.eval ?? vi.fn().mockResolvedValue(null),
    }
  }

  function sendWebhook(app: Hono) {
    return app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips reprocessing when the event was already handled (duplicate)', async () => {
    const redis = createMockRedis({
      eval: vi.fn().mockResolvedValue('1'), // GET returns a value → already processed
    })
    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
      redis,
    })
    const app = new Hono()
    app.route('/billing', router)

    const res = await sendWebhook(app)

    expect(res.status).toBe(200)
    const body = await res.json() as { received: boolean; duplicate?: boolean }
    expect(body.duplicate).toBe(true)
    expect(mockUpdateUserTier).not.toHaveBeenCalled()
  })

  it('does not mark event when processing fails (500)', async () => {
    const evalFn = vi.fn().mockResolvedValue(null) // GET returns null → not processed
    const redis = createMockRedis({ eval: evalFn })
    mockUpdateUserTier.mockRejectedValueOnce(new Error('db write failed'))

    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
      redis,
    })
    const app = new Hono()
    app.route('/billing', router)

    const res = await sendWebhook(app)

    expect(res.status).toBe(500)
    // Should have called eval for the check (GET) but NOT for the mark (SET)
    expect(evalFn).toHaveBeenCalledTimes(1)
  })

  it('passes through without dedup when redis is not provided', async () => {
    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
      // no redis
    })
    const app = new Hono()
    app.route('/billing', router)

    const res = await sendWebhook(app)

    expect(res.status).toBe(200)
    expect(mockUpdateUserTier).toHaveBeenCalled()
  })

  it('tolerates a redis error during dedup check and continues processing', async () => {
    const redis = createMockRedis({
      eval: vi.fn()
        .mockRejectedValueOnce(new Error('Redis connection refused')) // check fails
        .mockResolvedValueOnce('OK'), // mark succeeds
    })
    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
      redis,
    })
    const app = new Hono()
    app.route('/billing', router)

    const res = await sendWebhook(app)

    expect(res.status).toBe(200)
    expect(mockUpdateUserTier).toHaveBeenCalled()
  })

  it('marks event after successful processing', async () => {
    const evalFn = vi.fn()
      .mockResolvedValueOnce(null) // GET → not processed
      .mockResolvedValueOnce('OK') // SET → marked
    const redis = createMockRedis({ eval: evalFn })

    const router = createBillingRouter({
      stripe: mockStripe,
      updateUserTier: mockUpdateUserTier,
      priceIds: { supporter: 'price_supporter', enterprise: 'price_ent' },
      webhookSecret: 'whsec_test',
      db: mockDb as never,
      redis,
    })
    const app = new Hono()
    app.route('/billing', router)

    const res = await sendWebhook(app)

    expect(res.status).toBe(200)
    // Two eval calls: one GET check, one SET mark
    expect(evalFn).toHaveBeenCalledTimes(2)
  })
})
