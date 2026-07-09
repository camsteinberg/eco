// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createBillingRouter } from '../billing.js'
import type { StripeService } from '../../lib/stripe.js'

// ---------------------------------------------------------------------------
// Mock db with execute spy
// ---------------------------------------------------------------------------
function createMockDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

/** Extract raw SQL text from a drizzle-orm sql template result */
function extractSql(sqlObj: unknown): string {
  return JSON.stringify(sqlObj)
}

// ---------------------------------------------------------------------------
// The Stripe checkout.session.completed webhook must set the user's
// subscription tier (and ONLY the tier). The legacy token-economy top-up
// (syncTokenAllowance) was removed in Wave D S3a — a tier-differentiated token
// allowance violates the v1.0 constraint that Free and Supporter have identical
// functionality. These tests pin that the webhook still drives updateUserTier
// and never issues token/economy SQL.
// ---------------------------------------------------------------------------
describe('billing webhook tier sync', () => {
  let app: Hono
  let mockDb: ReturnType<typeof createMockDb>

  const mockStripe: StripeService = {
    createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/session_123' }),
    createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.com/portal_123' }),
    constructWebhookEvent: vi.fn(),
  }

  const mockUpdateUserTier = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = createMockDb()
  })

  function setupApp(
    eventType: string,
    overrides: Record<string, unknown> = {},
  ) {
    const eventData: Record<string, unknown> = {
      customer: 'cus_123',
      subscription: 'sub_123',
      metadata: { userId: 'user-abc' },
    }
    if (eventType === 'checkout.session.completed') {
      eventData.line_items = { data: [{ price: { id: 'price_supporter' } }] }
    }
    Object.assign(eventData, overrides)

    ;(mockStripe.constructWebhookEvent as ReturnType<typeof vi.fn>).mockReturnValue({
      type: eventType,
      data: { object: eventData },
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
      c.set('user', { id: 'user-abc', email: 'test@eco.network', subscriptionTier: 'free' })
      await next()
    })
    app.route('/billing', router)
  }

  it('checkout.session.completed sets the supporter tier via updateUserTier', async () => {
    setupApp('checkout.session.completed')

    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(200)
    expect(mockUpdateUserTier).toHaveBeenCalledWith('user-abc', 'supporter', 'cus_123')
  })

  it('checkout.session.completed issues NO token/economy SQL on a supporter upgrade', async () => {
    setupApp('checkout.session.completed')

    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(200)
    // Tier is set...
    expect(mockUpdateUserTier).toHaveBeenCalledWith('user-abc', 'supporter', 'cus_123')
    // ...and the webhook never touches the legacy token-economy tables. The
    // resolved userId comes from metadata, so no db lookup is needed either.
    expect(mockDb.execute).not.toHaveBeenCalled()
    for (const call of mockDb.execute.mock.calls) {
      const sqlText = extractSql(call[0])
      expect(sqlText).not.toMatch(/token_accounts/i)
      expect(sqlText).not.toMatch(/economy_config/i)
    }
  })

  it('checkout.session.completed trusts durable metadata when line items are absent', async () => {
    setupApp('checkout.session.completed', {
      metadata: { userId: 'user-abc', tier: 'enterprise', priceId: 'price_ent' },
      line_items: undefined,
    })

    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(200)
    expect(mockUpdateUserTier).toHaveBeenCalledWith('user-abc', 'enterprise', 'cus_123')
  })

  it('customer.subscription.deleted downgrades to free without token SQL', async () => {
    setupApp('customer.subscription.deleted')

    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(200)
    expect(mockUpdateUserTier).toHaveBeenCalledWith('user-abc', 'free')
    // No token/economy SQL on downgrade either.
    expect(mockDb.execute).not.toHaveBeenCalled()
  })

  it('customer.subscription.deleted falls back to the stored Stripe customer mapping when subscription metadata is missing', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ id: 'user-from-customer' }],
    })
    setupApp('customer.subscription.deleted', {
      customer: 'cus_lookup',
      metadata: {},
    })

    const res = await app.request('/billing/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_test' },
      body: 'webhook_payload',
    })

    expect(res.status).toBe(200)
    expect(mockUpdateUserTier).toHaveBeenCalledWith('user-from-customer', 'free')
    // The only db query is the user lookup by stripe customer id — not token SQL.
    expect(mockDb.execute).toHaveBeenCalledTimes(1)
    const sqlText = extractSql(mockDb.execute.mock.calls[0][0])
    expect(sqlText).toMatch(/stripe_customer_id/i)
    expect(sqlText).not.toMatch(/token_accounts/i)
  })
})
