// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import Stripe from 'stripe'

export type StripeService = {
  createCheckoutSession: (params: {
    userId: string
    email: string
    tier: 'supporter' | 'enterprise'
    priceId: string
    successUrl: string
    cancelUrl: string
  }) => Promise<{ url: string | null }>

  createPortalSession: (params: {
    customerId: string
    returnUrl: string
  }) => Promise<{ url: string }>

  constructWebhookEvent: (
    payload: string,
    signature: string,
    secret: string
  ) => Stripe.Event
}

export function createStripeService(apiKey?: string): StripeService {
  const key = apiKey ?? process.env.STRIPE_SECRET_KEY
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY environment variable is required')
  }

  const stripe = new Stripe(key)

  return {
    async createCheckoutSession({ userId, email, tier, priceId, successUrl, cancelUrl }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        client_reference_id: userId,
        customer_email: email,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: { userId, tier, priceId },
        subscription_data: {
          metadata: { userId, tier, priceId },
        },
      })
      return { url: session.url }
    },

    async createPortalSession({ customerId, returnUrl }) {
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      })
      return { url: session.url }
    },

    constructWebhookEvent(payload, signature, secret) {
      return stripe.webhooks.constructEvent(payload, signature, secret)
    },
  }
}
