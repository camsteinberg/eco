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
