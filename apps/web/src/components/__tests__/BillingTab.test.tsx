// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom'

let mockSearchParams = new URLSearchParams()
let mockMembership = {
  tier: 'free',
  isSupporter: false,
  loading: false,
  error: null,
  supporterPriceMonthlyUsd: 15,
  billingConfigured: true,
}

vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

vi.mock('../../hooks/useSupporterMembership', () => ({
  useSupporterMembership: () => mockMembership,
}))

vi.mock('../pricing/PricingCard', () => ({
  PricingCard: ({
    tier,
    current,
    features,
    onSelect,
    ctaLabel = 'Become a Supporter',
  }: {
    tier: string
    current?: boolean
    features: string[]
    onSelect?: () => void
    ctaLabel?: string
  }) => (
    <div data-testid={`pricing-${tier.toLowerCase()}`}>
      {tier}
      {current && <span>Current</span>}
      <ul>
        {features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      {onSelect && !current && (
        <button type="button" onClick={onSelect}>
          {ctaLabel}
        </button>
      )}
    </div>
  ),
}))

import { BillingTab } from '../settings/BillingTab'

const originalLocation = window.location

describe('BillingTab', () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams()
    mockMembership = {
      tier: 'free',
      isSupporter: false,
      loading: false,
      error: null,
      supporterPriceMonthlyUsd: 15,
      billingConfigured: true,
    }
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: 'https://eco.local/settings?tab=billing',
      },
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders current plan as "Free" with the Your plan section', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: 42 }),
    }))
    render(<BillingTab />)
    expect(screen.getByRole('heading', { name: /your plan/i })).toBeInTheDocument()
    expect(screen.getAllByText('Free').length).toBeGreaterThan(0)
  })

  it('renders both tiers as a values pitch with identical functionality', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }))
    render(<BillingTab />)

    expect(screen.getByTestId('pricing-free')).toBeInTheDocument()
    expect(screen.getByTestId('pricing-supporter')).toBeInTheDocument()
    // The two tiers are explicitly identical in function
    expect(screen.getByText('Same features on both. Always.')).toBeInTheDocument()
    expect(
      screen.getByText(/the complete product, no limits, no locked features/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/doesn't unlock anything extra/i),
    ).toBeInTheDocument()
    // Supporter CTA frames it as support, not a feature unlock
    expect(
      screen.getByRole('button', { name: 'Support Eco — $15/month' }),
    ).toBeInTheDocument()
  })

  it('does not ship any feature-gate or dead Eco Network copy', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }))
    render(<BillingTab />)
    // No tier-differentiated capability gating
    expect(screen.queryByText(/network access/i)).toBeNull()
    expect(screen.queryByText(/eco network credits/i)).toBeNull()
    expect(screen.queryByText(/credits today/i)).toBeNull()
    expect(screen.queryByText(/daily/i)).toBeNull()
    // No leftover placeholder copy
    expect(screen.queryByText(/after rollout/i)).toBeNull()
    expect(screen.queryByText(/contributor access opens/i)).toBeNull()
    expect(screen.queryByText(/additive value/i)).toBeNull()
    expect(screen.queryByText(/until stripe is configured/i)).toBeNull()
  })

  it('shows supporter state with the Manage subscription button', () => {
    mockMembership = {
      ...mockMembership,
      tier: 'supporter',
      isSupporter: true,
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }))

    render(<BillingTab />)

    expect(screen.getByRole('button', { name: 'Manage subscription' })).toBeInTheDocument()
    // Supporter chip is shown next to plan name (separate from pricing card's "Supporter" tier name)
    expect(screen.getAllByText('Supporter').length).toBeGreaterThan(0)
  })

  it('shows billing return messaging when checkout comes back to billing', () => {
    mockSearchParams = new URLSearchParams('tab=billing&billing=success')
    mockMembership = {
      ...mockMembership,
      tier: 'supporter',
      isSupporter: true,
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }))

    render(<BillingTab />)

    expect(screen.getByText('Supporter membership is active')).toBeInTheDocument()
  })

  it('hides upgrade/manage buttons silently when billing is not configured', () => {
    mockMembership = {
      ...mockMembership,
      billingConfigured: false,
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: 42 }),
    }))

    render(<BillingTab />)

    // No "Checkout unavailable here" / "Billing unavailable here" / "until Stripe is configured" copy leaks
    expect(screen.queryByRole('button', { name: /become a supporter/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /checkout unavailable/i })).toBeNull()
    expect(screen.queryByText(/until stripe is configured/i)).toBeNull()
    expect(screen.queryByText(/supporter checkout isn't configured/i)).toBeNull()
  })

  it('never fires checkout when billing is not configured (no clickable upgrade affordance)', () => {
    mockMembership = {
      ...mockMembership,
      billingConfigured: false,
      isSupporter: false,
      tier: 'free',
    }

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: 42 }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    render(<BillingTab />)

    // No element should reach the upgrade handler — neither the plan CTA nor the pricing card.
    expect(screen.queryByRole('button', { name: /become a supporter/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /support eco/i })).toBeNull()

    // No button anywhere in the billing surface can trigger /v1/billing/checkout.
    for (const button of screen.queryAllByRole('button')) {
      fireEvent.click(button)
    }
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/billing'),
      expect.anything(),
    )
  })

  it('fully hides Supporter for launch when billing is not configured for a free user', () => {
    mockMembership = {
      ...mockMembership,
      billingConfigured: false,
      isSupporter: false,
      tier: 'free',
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: 42 }),
    }))

    render(<BillingTab />)

    // Launch posture: no Supporter invitation at all — no CTA, no "coming soon"
    // mark, no Plans comparison, no funding pitch. Just the free plan.
    expect(screen.queryByText(/coming soon/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /become a supporter/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /support eco/i })).toBeNull()
    expect(screen.queryByTestId('pricing-supporter')).toBeNull()
    expect(screen.queryByText(/supporters fund eco/i)).toBeNull()
    expect(screen.queryByText(/same features on both/i)).toBeNull()
    // The free plan still reads clearly.
    expect(screen.getAllByText('Free').length).toBeGreaterThan(0)
  })

  it('does not show the "coming soon" affordance to a configured free user (live button instead)', () => {
    mockMembership = {
      ...mockMembership,
      billingConfigured: true,
      isSupporter: false,
      tier: 'free',
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: 42 }),
    }))

    render(<BillingTab />)

    expect(screen.getByRole('button', { name: 'Become a Supporter' })).toBeInTheDocument()
    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })

  it('does not show the "coming soon" affordance to an existing supporter (even if billing is unconfigured)', () => {
    mockMembership = {
      ...mockMembership,
      billingConfigured: false,
      isSupporter: true,
      tier: 'supporter',
    }

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ balance: 42 }),
    }))

    render(<BillingTab />)

    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })

  it('posts checkout requests and redirects only to trusted Stripe Checkout URLs', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/v1/billing/checkout')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_123' }),
        })
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ balance: 42 }),
      })
    }))

    render(<BillingTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Become a Supporter' }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/v1/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'supporter' }),
        credentials: 'include',
      })
    })
    expect(window.location.href).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
  })

  it('refuses untrusted checkout redirects from a configured billing environment', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/v1/billing/checkout')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ url: 'https://evil.example/phish' }),
        })
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ balance: 42 }),
      })
    }))

    render(<BillingTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Become a Supporter' }))

    expect(await screen.findByText("We couldn't start checkout. Please try again.")).toBeInTheDocument()
    expect(window.location.href).toBe('https://eco.local/settings?tab=billing')
  })

  it('posts portal requests and redirects only to trusted Stripe Billing Portal URLs', async () => {
    mockMembership = {
      ...mockMembership,
      tier: 'supporter',
      isSupporter: true,
    }
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/v1/billing/portal')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ url: 'https://billing.stripe.com/p/session/test_123' }),
        })
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      })
    }))

    render(<BillingTab />)

    fireEvent.click(screen.getByRole('button', { name: 'Manage subscription' }))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/v1/billing/portal', {
        method: 'POST',
        credentials: 'include',
      })
    })
    expect(window.location.href).toBe('https://billing.stripe.com/p/session/test_123')
  })
})
