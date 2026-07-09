// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'

let mockPathname = '/chat'
let mockSearchParams = new URLSearchParams()
const { clearClientStateMock } = vi.hoisted(() => ({
  clearClientStateMock: vi.fn().mockResolvedValue(undefined),
}))
const { signOutCurrentUserMock } = vi.hoisted(() => ({
  signOutCurrentUserMock: vi.fn().mockResolvedValue(undefined),
}))
// settleWithinBudget is unit-tested in lib/auth.test.ts; here it stands in as the
// bound that resolves regardless of whether the cleanup work settles, so these
// tests assert the handler routes cleanup THROUGH it (never a raw unbounded await).
const { settleWithinBudgetMock, MOCK_CLEANUP_BUDGET_MS } = vi.hoisted(() => ({
  settleWithinBudgetMock: vi.fn().mockResolvedValue(undefined),
  MOCK_CLEANUP_BUDGET_MS: 4000,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => mockSearchParams,
}))

vi.mock('../../lib/auth', () => ({
  clearClientState: clearClientStateMock,
  signOutCurrentUser: signOutCurrentUserMock,
  settleWithinBudget: settleWithinBudgetMock,
  CLIENT_CLEANUP_BUDGET_MS: MOCK_CLEANUP_BUDGET_MS,
}))

vi.mock('../sidebar/ConversationList', () => ({
  ConversationList: ({ variant }: { variant?: string }) => (
    <div data-testid="conversation-list" data-variant={variant}>
      ConversationList
    </div>
  ),
}))

vi.mock('../nav/ThemeToggle', () => ({
  ThemeToggle: () => <div data-testid="theme-toggle">ThemeToggle</div>,
}))

vi.mock('../EcoLogo', () => ({
  EcoLogo: () => <span data-testid="eco-logo">EcoLogo</span>,
}))

import { Sidebar } from '../layout/Sidebar'

describe('Sidebar', () => {
  const originalLocation = window.location

  beforeEach(() => {
    mockPathname = '/chat'
    mockSearchParams = new URLSearchParams()
    signOutCurrentUserMock.mockReset()
    signOutCurrentUserMock.mockResolvedValue(undefined)
    clearClientStateMock.mockReset()
    clearClientStateMock.mockResolvedValue(undefined)
    settleWithinBudgetMock.mockReset()
    settleWithinBudgetMock.mockResolvedValue(undefined)
    Object.defineProperty(window, 'location', {
      value: {
        ...originalLocation,
        replace: vi.fn(),
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('renders the launch IA links', () => {
    render(<Sidebar onNewChat={vi.fn()} />)

    expect(screen.getByText('Chat')).toBeInTheDocument()
    expect(screen.getByText('Models')).toBeInTheDocument()
    expect(screen.getByText('Learn')).toBeInTheDocument()
    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByText('Support')).toBeInTheDocument()
    expect(screen.getByText('Account')).toBeInTheDocument()
    expect(screen.getByText('Account & support')).toBeInTheDocument()
    expect(screen.queryByText('Billing')).not.toBeInTheDocument()
    expect(screen.getByText('Privacy')).toBeInTheDocument()
    expect(screen.getByText('Transparency')).toBeInTheDocument()
    expect(screen.getByText('Terms')).toBeInTheDocument()
  })

  it('renders "New chat" button', () => {
    render(<Sidebar onNewChat={vi.fn()} />)
    expect(screen.getByText('New chat')).toBeInTheDocument()
  })

  it('renders model management and support entry links', () => {
    render(<Sidebar onNewChat={vi.fn()} />)
    expect(screen.getByText('Chat').closest('a')).toHaveAttribute('href', '/chat')
    expect(screen.getByText('Models').closest('a')).toHaveAttribute('href', '/settings?tab=models')
    expect(screen.getByText('Support').closest('a')).toHaveAttribute('href', '/settings?tab=support')
    expect(screen.getByText('Learn').closest('a')).toHaveAttribute('href', '/impact?returnTo=%2Fchat')
  })

  it('orders account and support links as Appearance, Account, then Support', () => {
    render(<Sidebar onNewChat={vi.fn()} />)

    const appearance = screen.getByText('Appearance')
    const account = screen.getByText('Account')
    const support = screen.getByText('Support')

    expect(appearance.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(account.compareDocumentPosition(support) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('adds trailing arrow affordances to trust links', () => {
    render(<Sidebar onNewChat={vi.fn()} />)

    for (const label of ['Privacy', 'Transparency', 'Terms']) {
      expect(screen.getByText(label).closest('a')!.querySelectorAll('svg')).toHaveLength(2)
    }
  })

  it('does not render retired governance navigation', () => {
    render(<Sidebar onNewChat={vi.fn()} />)
    expect(screen.queryByText('Governance')).not.toBeInTheDocument()
  })

  it('renders "Sign out" button', () => {
    render(<Sidebar onNewChat={vi.fn()} />)
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })

  it('swaps sign-out controls for guest upgrade actions in guest mode', () => {
    render(<Sidebar onNewChat={vi.fn()} viewerMode="guest" />)

    expect(screen.queryByText('Sign out')).not.toBeInTheDocument()
    expect(screen.getByText('Create account')).toBeInTheDocument()
    expect(screen.getByText('Sign in')).toBeInTheDocument()
  })

  it('signs out on the server before clearing local account state and redirecting', async () => {
    const user = userEvent.setup()

    render(<Sidebar onNewChat={vi.fn()} />)
    await user.click(screen.getByText('Sign out'))

    expect(signOutCurrentUserMock).toHaveBeenCalledTimes(1)
    expect(clearClientStateMock).toHaveBeenCalledTimes(1)
    // Local cleanup is run through the bounded helper, not awaited directly.
    expect(settleWithinBudgetMock).toHaveBeenCalledTimes(1)
    expect(settleWithinBudgetMock.mock.calls[0]![1]).toBe(MOCK_CLEANUP_BUDGET_MS)
    expect(signOutCurrentUserMock.mock.invocationCallOrder[0]!).toBeLessThan(
      clearClientStateMock.mock.invocationCallOrder[0]!,
    )
    expect(window.location.replace).toHaveBeenCalledWith('/sign-in?signedOut=1&callbackUrl=%2Fchat')
  })

  it('still redirects when local cleanup never settles (the "Signing you out…" hang guard)', async () => {
    const user = userEvent.setup()
    // Reproduce the production hang: a teardown await that never resolves.
    clearClientStateMock.mockReturnValueOnce(new Promise<void>(() => {
      /* never resolves — the stalled service-worker / IndexedDB teardown */
    }))

    render(<Sidebar onNewChat={vi.fn()} />)
    await user.click(screen.getByText('Sign out'))

    // The bound returns despite the stalled cleanup, so the user is never trapped.
    expect(settleWithinBudgetMock).toHaveBeenCalledTimes(1)
    expect(window.location.replace).toHaveBeenCalledWith('/sign-in?signedOut=1&callbackUrl=%2Fchat')
  })

  it('covers the app with a calm signing-out state while local data clears', async () => {
    const user = userEvent.setup()
    let resolveSignOut: (() => void) | undefined
    signOutCurrentUserMock.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveSignOut = resolve
    }))

    render(<Sidebar onNewChat={vi.fn()} />)
    await user.click(screen.getByText('Sign out'))

    expect(screen.getByRole('status')).toHaveTextContent(/signing you out/i)
    expect(screen.getByRole('button', { name: /signing out/i })).toBeDisabled()

    resolveSignOut?.()
  })

  it('keeps local state intact and shows an error when sign out fails', async () => {
    const user = userEvent.setup()
    signOutCurrentUserMock.mockRejectedValueOnce(new Error('network unavailable'))

    render(<Sidebar onNewChat={vi.fn()} />)
    await user.click(screen.getByText('Sign out'))

    expect(signOutCurrentUserMock).toHaveBeenCalledTimes(1)
    expect(clearClientStateMock).not.toHaveBeenCalled()
    expect(settleWithinBudgetMock).not.toHaveBeenCalled()
    expect(window.location.replace).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not sign you out/i)
  })

  it('calls onNewChat when "New chat" is clicked', async () => {
    const user = userEvent.setup()
    const onNewChat = vi.fn()
    render(<Sidebar onNewChat={onNewChat} />)
    await user.click(screen.getByText('New chat'))
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('nests recent chats directly under the Chat workspace item', () => {
    render(<Sidebar onNewChat={vi.fn()} />)

    const chatLink = screen.getByText('Chat').closest('a')!
    const conversationList = screen.getByTestId('conversation-list')

    expect(chatLink).toHaveAttribute('href', '/chat')
    expect(chatLink).toHaveAttribute('aria-current', 'page')
    expect(conversationList).toHaveAttribute('data-variant', 'nested')
    expect(screen.getByText('Recent chats')).toBeInTheDocument()
  })

  it('toggles the nested recent chats dropdown without changing the Chat link', async () => {
    const user = userEvent.setup()

    render(<Sidebar onNewChat={vi.fn()} />)

    const hideButton = screen.getByRole('button', { name: 'Hide recent chats' })
    expect(hideButton).toHaveAttribute('aria-expanded', 'true')
    const controlsId = hideButton.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    expect(document.getElementById(controlsId!)).toContainElement(screen.getByTestId('conversation-list'))
    expect(screen.getByTestId('conversation-list')).toBeInTheDocument()

    await user.click(hideButton)

    const showButton = screen.getByRole('button', { name: 'Show recent chats' })
    expect(showButton).toHaveAttribute('aria-expanded', 'false')
    expect(showButton).toHaveAttribute('aria-controls', controlsId)
    expect(document.getElementById(controlsId!)).not.toBeInTheDocument()
    expect(screen.queryByTestId('conversation-list')).not.toBeInTheDocument()
    expect(screen.getByText('Chat').closest('a')).toHaveAttribute('href', '/chat')

    await user.click(showButton)

    expect(screen.getByRole('button', { name: 'Hide recent chats' })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(controlsId!)).toContainElement(screen.getByTestId('conversation-list'))
    expect(screen.getByTestId('conversation-list')).toBeInTheDocument()
  })

  it('keeps recent chat disclosure ids unique across sidebar instances', () => {
    render(
      <>
        <Sidebar onNewChat={vi.fn()} />
        <Sidebar onNewChat={vi.fn()} />
      </>,
    )

    const toggles = screen.getAllByRole('button', { name: 'Hide recent chats' })
    const controlsIds = toggles.map((button) => button.getAttribute('aria-controls'))
    expect(new Set(controlsIds).size).toBe(2)
    for (const controlsId of controlsIds) {
      expect(controlsId).toBeTruthy()
      expect(document.getElementById(controlsId!)).toBeInTheDocument()
    }
  })

  it('renders close button when onClose is provided', () => {
    render(<Sidebar onNewChat={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Close sidebar')).toBeInTheDocument()
  })

  it('fills the mobile bottom-sheet width when rendered with an onClose handler', () => {
    const { container } = render(<Sidebar onNewChat={vi.fn()} onClose={vi.fn()} />)
    const sidebar = container.querySelector('aside')

    expect(sidebar).toHaveStyle({ width: '100%' })
    expect(sidebar).toHaveClass('max-w-full')
  })

  it('does not render close button when onClose is not provided', () => {
    render(<Sidebar onNewChat={vi.fn()} />)
    expect(screen.queryByLabelText('Close sidebar')).not.toBeInTheDocument()
  })

  it('renders icons alongside expanded launch IA links', () => {
    render(<Sidebar onNewChat={vi.fn()} />)
    const learnLink = screen.getByText('Learn').closest('a')!
    expect(learnLink.querySelector('svg')).toBeTruthy()
    const supportLink = screen.getByText('Support').closest('a')!
    expect(supportLink.querySelector('svg')).toBeTruthy()
  })

  it('highlights learn link for the impact page', () => {
    mockPathname = '/impact'
    render(<Sidebar onNewChat={vi.fn()} />)
    const learnLink = screen.getByText('Learn').closest('a')!
    expect(learnLink.className).toContain('border-l-2')
    expect(learnLink.className).toContain('text-[var(--eco-primary)]')

    const chatLink = screen.getByText('Chat').closest('a')!
    expect(chatLink.className).not.toContain('border-l-2')
    mockPathname = '/chat'
  })

  it('highlights the models entry when on the models settings tab', () => {
    mockPathname = '/settings'
    mockSearchParams = new URLSearchParams('tab=models')
    render(<Sidebar onNewChat={vi.fn()} />)
    const modelsLink = screen.getByText('Models').closest('a')!
    expect(modelsLink.className).toContain('border-l-2')

    const supportLink = screen.getByText('Support').closest('a')!
    expect(supportLink.className).not.toContain('border-l-2')
    mockPathname = '/chat'
    mockSearchParams = new URLSearchParams()
  })

  it('keeps billing out of the sidebar even when the billing settings tab is selected', () => {
    mockPathname = '/settings'
    mockSearchParams = new URLSearchParams('tab=billing')
    render(<Sidebar onNewChat={vi.fn()} />)

    expect(screen.queryByText('Billing')).not.toBeInTheDocument()

    mockPathname = '/chat'
    mockSearchParams = new URLSearchParams()
  })

  it('keeps the active route obvious when collapsed', () => {
    mockPathname = '/settings'
    mockSearchParams = new URLSearchParams('tab=models')
    render(<Sidebar onNewChat={vi.fn()} collapsed />)

    const modelsLink = screen.getByTitle('Models')
    expect(modelsLink).toHaveAttribute('aria-current', 'page')
    expect(modelsLink.className).toContain('bg-[var(--eco-primary-soft)]')

    mockPathname = '/chat'
    mockSearchParams = new URLSearchParams()
  })

  it('adds explicit aria-labels to collapsed icon-only controls', () => {
    render(<Sidebar onNewChat={vi.fn()} collapsed />)

    expect(screen.getByLabelText('Chat')).toHaveAttribute('aria-label', 'Chat')
    expect(screen.getByLabelText('Models')).toHaveAttribute('aria-label', 'Models')
    expect(screen.getByLabelText('Support')).toHaveAttribute('aria-label', 'Support')
    expect(screen.getByLabelText('New chat')).toHaveAttribute('aria-label', 'New chat')
    expect(screen.getByLabelText('Sign out')).toHaveAttribute('aria-label', 'Sign out')
    expect(screen.queryByTestId('conversation-list')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /recent chats/i })).not.toBeInTheDocument()
  })

  it('adds explicit aria-labels to collapsed guest upgrade controls', () => {
    render(<Sidebar onNewChat={vi.fn()} collapsed viewerMode="guest" />)

    expect(screen.getByLabelText('Create account')).toHaveAttribute('aria-label', 'Create account')
    expect(screen.getByLabelText('Sign in')).toHaveAttribute('aria-label', 'Sign in')
    expect(screen.queryByLabelText('Sign out')).not.toBeInTheDocument()
  })

  // C-14 folded the retired instructions / privacy / integrations tabs into the
  // Eco (models) tab, so their deep links resolve onto the Models rail item.
  it.each(['instructions', 'privacy', 'integrations'] as const)(
    'highlights the Models rail for the retired ?tab=%s deep link',
    (retiredTab) => {
      mockPathname = '/settings'
      mockSearchParams = new URLSearchParams(`tab=${retiredTab}`)
      render(<Sidebar onNewChat={vi.fn()} />)

      const modelsLink = screen.getByText('Models').closest('a')!
      expect(modelsLink.className).toContain('border-l-2')
      expect(modelsLink).toHaveAttribute('aria-current', 'page')

      mockPathname = '/chat'
      mockSearchParams = new URLSearchParams()
    },
  )

  it('preserves the current app location when trust links leave the shell', () => {
    mockPathname = '/settings'
    mockSearchParams = new URLSearchParams('tab=billing')
    render(<Sidebar onNewChat={vi.fn()} viewerMode="guest" />)

    expect(screen.getByText('Privacy').closest('a')).toHaveAttribute(
      'href',
      '/privacy?returnTo=%2Fsettings%3Ftab%3Dbilling',
    )
    expect(screen.getByText('Transparency').closest('a')).toHaveAttribute(
      'href',
      '/transparency?returnTo=%2Fsettings%3Ftab%3Dbilling',
    )
    expect(screen.getByText('Terms').closest('a')).toHaveAttribute(
      'href',
      '/terms?returnTo=%2Fsettings%3Ftab%3Dbilling',
    )

    mockPathname = '/chat'
    mockSearchParams = new URLSearchParams()
  })
})
