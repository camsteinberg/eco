// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import '@testing-library/jest-dom'
import { EcoLogo } from '../EcoLogo'

describe('EcoLogo', () => {
  it('renders the wordmark', () => {
    render(<EcoLogo />)
    expect(screen.getByText('eco')).toBeInTheDocument()
  })

  it('renders the leaf icon with aria-label', () => {
    render(<EcoLogo />)
    expect(screen.getByLabelText('Eco logo')).toBeInTheDocument()
  })

  it('hides wordmark when iconOnly', () => {
    render(<EcoLogo iconOnly />)
    expect(screen.queryByText('eco')).not.toBeInTheDocument()
  })

  it('accepts size prop without error', () => {
    render(<EcoLogo size="lg" />)
    expect(screen.getByLabelText('Eco logo')).toBeInTheDocument()
  })
})
