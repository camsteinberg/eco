// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

import { SupportTab } from '../settings/SupportTab'

describe('SupportTab', () => {
  it('renders direct support channels from the app shell', () => {
    render(<SupportTab />)

    expect(screen.getByRole('link', { name: /support@econetwork\.ai/i })).toHaveAttribute('href', 'mailto:support@econetwork.ai')
  })

  it('links trust resources back into chat-safe return paths', () => {
    render(<SupportTab />)

    expect(screen.getByRole('link', { name: /how eco saves water/i })).toHaveAttribute('href', '/impact?returnTo=%2Fchat')
    expect(screen.getByRole('link', { name: /^transparency$/i })).toHaveAttribute('href', '/transparency?returnTo=%2Fchat')
    expect(screen.getByRole('link', { name: /^privacy policy$/i })).toHaveAttribute('href', '/privacy?returnTo=%2Fchat')
    expect(screen.getByRole('link', { name: /^terms$/i })).toHaveAttribute('href', '/terms?returnTo=%2Fchat')
  })
})
