// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client'

import type { SubscriptionTier } from '../lib/types/subscription'
import { useEffect, useState } from 'react'
import { useSession } from '../lib/auth'
import { SUPPORTER_PRICE_MONTHLY_USD } from '../lib/supporter-membership'

// Free and Supporter tiers have IDENTICAL functionality. This hook intentionally
// carries no feature-difference fields (allowances, network access, credits,
// priority flags) — Supporter is a values purchase, not a feature unlock.
type SupporterMembershipResponse = {
  subscriptionTier?: SubscriptionTier
  supporterMembership?: {
    currentPlan?: SubscriptionTier
    supporterPriceMonthlyUsd?: number
    billingConfigured?: boolean
  }
}

export type SupporterMembershipState = {
  tier: SubscriptionTier
  isSupporter: boolean
  loading: boolean
  error: string | null
  supporterPriceMonthlyUsd: number
  billingConfigured: boolean
}

const DEFAULT_STATE: SupporterMembershipState = {
  tier: 'free',
  isSupporter: false,
  loading: true,
  error: null,
  supporterPriceMonthlyUsd: SUPPORTER_PRICE_MONTHLY_USD,
  billingConfigured: false,
}

export function useSupporterMembership(): SupporterMembershipState {
  const { data: session } = useSession()
  const [state, setState] = useState<SupporterMembershipState>(DEFAULT_STATE)

  useEffect(() => {
    if (!session?.user) {
      setState({
        ...DEFAULT_STATE,
        loading: false,
      })
      return
    }

    let cancelled = false

    fetch('/v1/auth/profile', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        return res.json() as Promise<SupporterMembershipResponse>
      })
      .then((data) => {
        if (cancelled) {
          return
        }

        const tier = data.subscriptionTier ?? 'free'
        const isSupporter = tier === 'supporter' || tier === 'enterprise'
        const membership = data.supporterMembership

        setState({
          tier,
          isSupporter,
          loading: false,
          error: null,
          supporterPriceMonthlyUsd:
            membership?.supporterPriceMonthlyUsd ?? SUPPORTER_PRICE_MONTHLY_USD,
          billingConfigured: membership?.billingConfigured ?? false,
        })
      })
      .catch((err) => {
        if (cancelled) {
          return
        }

        setState({
          ...DEFAULT_STATE,
          loading: false,
          error: err instanceof Error ? err.message : 'Unable to load supporter membership.',
        })
      })

    return () => {
      cancelled = true
    }
  }, [session?.user?.id])

  return state
}
