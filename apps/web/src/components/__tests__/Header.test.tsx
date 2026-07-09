// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import '@testing-library/jest-dom'

const navigationMock = vi.hoisted(() => ({
  pathname: '/chat',
  push: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: navigationMock.push,
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => navigationMock.pathname,
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      customInstructions: '',
    }),
}))

import { Header } from '../layout/Header'

describe('Header', () => {
  beforeEach(() => {
    navigationMock.pathname = '/chat'
    navigationMock.push.mockReset()
  })

  it('renders without error', () => {
    render(<Header title="Test Chat" onToggleSidebar={vi.fn()} />)
    expect(screen.getByText('Test Chat')).toBeInTheDocument()
  })

  it('renders menu toggle button for mobile', () => {
    const { container } = render(<Header title="Test Chat" onToggleSidebar={vi.fn()} />)
    expect(screen.getByLabelText('Toggle sidebar')).toBeInTheDocument()
    expect(container.querySelector('header')).toHaveClass('overflow-hidden')
    expect(container.querySelector('header')).toHaveClass('min-h-14')
  })

  it('renders share button when showShareButton is true', () => {
    const handleShare = vi.fn()
    render(<Header title="Test Chat" onToggleSidebar={vi.fn()} showShareButton={true} onShare={handleShare} />)

    const shareBtn = screen.getByRole('button', { name: 'Share conversation' })
    expect(shareBtn).toBeInTheDocument()
    fireEvent.click(shareBtn)
    expect(handleShare).toHaveBeenCalled()
  })

  it('does not render share button when showShareButton is false', () => {
    render(<Header title="Test Chat" onToggleSidebar={vi.fn()} showShareButton={false} />)
    expect(screen.queryByRole('button', { name: 'Share conversation' })).not.toBeInTheDocument()
  })
})
