// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { act, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { AppShell } from '../layout/AppShell'
import { useChatStore } from '../../stores/chatStore'
import { setAccountDeletionInProgress } from '../../lib/account-lifecycle'
import { OPEN_SHARE_CONVERSATION_EVENT } from '../../lib/share-conversation-event'

const mockState = vi.hoisted(() => ({
  pathname: '/chat',
  searchParams: new URLSearchParams(),
  sessionData: {
    user: { id: '1', email: 'test@example.com' },
  } as { user: { id: string; email: string } } | null,
  isPending: false,
  activeConversationId: null as string | null,
  replace: vi.fn(),
  push: vi.fn(),
  clearUnsafeClientState: vi.fn(),
  bestEffortSignOut: vi.fn().mockResolvedValue(undefined),
}))

const guestContextMocks = vi.hoisted(() => ({
  rememberGuestLocalContext: vi.fn(),
  clearGuestLocalContext: vi.fn(),
}))

const conversationStoreState = vi.hoisted(() => ({
  activeConversationId: null as string | null,
  conversations: [] as Array<{ id: string; title?: string }>,
  setActive: vi.fn((id: string | null) => {
    conversationStoreState.activeConversationId = id
  }),
  saveMessage: vi.fn(),
  updateConversation: vi.fn(),
}))

const chatHookMocks = vi.hoisted(() => ({
  interruptActiveGeneration: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockState.push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => mockState.pathname,
  useSearchParams: () => mockState.searchParams,
}))

vi.mock('../../lib/auth', () => ({
  useSession: () => ({ data: mockState.sessionData, isPending: mockState.isPending }),
  clearUnsafeClientState: mockState.clearUnsafeClientState,
  bestEffortSignOut: mockState.bestEffortSignOut,
}))

vi.mock('../../lib/auth-continuation', async () => {
  const actual = await vi.importActual<typeof import('../../lib/auth-continuation')>(
    '../../lib/auth-continuation',
  )

  return {
    ...actual,
    buildAuthPageHref: (_basePath: '/sign-in' | '/sign-up', options: { callbackUrl?: string | null }) => {
      const params = new URLSearchParams()
      if (options.callbackUrl) {
        params.set('callbackUrl', actual.sanitizeRelativeUrl(options.callbackUrl, '/chat'))
      }
      return `/sign-in?${params.toString()}`
    },
  }
})

vi.mock('../../lib/guest-local-context', () => ({
  rememberGuestLocalContext: guestContextMocks.rememberGuestLocalContext,
  clearGuestLocalContext: guestContextMocks.clearGuestLocalContext,
}))

vi.mock('../../stores/conversationStore', () => ({
  useConversationStore: Object.assign(
    (selector: (state: typeof conversationStoreState) => unknown) =>
      selector(conversationStoreState),
    {
      getState: () => conversationStoreState,
    },
  ),
}))

vi.mock('../../hooks/useChat', () => ({
  interruptActiveGeneration: chatHookMocks.interruptActiveGeneration,
}))

vi.mock('../layout/Sidebar', () => ({
  Sidebar: ({ onNewChat }: { onNewChat: () => void }) => (
    <div data-testid="sidebar">
      <button type="button" onClick={onNewChat}>New chat</button>
    </div>
  ),
}))

vi.mock('../layout/Header', () => ({
  Header: ({ title, onToggleSidebar }: { title: string; onToggleSidebar: () => void }) => (
    <div data-testid="header">
      <span>{title}</span>
      <button type="button" onClick={onToggleSidebar} aria-label="Toggle sidebar">Menu</button>
    </div>
  ),
}))

describe('AppShell', () => {
  beforeEach(() => {
    setAccountDeletionInProgress(false)
    mockState.pathname = '/chat'
    mockState.searchParams = new URLSearchParams()
    mockState.sessionData = { user: { id: '1', email: 'test@example.com' } }
    mockState.isPending = false
    mockState.replace.mockReset()
    mockState.push.mockReset()
    mockState.clearUnsafeClientState.mockReset()
    mockState.bestEffortSignOut.mockReset()
    mockState.bestEffortSignOut.mockResolvedValue(undefined)
    guestContextMocks.rememberGuestLocalContext.mockReset()
    guestContextMocks.clearGuestLocalContext.mockReset()
    conversationStoreState.activeConversationId = null
    conversationStoreState.conversations = []
    conversationStoreState.setActive.mockClear()
    conversationStoreState.saveMessage.mockClear()
    conversationStoreState.updateConversation.mockClear()
    chatHookMocks.interruptActiveGeneration.mockReset()
    useChatStore.setState({ composerDraft: '' })

    Object.defineProperty(window, 'location', {
      value: {
        ...window.location,
        replace: mockState.replace,
      },
      writable: true,
      configurable: true,
    })
  })

  it('keeps the current settings surface mounted while an intentional account deletion redirect is in flight', async () => {
    mockState.pathname = '/settings'

    const { rerender } = render(<AppShell><div>Deleting account…</div></AppShell>)

    expect(screen.getByText('Deleting account…')).toBeInTheDocument()

    setAccountDeletionInProgress(true)
    mockState.sessionData = null

    rerender(<AppShell><div>Deleting account…</div></AppShell>)

    await waitFor(() => {
      expect(screen.getByText('Deleting account…')).toBeInTheDocument()
    })
    expect(screen.queryByText('Redirecting to sign in...')).not.toBeInTheDocument()
    expect(mockState.replace).not.toHaveBeenCalled()
    expect(mockState.clearUnsafeClientState).not.toHaveBeenCalled()
    expect(mockState.bestEffortSignOut).not.toHaveBeenCalled()
  })

  it('renders header and content', () => {
    render(<AppShell><div>Chat content</div></AppShell>)
    expect(screen.getByTestId('header')).toBeInTheDocument()
    expect(screen.getByText('Chat content')).toBeInTheDocument()
  })

  it('shows "New chat" as default title', () => {
    render(<AppShell><div>Chat</div></AppShell>)
    const header = screen.getByTestId('header')
    expect(header).toHaveTextContent('New chat')
  })

  it('opens the conversation share dialog from the chat share event', () => {
    conversationStoreState.activeConversationId = 'conv-123'
    conversationStoreState.conversations = [{ id: 'conv-123', title: 'Local chat' }]

    render(<AppShell><div>Chat</div></AppShell>)

    act(() => {
      window.dispatchEvent(new Event(OPEN_SHARE_CONVERSATION_EVENT))
    })

    const dialog = screen.getByRole('dialog', { name: /share conversation/i })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByText('Local chat')).toBeInTheDocument()
  })

  it('allows guests to stay on guest-safe app routes', () => {
    mockState.sessionData = null
    mockState.pathname = '/chat'

    render(<AppShell><div>Guest chat</div></AppShell>)

    expect(screen.getByText('Guest chat')).toBeInTheDocument()
    expect(mockState.replace).not.toHaveBeenCalled()
    expect(mockState.clearUnsafeClientState).not.toHaveBeenCalled()
  })

  it('keeps guest-safe routes mounted while auth session hydration is still pending', () => {
    mockState.sessionData = null
    mockState.isPending = true
    mockState.pathname = '/chat'

    render(<AppShell><div>Guest chat</div></AppShell>)

    expect(screen.getByText('Guest chat')).toBeInTheDocument()
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
    expect(mockState.replace).not.toHaveBeenCalled()
  })

  it('does not clear guest context on the initial blank-chat mount', () => {
    render(<AppShell><div>Fresh chat</div></AppShell>)

    expect(guestContextMocks.clearGuestLocalContext).not.toHaveBeenCalled()
  })

  it('persists guest composer draft changes while staying on /chat', async () => {
    render(<AppShell><div>Guest chat</div></AppShell>)

    act(() => {
      useChatStore.getState().setComposerDraft('Keep this local')
    })

    await waitFor(() => {
      expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
        activeConversationId: null,
        composerDraft: 'Keep this local',
      })
    })
  })

  it('drops only the stored conversation id when the active conversation transitions to null', async () => {
    conversationStoreState.activeConversationId = 'conv-123'
    const { rerender } = render(<AppShell><div>Chat</div></AppShell>)

    await waitFor(() => {
      expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
        activeConversationId: 'conv-123',
        composerDraft: '',
      })
    })

    guestContextMocks.rememberGuestLocalContext.mockClear()
    conversationStoreState.activeConversationId = null

    rerender(<AppShell><div>Chat</div></AppShell>)

    await waitFor(() => {
      expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
        activeConversationId: null,
        composerDraft: '',
      })
    })
    expect(guestContextMocks.clearGuestLocalContext).not.toHaveBeenCalled()
  })

  it('redirects guest access to hard member-only routes into sign-in with canonical chat return', async () => {
    mockState.sessionData = null
    mockState.pathname = '/admin'

    render(<AppShell><div>Protected admin</div></AppShell>)

    expect(screen.getByRole('link', { name: /continue to sign in/i })).toHaveAttribute(
      'href',
      '/sign-in?callbackUrl=%2Fchat',
    )

    await waitFor(() => {
      expect(mockState.clearUnsafeClientState).toHaveBeenCalled()
      expect(mockState.bestEffortSignOut).toHaveBeenCalled()
      expect(mockState.replace).toHaveBeenCalledWith('/sign-in?callbackUrl=%2Fchat')
    })
  })

  it('redirects guests away from the retired governance surface into sign-in', async () => {
    // /governance moved to the eco-desktop product, so it is retired — a guest can
    // no longer preview it and is bounced to auth with a canonical chat return.
    mockState.sessionData = null
    mockState.pathname = '/governance'

    render(<AppShell><div>Governance preview</div></AppShell>)

    expect(screen.getByRole('link', { name: /continue to sign in/i })).toHaveAttribute(
      'href',
      '/sign-in?callbackUrl=%2Fchat',
    )

    await waitFor(() => {
      expect(mockState.clearUnsafeClientState).toHaveBeenCalled()
      expect(mockState.bestEffortSignOut).toHaveBeenCalled()
      expect(mockState.replace).toHaveBeenCalledWith('/sign-in?callbackUrl=%2Fchat')
    })
  })

  it('returns guest auth detours with a draft back to /chat instead of the protected route', async () => {
    mockState.sessionData = null
    mockState.pathname = '/admin'
    useChatStore.getState().setComposerDraft('Keep this local')

    render(<AppShell><div>Protected admin</div></AppShell>)

    await waitFor(() => {
      expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
        activeConversationId: null,
        composerDraft: 'Keep this local',
      })
      expect(mockState.replace).toHaveBeenCalledWith('/sign-in?callbackUrl=%2Fchat')
    })
  })

  it('keeps guest billing previews mounted instead of forcing auth immediately', () => {
    mockState.sessionData = null
    mockState.pathname = '/settings'
    mockState.searchParams = new URLSearchParams('tab=billing')

    render(<AppShell><div>Billing preview</div></AppShell>)

    expect(screen.getByText('Billing preview')).toBeInTheDocument()
    expect(mockState.replace).not.toHaveBeenCalled()
  })

  it('does not overwrite the stored guest draft after protected-route cleanup clears live chat state', async () => {
    mockState.sessionData = null
    mockState.pathname = '/admin'
    useChatStore.getState().setComposerDraft('Keep this local')
    mockState.clearUnsafeClientState.mockImplementation(() => {
      useChatStore.getState().clearSessionState()
    })

    render(<AppShell><div>Protected admin</div></AppShell>)

    await waitFor(() => {
      expect(mockState.replace).toHaveBeenCalledWith('/sign-in?callbackUrl=%2Fchat')
    })

    expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
      activeConversationId: null,
      composerDraft: 'Keep this local',
    })
    expect(guestContextMocks.rememberGuestLocalContext).not.toHaveBeenCalledWith({
      activeConversationId: null,
      composerDraft: '',
    })
    expect(guestContextMocks.clearGuestLocalContext).not.toHaveBeenCalled()
  })

  it('starts the protected-route redirect only once while navigation is still in flight', async () => {
    mockState.sessionData = null
    mockState.pathname = '/admin'

    const { rerender } = render(<AppShell><div>Protected admin</div></AppShell>)

    rerender(<AppShell><div>Protected admin</div></AppShell>)

    await waitFor(() => {
      expect(mockState.bestEffortSignOut).toHaveBeenCalledTimes(1)
      expect(mockState.replace).toHaveBeenCalledTimes(1)
    })
  })

  it('redirects protected guest routes even if best-effort sign-out never resolves', async () => {
    mockState.sessionData = null
    mockState.pathname = '/admin'
    mockState.bestEffortSignOut.mockReturnValue(new Promise(() => undefined))

    render(<AppShell><div>Protected admin</div></AppShell>)

    await waitFor(() => {
      expect(mockState.bestEffortSignOut).toHaveBeenCalledTimes(1)
      expect(mockState.replace).toHaveBeenCalledWith('/sign-in?callbackUrl=%2Fchat')
    })
  })

  it('does not re-save a stale conversation when auth redirect happens from a fresh new-chat state', async () => {
    conversationStoreState.activeConversationId = 'conv-123'
    const { rerender } = render(<AppShell><div>Chat</div></AppShell>)

    await waitFor(() => {
      expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
        activeConversationId: 'conv-123',
        composerDraft: '',
      })
    })

    guestContextMocks.rememberGuestLocalContext.mockClear()
    guestContextMocks.clearGuestLocalContext.mockClear()

    conversationStoreState.activeConversationId = null
    mockState.sessionData = null
    mockState.pathname = '/admin'

    rerender(<AppShell><div>Protected admin</div></AppShell>)

    await waitFor(() => {
      expect(guestContextMocks.rememberGuestLocalContext).toHaveBeenCalledWith({
        activeConversationId: null,
        composerDraft: '',
      })
      expect(mockState.replace).toHaveBeenCalledWith('/sign-in?callbackUrl=%2Fchat')
    })
    expect(guestContextMocks.clearGuestLocalContext).not.toHaveBeenCalled()
  })

  it('interrupts and snapshots the active stream before starting a new chat', async () => {
    conversationStoreState.activeConversationId = 'conv-123'
    conversationStoreState.conversations = [{ id: 'conv-123', title: 'Current thread' }]
    useChatStore.setState({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: 'Keep this partial reply',
          createdAt: 1,
          parentId: null,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'Partial answer',
          createdAt: 2,
          parentId: 'user-1',
          status: 'streaming',
        },
      ],
      streamPhase: 'generating',
      isStreaming: true,
    })

    render(<AppShell><div>Chat content</div></AppShell>)

    await act(async () => {
      screen.getByRole('button', { name: /new chat/i }).click()
    })

    expect(chatHookMocks.interruptActiveGeneration).toHaveBeenCalledTimes(1)
    expect(conversationStoreState.saveMessage).toHaveBeenCalledTimes(2)
    expect(conversationStoreState.updateConversation).toHaveBeenCalledWith('conv-123', {
      activeLeafId: 'assistant-1',
    })
    expect(chatHookMocks.interruptActiveGeneration.mock.invocationCallOrder[0]!).toBeLessThan(
      conversationStoreState.updateConversation.mock.invocationCallOrder[0]!,
    )
    expect(conversationStoreState.setActive).toHaveBeenCalledWith(null)
    expect(mockState.push).toHaveBeenCalledWith('/chat')
  })
})
