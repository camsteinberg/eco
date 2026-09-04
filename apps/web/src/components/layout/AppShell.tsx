// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import Link from 'next/link'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { ShortcutsOverlay } from '../shortcuts/ShortcutsOverlay'
import { CommandPalette } from '../command/CommandPalette'
import { BottomSheet } from '../ui/BottomSheet'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { useConversationStore } from '../../stores/conversationStore'
import { useChatStore } from '../../stores/chatStore'
import { useSession, clearUnsafeClientState, bestEffortSignOut } from '../../lib/auth'
import { isAccountDeletionInProgress } from '../../lib/account-lifecycle'
import { ShareDialog } from '../share/ShareDialog'
import { exportConversationAsMarkdown, exportConversationAsJSON, downloadFile } from '../../lib/export'
import { useThemeStore } from '../../stores/themeStore'
import { SidebarErrorBoundary } from './SidebarErrorBoundary'
import { OfflineBanner } from './OfflineBanner'
import { buildAuthPageHref } from '../../lib/auth-continuation'
import { rememberGuestLocalContext } from '../../lib/guest-local-context'
import { startNewChat } from '../../lib/start-new-chat'
import { rememberPendingConversationSearch } from '../../lib/conversation-navigation'
import { canGuestAccessAppRoute, getViewerMode } from '../../lib/access-policy'
import { resolveSettingsTab } from '../settings/settingsNavigation'
import { OPEN_SHARE_CONVERSATION_EVENT } from '../../lib/share-conversation-event'
import { runLocalRuntimeSelfHeal } from '../../lib/local-runtime-self-heal'
import { bootstrapLocalAi } from '../../local-ai/bootstrap'
import { safeStorage } from '../../lib/local-storage'

const SIDEBAR_COLLAPSED_KEY = 'eco-sidebar-collapsed'

function getInitialCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return safeStorage.get(SIDEBAR_COLLAPSED_KEY) === 'true'
}

type AppShellProps = {
  children: React.ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const { data: session, isPending } = useSession()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(getInitialCollapsed)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const activeId = useConversationStore((s) => s.activeConversationId)
  const composerDraft = useChatStore((s) => s.composerDraft)
  const previousGuestContextRef = useRef<{
    activeConversationId: string | null
    composerDraft: string
  } | null>(null)
  const authRedirectStartedRef = useRef(false)
  const conversations = useConversationStore((s) => s.conversations)

  useEffect(() => {
    function handleOpenShareConversation() {
      if (useConversationStore.getState().activeConversationId) {
        setShareOpen(true)
      }
    }

    window.addEventListener(OPEN_SHARE_CONVERSATION_EVENT, handleOpenShareConversation)
    return () => window.removeEventListener(OPEN_SHARE_CONVERSATION_EVENT, handleOpenShareConversation)
  }, [])

  // Unstick users currently in production: clears stale download in-progress
  // markers and lets heavy-work leases expire on boot. Wrapped in try/catch
  // inside the helper so a corrupted localStorage entry never crashes the shell.
  useEffect(() => {
    runLocalRuntimeSelfHeal()
    void bootstrapLocalAi()
  }, [])

  const activeConv = conversations.find((c) => c.id === activeId)
  const title = activeConv?.title ?? 'New chat'

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const accountDeletionInProgress = isAccountDeletionInProgress()
  const viewerMode = getViewerMode(Boolean(session))
  const currentSearch = searchParams.toString()
  const requestedSettingsTab = searchParams.get('tab')
  const currentSettingsTab = requestedSettingsTab
    ? resolveSettingsTab(requestedSettingsTab)
    : viewerMode === 'guest'
      ? 'appearance'
      : resolveSettingsTab(requestedSettingsTab)
  const canStayInAppAsGuest = canGuestAccessAppRoute(pathname, currentSettingsTab)
  const requestedCallbackUrl = `${pathname}${currentSearch ? `?${currentSearch}` : ''}`
  const hasGuestChatContext = Boolean(activeId || composerDraft.trim())
  const protectedRouteCallbackUrl = hasGuestChatContext ? '/chat' : requestedCallbackUrl
  const protectedRouteSignInHref = buildAuthPageHref('/sign-in', {
    callbackUrl: protectedRouteCallbackUrl,
  })
  const shouldHoldForSession = isPending && !canStayInAppAsGuest && !accountDeletionInProgress
  const shouldBlockForAuth =
    !isPending
    && !session
    && !canStayInAppAsGuest
    && !accountDeletionInProgress

  useEffect(() => {
    if (authRedirectStartedRef.current) {
      return
    }

    const currentSnapshot = {
      activeConversationId: activeId,
      composerDraft,
    }
    const previous = previousGuestContextRef.current

    if (previous) {
      if (
        previous.activeConversationId === activeId
        && previous.composerDraft === composerDraft
      ) {
        return
      }
    } else {
      previousGuestContextRef.current = currentSnapshot
      if (!activeId && composerDraft.trim().length === 0) {
        return
      }
    }

    rememberGuestLocalContext(currentSnapshot)
    previousGuestContextRef.current = currentSnapshot
  }, [activeId, composerDraft])

  // Client-side session guard: redirect to sign-in if session is invalid/expired.
  // Guests can stay on explicitly guest-safe app routes, but hard member-only
  // routes still redirect into auth while preserving local chat context.
  useEffect(() => {
    if (isPending || session || canStayInAppAsGuest || accountDeletionInProgress) {
      authRedirectStartedRef.current = false
      return
    }

    if (authRedirectStartedRef.current) {
      return
    }

    authRedirectStartedRef.current = true
    const composerDraft = useChatStore.getState().composerDraft
    const hasGuestChatContext = Boolean(activeId || composerDraft.trim())

    if (hasGuestChatContext) {
      rememberGuestLocalContext({
        activeConversationId: activeId,
        composerDraft,
      })
    }

    clearUnsafeClientState()

    const callbackUrl = hasGuestChatContext ? '/chat' : requestedCallbackUrl
    const signInHref = buildAuthPageHref('/sign-in', { callbackUrl })

    void bestEffortSignOut()
    window.location.replace(signInHref)
  }, [activeId, accountDeletionInProgress, canStayInAppAsGuest, currentSearch, isPending, pathname, session])

  const toggleCollapse = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      safeStorage.set(SIDEBAR_COLLAPSED_KEY, String(next))
      return next
    })
  }, [])

  const handleNewChat = useCallback(() => {
    startNewChat()
    setSidebarOpen(false)
    router.push('/chat')
  }, [router])

  const handleExportMarkdown = useCallback(async () => {
    const convId = useConversationStore.getState().activeConversationId
    if (!convId) return
    const conv = conversations.find((c) => c.id === convId)
    const filename = `${conv?.title ?? 'conversation'}.md`
    try {
      const content = await exportConversationAsMarkdown(convId)
      downloadFile(content, filename, 'text/markdown')
    } catch {
      // Export failed silently — conversation may not exist in IndexedDB
    }
  }, [conversations])

  const handleExportJSON = useCallback(async () => {
    const convId = useConversationStore.getState().activeConversationId
    if (!convId) return
    const conv = conversations.find((c) => c.id === convId)
    const filename = `${conv?.title ?? 'conversation'}.json`
    try {
      const content = await exportConversationAsJSON(convId)
      downloadFile(content, filename, 'application/json')
    } catch {
      // Export failed silently — conversation may not exist in IndexedDB
    }
  }, [conversations])

  const handleCommandAction = useCallback((action: string) => {
    switch (action) {
      case "newChat":
        handleNewChat()
        break
      case "toggleSidebar":
        setSidebarOpen((prev) => !prev)
        break
      case "toggleTheme":
        useThemeStore.getState().toggle()
        break
      case "exportMarkdown":
        handleExportMarkdown()
        break
      case "exportJSON":
        handleExportJSON()
        break
      case "showShortcuts":
        setShortcutsOpen(true)
        break
      case "shareConversation":
        if (activeId) setShareOpen(true)
        break
      case "searchConversation":
        if (!activeId) break
        if (pathname !== '/chat') {
          rememberPendingConversationSearch()
          router.push('/chat')
          break
        }
        window.dispatchEvent(new CustomEvent('openConversationSearch'))
        break
    }
  }, [activeId, handleExportJSON, handleExportMarkdown, handleNewChat, pathname, router, setShareOpen])

  // Register global keyboard shortcuts
  useKeyboardShortcuts({
    newChat: handleNewChat,
    toggleSidebar: () => setSidebarOpen((prev) => !prev),
    showShortcuts: () => setShortcutsOpen((prev) => !prev),
    collapseSidebar: toggleCollapse,
    exportMarkdown: handleExportMarkdown,
    exportJSON: handleExportJSON,
    openCommandPalette: () => setCommandPaletteOpen(true),
    shareConversation: () => { if (activeId) setShareOpen(true) },
  })

  if (shouldHoldForSession || shouldBlockForAuth) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-[var(--eco-surface)]">
        <svg className="h-10 w-10 animate-pulse text-[var(--eco-primary)]" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <path d="M20 4C20 4 10 12 10 22C10 28 14 32 18 34C18 26 20 18 20 18C20 18 22 26 22 34C26 32 30 28 30 22C30 12 20 4 20 4Z" fill="currentColor" opacity="0.3" />
          <path d="M20 4C20 4 10 12 10 22C10 28 14 32 18 34C18 26 20 18 20 18C20 18 22 26 22 34C26 32 30 28 30 22C30 12 20 4 20 4Z" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
        <p className="text-sm text-[var(--eco-text-secondary)]">
          {shouldHoldForSession ? 'Loading...' : 'Redirecting to sign in...'}
        </p>
        {!shouldHoldForSession ? (
          <Link
            href={protectedRouteSignInHref}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--eco-border)] px-5 py-2.5 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)]/40 hover:bg-[var(--eco-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--eco-surface)]"
          >
            Continue to sign in
          </Link>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex h-dvh bg-[var(--eco-surface)]">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <SidebarErrorBoundary>
          <Sidebar
            onNewChat={handleNewChat}
            collapsed={sidebarCollapsed}
            onToggleCollapse={toggleCollapse}
            viewerMode={viewerMode}
          />
        </SidebarErrorBoundary>
      </div>

      {/* Drawer sidebar — everywhere the standing column is not.
          `hiddenFrom="lg"` has to match the column's `hidden lg:block` above
          and the header hamburger's `lg:hidden`: with the sheet's default
          `md:hidden` the three disagreed between 768px and 1023px, where the
          hamburger was visible but opened a sheet CSS had already hidden,
          leaving no way to reach navigation or history at tablet widths.
          BottomSheet provides the title bar + close X; Sidebar suppresses
          its own header chrome via the `embedded` prop to avoid the
          double-header / double-close-X duplication. */}
      <BottomSheet
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        title="Navigation"
        hiddenFrom="lg"
      >
        <SidebarErrorBoundary>
          <Sidebar
            onNewChat={handleNewChat}
            onClose={() => setSidebarOpen(false)}
            viewerMode={viewerMode}
            embedded
          />
        </SidebarErrorBoundary>
      </BottomSheet>

      {/* Main content — pad for side notches so the header, messages, and
          composer clear the safe area in landscape (0 on non-notched / desktop). */}
      <div className="flex flex-1 flex-col overflow-hidden pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <Header
          title={pathname.startsWith('/settings') ? 'Settings' : title}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          showShareButton={!!activeId && (pathname === '/chat' || pathname.startsWith('/chat/'))}
          onShare={() => setShareOpen(true)}
        />
        <OfflineBanner />
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>

      {/* Keyboard shortcuts overlay */}
      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Command palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onAction={handleCommandAction}
      />

      {/* Share dialog (keyboard shortcut) */}
      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        conversationId={activeId ?? ""}
        conversationTitle={title}
      />
    </div>
  )
}
