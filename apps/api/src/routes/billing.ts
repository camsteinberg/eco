// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { SubscriptionTier, AuthUser } from '../lib/types/auth.js'
import type { StripeService } from '../lib/stripe.js'
import type { Db } from '../db/index.js'
import type { RateLimitRedis } from '../middleware/rateLimit.js'
import { logger } from '../lib/logger.js'

type PriceIds = {
  supporter: string
  enterprise: string
}

type PaidTier = Extract<SubscriptionTier, 'supporter' | 'enterprise'>

type BillingDeps = {
  stripe: StripeService
  updateUserTier: (userId: string, tier: SubscriptionTier, stripeCustomerId?: string) => Promise<void>
  priceIds: PriceIds
  webhookSecret: string
  db?: Db
  /** Optional Redis client for webhook event deduplication (best-effort). */
  redis?: RateLimitRedis
}

// Lua: return existing value (nil when absent) — one round-trip GET.
const DEDUP_CHECK_SCRIPT = `return redis.call('GET', KEYS[1])`

// Lua: SET key value EX ttl NX — mark event as processed (24h TTL, NX = no-op
// if already set). Returns 'OK' on success, nil if already present.
const DEDUP_MARK_SCRIPT = `return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')`

const DEDUP_TTL_SECONDS = 86400 // 24 hours

export function tierFromPriceId(priceId: string, priceIds: PriceIds): SubscriptionTier {
  if (priceId === priceIds.supporter) return 'supporter'
  if (priceId === priceIds.enterprise) return 'enterprise'
  return 'free'
}

function normalizeStripeId(value: string | { id?: string } | null | undefined): string | undefined {
  if (typeof value === 'string') {
    return value
  }

  if (value && typeof value === 'object' && typeof value.id === 'string') {
    return value.id
  }

  return undefined
}

async function findStripeCustomerIdForUser(userId: string, db?: Db): Promise<string | null> {
  if (!db) {
    return null
  }

  const result = await db.execute(
    sql`SELECT stripe_customer_id FROM "user" WHERE id = ${userId} LIMIT 1`,
  )
  const rows = result.rows as Array<{ stripe_customer_id: string | null }>
  return rows[0]?.stripe_customer_id ?? null
}

async function findUserIdForStripeCustomer(customerId: string | undefined, db?: Db): Promise<string | null> {
  if (!db || !customerId) {
    return null
  }

  const result = await db.execute(
    sql`SELECT id FROM "user" WHERE stripe_customer_id = ${customerId} LIMIT 1`,
  )
  const rows = result.rows as Array<{ id: string }>
  return rows[0]?.id ?? null
}

function resolvePaidTier(value: string | undefined): PaidTier | null {
  return value === 'supporter' || value === 'enterprise' ? value : null
}

function resolveCheckoutTier(
  session: {
    metadata?: { tier?: string; priceId?: string }
    line_items?: { data?: Array<{ price?: { id?: string } }> }
  },
  priceIds: PriceIds,
): PaidTier {
  const metadataTier = resolvePaidTier(session.metadata?.tier)
  if (metadataTier) {
    return metadataTier
  }

  const metadataPriceId = session.metadata?.priceId
  if (metadataPriceId) {
    const metadataPriceTier = tierFromPriceId(metadataPriceId, priceIds)
    if (metadataPriceTier !== 'free') {
      return metadataPriceTier
    }

    logger.warn(
      { priceId: metadataPriceId },
      'Unknown price ID in checkout session metadata — falling back to additional checkout context',
    )
  }

  const checkoutPriceId = session.line_items?.data?.[0]?.price?.id
  if (checkoutPriceId) {
    const lineItemTier = tierFromPriceId(checkoutPriceId, priceIds)
    if (lineItemTier !== 'free') {
      return lineItemTier
    }

    logger.warn(
      { priceId: checkoutPriceId },
      'Unknown price ID in checkout session line items — defaulting to supporter',
    )
    return 'supporter'
  }

  logger.warn(
    'No durable tier metadata or line item price ID found in checkout session — defaulting to supporter',
  )
  return 'supporter'
}

export function verifyWebhookSignature(
  stripe: StripeService,
  payload: string,
  signature: string,
  secret: string
) {
  return stripe.constructWebhookEvent(payload, signature, secret)
}

export function createBillingRouter({ stripe, updateUserTier, priceIds, webhookSecret, db, redis }: BillingDeps) {
  const router = new Hono()

  // Create Stripe Checkout session
  router.post('/checkout', async (c) => {
    const user = (c.get as (key: string) => unknown)('user') as AuthUser

    let body: unknown = {}
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON', type: 'invalid_request_error' } },
        400,
      )
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json(
        { error: { message: 'Request body must be an object', type: 'invalid_request_error' } },
        400,
      )
    }

    const requestedTier = 'tier' in body ? body.tier : undefined
    if (
      requestedTier !== undefined &&
      requestedTier !== 'supporter' &&
      requestedTier !== 'enterprise'
    ) {
      return c.json(
        {
          error: {
            message: '`tier` must be "supporter" or "enterprise"',
            type: 'invalid_request_error',
          },
        },
        400,
      )
    }

    const tier = requestedTier === 'enterprise' ? 'enterprise' : 'supporter'
    const priceId =
      tier === 'enterprise' ? priceIds.enterprise : priceIds.supporter
    const baseUrl = process.env.WEB_URL ?? 'http://localhost:3000'

    const session = await stripe.createCheckoutSession({
      userId: user.id,
      email: user.email,
      tier,
      priceId,
      successUrl: `${baseUrl}/settings?tab=billing&billing=success`,
      cancelUrl: `${baseUrl}/settings?tab=billing&billing=canceled`,
    })

    return c.json({ url: session.url })
  })

  // Create Stripe Customer Portal session
  router.post('/portal', async (c) => {
    const user = (c.get as (key: string) => unknown)('user') as AuthUser & { stripeCustomerId?: string }
    const customerId =
      user.stripeCustomerId ?? (await findStripeCustomerIdForUser(user.id, db)) ?? ''
    const baseUrl = process.env.WEB_URL ?? 'http://localhost:3000'

    if (!customerId) {
      return c.json({ error: { code: 'invalid_request', message: 'No billing account found' } }, 400)
    }

    const session = await stripe.createPortalSession({
      customerId,
      returnUrl: `${baseUrl}/settings?tab=billing&billing=portal`,
    })

    return c.json({ url: session.url })
  })

  // Stripe webhook handler
  router.post('/webhook', async (c) => {
    const payload = await c.req.text()
    const signature = c.req.header('stripe-signature')

    if (!signature) {
      return c.json({ error: { code: 'invalid_request', message: 'Missing stripe-signature header' } }, 400)
    }

    let event
    try {
      event = verifyWebhookSignature(stripe, payload, signature, webhookSecret)
    } catch {
      return c.json({ error: { code: 'invalid_request', message: 'Invalid webhook signature' } }, 400)
    }

    // Best-effort dedup: skip reprocessing if this event was already handled.
    // Redis failures must NOT block the webhook — dedup is a convenience,
    // signature verification is the security boundary.
    if (redis) {
      const dedupKey = `stripe:webhook:${event.id}`
      try {
        const existing = await redis.eval(DEDUP_CHECK_SCRIPT, 1, dedupKey)
        if (existing !== null) {
          return c.json({ received: true, duplicate: true })
        }
      } catch (err) {
        logger.warn({ err, eventId: event.id }, 'Webhook dedup check failed — continuing without dedup')
      }
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as unknown as {
          customer: string | { id?: string }
          subscription: string
          client_reference_id?: string | null
          metadata?: { userId?: string; tier?: string; priceId?: string }
          line_items?: { data?: Array<{ price?: { id?: string } }> }
        }
        const customerId = normalizeStripeId(session.customer)
        const userId =
          session.metadata?.userId ??
          (typeof session.client_reference_id === 'string' ? session.client_reference_id : undefined) ??
          (await findUserIdForStripeCustomer(customerId, db))
        if (!userId) {
          return c.json({ error: { code: 'invalid_request', message: 'Missing userId in checkout session metadata' } }, 400)
        }

        const tier = resolveCheckoutTier(session, priceIds)
        try {
          await updateUserTier(userId, tier, customerId)
        } catch (err) {
          // Return 500 so Stripe retries the webhook delivery
          logger.error({ userId, err }, 'Failed to update user tier from Stripe webhook')
          return c.json({ error: { code: 'internal_error', message: 'Tier update failed' } }, 500)
        }
        break
      }

      case 'customer.subscription.deleted':
      case 'invoice.payment_failed': {
        const subscription = event.data.object as {
          customer: string | { id?: string }
          metadata?: { userId?: string }
        }
        const customerId = normalizeStripeId(subscription.customer)
        const userId =
          subscription.metadata?.userId ??
          (await findUserIdForStripeCustomer(customerId, db))
        if (userId) {
          await updateUserTier(userId, 'free')
        }
        break
      }
    }

    // Mark this event as processed AFTER successful handling. A 500 above
    // leaves the event unmarked so Stripe's retry will be reprocessed.
    if (redis) {
      try {
        await redis.eval(DEDUP_MARK_SCRIPT, 1, `stripe:webhook:${event.id}`, '1', String(DEDUP_TTL_SECONDS))
      } catch (err) {
        logger.warn({ err, eventId: event.id }, 'Webhook dedup mark failed — event processed but not marked')
      }
    }

    return c.json({ received: true })
  })

  return router
}
