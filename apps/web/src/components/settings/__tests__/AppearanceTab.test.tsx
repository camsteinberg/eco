// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { AppearanceTab } from '../AppearanceTab'
import { useSettingsStore } from '../../../stores/settingsStore'
import { useThemeStore } from '../../../stores/themeStore'

vi.mock('../../../lib/sounds', () => ({
  playMessageSent: vi.fn(),
}))

describe('AppearanceTab', () => {
  beforeEach(() => {
    document.documentElement.className = ''
    document.documentElement.style.colorScheme = ''
    delete document.documentElement.dataset.fontSize
    useThemeStore.setState({ theme: 'system', resolved: 'light' })
    useSettingsStore.setState({ soundsEnabled: true, autoAcceptTools: false })
  })

  it('persists theme changes and exposes the selected theme to assistive tech', async () => {
    const user = userEvent.setup()

    render(<AppearanceTab />)

    const dark = screen.getByRole('button', { name: 'Dark' })
    await user.click(dark)

    expect(dark).toHaveAttribute('aria-pressed', 'true')
    expect(localStorage.getItem('eco-theme')).toBe('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('keeps mobile-visible controls at or above the 44px touch target baseline', () => {
    render(<AppearanceTab />)

    const controls = [
      screen.getByRole('button', { name: 'Light' }),
      screen.getByRole('button', { name: 'Dark' }),
      screen.getByRole('button', { name: 'System' }),
      screen.getByRole('button', { name: 'Default' }),
      screen.getByRole('button', { name: 'Compact' }),
      screen.getByRole('button', { name: 'Comfortable' }),
      screen.getByRole('switch', { name: 'Toggle sound effects' }),
      screen.getByRole('button', { name: 'Preview sound effect' }),
      screen.getByRole('switch', { name: 'Toggle auto-accept tools' }),
    ]

    for (const control of controls) {
      expect(control.className).toContain('min-h-11')
    }
  })

  it('removes transition motion when the user prefers reduced motion', () => {
    render(<AppearanceTab />)

    expect(screen.getByRole('button', { name: 'Dark' }).className).toContain(
      'motion-reduce:transition-none',
    )
    expect(screen.getByRole('switch', { name: 'Toggle sound effects' }).className).toContain(
      'motion-reduce:transition-none',
    )
  })
})
