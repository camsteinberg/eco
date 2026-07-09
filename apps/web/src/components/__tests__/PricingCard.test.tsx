// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'
import { PricingCard } from '../pricing/PricingCard'

describe('PricingCard', () => {
  const baseProps = {
    tier: 'Supporter',
    price: '$15',
    period: 'month',
    features: ['Same Eco, funded by people instead of advertisers.'],
  }

  it('renders a clickable CTA when onSelect is provided and the card is not current', () => {
    let clicked = 0
    render(
      <PricingCard
        {...baseProps}
        ctaLabel="Support Eco — $15/month"
        onSelect={() => {
          clicked += 1
        }}
      />,
    )

    const cta = screen.getByRole('button', { name: 'Support Eco — $15/month' })
    expect(cta).toBeInTheDocument()
    cta.click()
    expect(clicked).toBe(1)
    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })

  it('renders an honest non-interactive "Coming soon" mark when comingSoon and no onSelect', () => {
    render(<PricingCard {...baseProps} comingSoon />)

    const comingSoon = screen.getByText(/coming soon/i)
    expect(comingSoon).toBeInTheDocument()
    // It must not be a clickable control.
    expect(comingSoon.closest('button')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not show "Coming soon" on the current plan even when comingSoon is set', () => {
    render(<PricingCard {...baseProps} comingSoon current />)

    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })

  it('leaves the CTA slot empty (no coming-soon) when neither onSelect nor comingSoon is set', () => {
    render(<PricingCard {...baseProps} />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/coming soon/i)).toBeNull()
  })
})
