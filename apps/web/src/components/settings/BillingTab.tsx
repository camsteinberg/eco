// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useSupporterMembership } from '../../hooks/useSupporterMembership'
import { PricingCard } from '../pricing/PricingCard'
import { Button } from '@eco/ui'
import { ErrorNotice } from '../ui/ErrorNotice'
import { SettingsSection } from './SettingsSection'

function getTrustedBillingRedirect(url: unknown): string | null {
  if (typeof url !== 'string') {
    return null
  }

  try {
    const parsed = new URL(url)
    if (
      parsed.protocol === 'https:'
      && (parsed.hostname === 'checkout.stripe.com' || parsed.hostname === 'billing.stripe.com')
    ) {
      return parsed.toString()
    }
  } catch {
    return null
  }

  return null
}

export function BillingTab() {
  const searchParams = useSearchParams()
  const {
    tier,
    isSupporter: isPaid,
    error: membershipError,
    supporterPriceMonthlyUsd,
    billingConfigured,
  } = useSupporterMembership()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastActionRef = useRef<'upgrade' | 'manage'>('upgrade')
  const billingStatus = searchParams.get('billing')

  const planLabel = tier === 'enterprise' ? 'Enterprise' : isPaid ? 'Supporter' : 'Free'

  const statusBanner = useMemo(() => {
    if (billingStatus === 'success') {
      return {
        tone: 'success' as const,
        title: 'Supporter membership is active',
        description: 'Thanks for backing Eco.',
      }
    }

    if (billingStatus === 'canceled') {
      return {
        tone: 'neutral' as const,
        title: 'Checkout was canceled',
        description: 'Nothing changed. Come back whenever you want.',
      }
    }

    return null
  }, [billingStatus])

  async function handleUpgrade() {
    if (!billingConfigured) return

    lastActionRef.current = 'upgrade'
    setLoading(true)
    setError(null)
    try {
      const apiUrl = ''
      const res = await fetch(`${apiUrl}/v1/billing/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'supporter' }),
        credentials: 'include',
      })
      const data = await res.json()
      const trustedRedirect = getTrustedBillingRedirect(data.url)
      if (trustedRedirect) {
        window.location.href = trustedRedirect
      } else {
        setError('We couldn\'t start checkout. Please try again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We couldn\'t connect to billing. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleManage() {
    if (!billingConfigured) return

    lastActionRef.current = 'manage'
    setLoading(true)
    setError(null)
    try {
      const apiUrl = ''
      const res = await fetch(`${apiUrl}/v1/billing/portal`, {
        method: 'POST',
        credentials: 'include',
      })
      const data = await res.json()
      const trustedRedirect = getTrustedBillingRedirect(data.url)
      if (trustedRedirect) {
        window.location.href = trustedRedirect
      } else {
        setError('We couldn\'t open billing. Please try again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'We couldn\'t connect to billing. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const planSummary = isPaid
    ? "You're a Supporter — thank you for keeping Eco independent."
    : billingConfigured
      ? 'You have the complete product, free forever. Supporters fund Eco so it stays private and ad-free — same features, either way.'
      : 'You have the complete product, free forever — every feature, no limits.'

  return (
    <div>
      {statusBanner && (
        <div
          className="mb-8 border-l-2 pl-4"
          style={{
            borderColor:
              statusBanner.tone === 'success'
                ? 'var(--eco-primary)'
                : 'var(--eco-border)',
          }}
        >
          <p
            className="text-sm font-medium"
            style={{
              color:
                statusBanner.tone === 'success'
                  ? 'var(--eco-primary)'
                  : 'var(--eco-text)',
            }}
          >
            {statusBanner.title}
          </p>
          <p className="mt-1 text-sm text-[var(--eco-text-secondary)]">{statusBanner.description}</p>
        </div>
      )}

      <SettingsSection title="Your plan" hairline={false}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-prose">
            <div className="flex items-center gap-3">
              <p className="text-xl font-medium text-[var(--eco-text)]">{planLabel}</p>
              {isPaid && (
                <span
                  className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--eco-primary-soft)',
                    color: 'var(--eco-primary)',
                  }}
                >
                  Supporter
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-[var(--eco-text-secondary)]">{planSummary}</p>
            {membershipError && (
              <p className="mt-2 text-sm text-[var(--eco-text-secondary)]">
                We couldn&apos;t refresh your latest membership details right now.
              </p>
            )}
          </div>
          {billingConfigured ? (
            isPaid ? (
              <button
                type="button"
                onClick={handleManage}
                disabled={loading}
                className="border px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:bg-[var(--eco-primary-soft)] disabled:opacity-50"
                style={{
                  borderColor: 'var(--eco-border)',
                  borderRadius: 'var(--eco-radius-md)',
                }}
              >
                Manage subscription
              </button>
            ) : (
              <button
                type="button"
                onClick={handleUpgrade}
                disabled={loading}
                className="bg-[var(--eco-primary)] px-4 py-2 text-sm font-medium text-[var(--eco-on-primary)] transition-colors hover:opacity-90 disabled:opacity-50"
                style={{ borderRadius: 'var(--eco-radius-md)' }}
              >
                Become a Supporter
              </button>
            )
          ) : null}
        </div>
        {error && (
          <ErrorNotice
            className="mt-4"
            lead="Billing hiccup"
            detail={error}
            actions={
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setError(null)
                  if (lastActionRef.current === 'manage') {
                    void handleManage()
                  } else {
                    void handleUpgrade()
                  }
                }}
              >
                Try again
              </Button>
            }
          />
        )}
      </SettingsSection>

      {(billingConfigured || isPaid) && (
        <SettingsSection title="Plans">
          <p className="mb-5 text-sm text-[var(--eco-text-secondary)]">
            Same features on both. Always.
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <PricingCard
              tier="Free"
              price="$0"
              period="forever"
              features={[
                'Chat runs on your device — the complete product, no limits, no locked features.',
              ]}
              current={!isPaid}
            />
            <PricingCard
              tier="Supporter"
              price={`$${String(supporterPriceMonthlyUsd)}`}
              period="month"
              features={[
                "Exactly the same Eco. Becoming a Supporter doesn't unlock anything extra — it keeps Eco independent and private, funded by the people who use it instead of advertisers or data deals.",
                "You'll wear a small Supporter badge, and you'll have our thanks.",
              ]}
              current={isPaid}
              ctaLabel={`Support Eco — $${String(supporterPriceMonthlyUsd)}/month`}
              onSelect={isPaid || !billingConfigured ? undefined : handleUpgrade}
              comingSoon={!billingConfigured}
            />
          </div>
        </SettingsSection>
      )}
    </div>
  )
}
