// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useCallback, useId, useState, type ReactNode } from 'react'
import { EcoLogo } from '../EcoLogo'
import { ConversationList } from '../sidebar/ConversationList'
import { ThemeToggle } from '../nav/ThemeToggle'
import {
  clearClientState,
  signOutCurrentUser,
  settleWithinBudget,
  CLIENT_CLEANUP_BUDGET_MS,
} from '../../lib/auth'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { buildSettingsHref, resolveSettingsTab, resolveSidebarSettingsSection } from '../settings/settingsNavigation'
import { withReturnTo } from '../../lib/navigation-return'
import { buildAuthPageHref } from '../../lib/auth-continuation'
import type { ViewerMode } from '../../lib/access-policy'

type SidebarProps = {
  onNewChat: () => void
  onClose?: () => void
  collapsed?: boolean
  onToggleCollapse?: () => void
  viewerMode?: ViewerMode
  /** When true, suppress the internal Sidebar header (logo + close/collapse
   * buttons). Use this when mounting Sidebar inside a chrome that already
   * provides a title bar — e.g. the mobile BottomSheet. */
  embedded?: boolean
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M7.84 1.804A1 1 0 018.82 1h2.36a1 1 0 01.98.804l.331 1.652a6.993 6.993 0 011.929 1.115l1.598-.54a1 1 0 011.186.447l1.18 2.044a1 1 0 01-.205 1.251l-1.267 1.113a7.047 7.047 0 010 2.228l1.267 1.113a1 1 0 01.206 1.25l-1.18 2.045a1 1 0 01-1.187.447l-1.598-.54a6.993 6.993 0 01-1.929 1.115l-.33 1.652a1 1 0 01-.98.804H8.82a1 1 0 01-.98-.804l-.331-1.652a6.993 6.993 0 01-1.929-1.115l-1.598.54a1 1 0 01-1.186-.447l-1.18-2.044a1 1 0 01.205-1.251l1.267-1.114a7.05 7.05 0 010-2.227L1.821 7.773a1 1 0 01-.206-1.25l1.18-2.045a1 1 0 011.187-.447l1.598.54A6.993 6.993 0 017.51 3.456l.33-1.652zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
    </svg>
  )
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M4 4.75A2.75 2.75 0 016.75 2h6.5A2.75 2.75 0 0116 4.75v5.5A2.75 2.75 0 0113.25 13H9.561l-3.28 2.51A.75.75 0 015 14.915V13.1A2.75 2.75 0 014 10.25v-5.5z" clipRule="evenodd" />
    </svg>
  )
}

function LeafIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path d="M10 2C10 2 4 7 4 12C4 15 6 17 8 18C8 14 10 10 10 10C10 10 12 14 12 18C14 17 16 15 16 12C16 7 10 2 10 2Z" />
    </svg>
  )
}

function SupportIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M18 10A8 8 0 112 10a8 8 0 0116 0zm-8-4a2.25 2.25 0 00-2.25 2.25.75.75 0 001.5 0 .75.75 0 111.5 0c0 .41-.25.671-.788 1.05-.67.473-1.462 1.11-1.462 2.45a.75.75 0 001.5 0c0-.59.278-.852.827-1.239l.033-.023C11.526 9.992 12.25 9.362 12.25 8.25A2.25 2.25 0 0010 6zm0 8.25a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
    </svg>
  )
}

function ShieldIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M9.661 2.237a.531.531 0 01.678 0 11.947 11.947 0 007.078 2.749.5.5 0 01.479.425c.069.52.104 1.05.104 1.589 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 01-.332 0C5.26 16.563 2 12.162 2 7c0-.538.035-1.069.104-1.589a.5.5 0 01.48-.425 11.947 11.947 0 007.077-2.75z" clipRule="evenodd" />
    </svg>
  )
}

type NavItem = {
  id: string
  label: string
  href: string
  icon: ReactNode
  isActive: boolean
  currentAria?: 'page' | 'location'
}

type NavSectionProps = {
  title: string
  items: NavItem[]
  collapsed?: boolean
  onNavigate?: () => void
  showTrailingArrow?: boolean
}

function ArrowRightIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M8.22 5.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 010-1.06z" clipRule="evenodd" />
    </svg>
  )
}

function SidebarNavLink({
  item,
  collapsed,
  onNavigate,
  showTrailingArrow,
}: {
  item: NavItem
  collapsed?: boolean
  onNavigate?: () => void
  showTrailingArrow?: boolean
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={item.currentAria}
      aria-label={collapsed ? item.label : undefined}
      className={`group flex items-center rounded-xl text-sm transition-colors motion-reduce:transition-none ${
        collapsed
          ? `min-h-[44px] min-w-[44px] justify-center p-2 ${
              item.isActive
                ? 'bg-[var(--eco-primary-soft)] text-[var(--eco-primary)] shadow-sm'
                : 'text-[var(--eco-text-secondary)] hover:bg-[var(--eco-primary-soft)]/60 hover:text-[var(--eco-text)]'
            }`
          : `min-h-11 gap-3 px-3 py-2.5 ${
              item.isActive
                ? 'border-l-2 border-[var(--eco-primary)] bg-[var(--eco-primary-soft)] text-[var(--eco-primary)]'
                : 'text-[var(--eco-text-secondary)] hover:bg-[var(--eco-primary-soft)]/60 hover:text-[var(--eco-text)]'
            }`
      }`}
      title={collapsed ? item.label : undefined}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {item.icon}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {showTrailingArrow ? (
            <ArrowRightIcon className="h-3.5 w-3.5 shrink-0 text-[var(--eco-text-secondary)]/55 transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--eco-primary)]" />
          ) : null}
        </>
      )}
    </Link>
  )
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
    </svg>
  )
}

type SidebarChatDisclosureProps = {
  item: NavItem
  open: boolean
  controlsId: string
  onOpenChange: (open: boolean) => void
  onNavigate?: () => void
}

function SidebarChatDisclosure({ item, open, controlsId, onOpenChange, onNavigate }: SidebarChatDisclosureProps) {
  const rowTone = item.isActive
    ? 'bg-[var(--eco-primary-soft)] text-[var(--eco-primary)]'
    : 'text-[var(--eco-text-secondary)] hover:bg-[var(--eco-primary-soft)]/60 hover:text-[var(--eco-text)]'

  return (
    <div className="space-y-1.5">
      <div className={`group flex items-stretch rounded-xl text-sm transition-colors motion-reduce:transition-none ${rowTone}`}>
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={item.currentAria}
          className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-l-xl px-3 py-2.5 transition-colors motion-reduce:transition-none ${
            item.isActive
              ? 'border-l-2 border-[var(--eco-primary)]'
              : ''
          }`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {item.icon}
          </span>
          <span className="truncate">{item.label}</span>
        </Link>
        <button
          type="button"
          onClick={() => onOpenChange(!open)}
          aria-expanded={open}
          aria-controls={controlsId}
          aria-label={open ? 'Hide recent chats' : 'Show recent chats'}
          className="flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-r-xl px-2 text-current transition-colors hover:bg-[var(--eco-primary-soft)]/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eco-primary)] motion-reduce:transition-none"
        >
          <ChevronDownIcon className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <div
          id={controlsId}
          className="ml-[22px] border-l border-[var(--eco-border)]/60 py-1 pl-2"
        >
          <span className="sr-only">Recent chats</span>
          <ConversationList variant="nested" />
        </div>
      )}
    </div>
  )
}

function SidebarNavSection({ title, items, collapsed, onNavigate, showTrailingArrow }: NavSectionProps) {
  return (
    <div className={collapsed ? 'space-y-1' : 'space-y-2'}>
      {!collapsed && (
        <p className="px-3 text-[12px] font-medium text-[var(--eco-text-secondary)]/80">
          {title}
        </p>
      )}
      <div className={collapsed ? 'space-y-1' : 'space-y-1'}>
        {items.map((item) => (
          <SidebarNavLink
            key={item.id}
            item={item}
            collapsed={collapsed}
            onNavigate={onNavigate}
            showTrailingArrow={showTrailingArrow}
          />
        ))}
      </div>
    </div>
  )
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M3 4.25A2.25 2.25 0 015.25 2h5.5A2.25 2.25 0 0113 4.25v2a.75.75 0 01-1.5 0v-2a.75.75 0 00-.75-.75h-5.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 00.75-.75v-2a.75.75 0 011.5 0v2A2.25 2.25 0 0110.75 18h-5.5A2.25 2.25 0 013 15.75V4.25z" clipRule="evenodd" />
      <path fillRule="evenodd" d="M19 10a.75.75 0 00-.75-.75H8.704l1.048-.943a.75.75 0 10-1.004-1.114l-2.5 2.25a.75.75 0 000 1.114l2.5 2.25a.75.75 0 101.004-1.114l-1.048-.943h9.546A.75.75 0 0019 10z" clipRule="evenodd" />
    </svg>
  )
}

function AccountAddIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path d="M10 8a3 3 0 100-6 3 3 0 000 6zM3.465 14.493a1.23 1.23 0 00.41 1.412A9.957 9.957 0 0010 18c1.07 0 2.1-.169 3.065-.481a4.734 4.734 0 01-.363-1.809c0-1.116.386-2.142 1.031-2.953a7.002 7.002 0 00-10.268 1.736z" />
      <path d="M16.25 8.5a.75.75 0 01.75.75v1.75h1.75a.75.75 0 010 1.5H17v1.75a.75.75 0 01-1.5 0V12.5h-1.75a.75.75 0 010-1.5h1.75V9.25a.75.75 0 01.75-.75z" />
    </svg>
  )
}

function SignInIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M11 2.25A2.25 2.25 0 018.75 4.5h-3.5a.75.75 0 00-.75.75v11.5c0 .414.336.75.75.75h3.5A2.25 2.25 0 0011 15.75v-2a.75.75 0 011.5 0v2A3.75 3.75 0 018.75 19h-3.5A2.25 2.25 0 013 16.75V5.25A2.25 2.25 0 015.25 3h3.5A3.75 3.75 0 0112.5 6.75v2a.75.75 0 01-1.5 0v-2A2.25 2.25 0 0011 4.5z" clipRule="evenodd" />
      <path fillRule="evenodd" d="M11.47 10a.75.75 0 01.75-.75h5.03l-1.21-1.22a.75.75 0 111.06-1.06l2.5 2.5a.75.75 0 010 1.06l-2.5 2.5a.75.75 0 11-1.06-1.06l1.22-1.22h-5.04a.75.75 0 01-.75-.75z" clipRule="evenodd" />
    </svg>
  )
}

function buildSignedOutHref(): string {
  const params = new URLSearchParams({
    signedOut: '1',
    callbackUrl: '/chat',
  })

  return `/sign-in?${params.toString()}`
}

export function Sidebar({
  onNewChat,
  onClose,
  collapsed,
  onToggleCollapse,
  viewerMode = 'member',
  embedded = false,
}: SidebarProps) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [recentChatsOpen, setRecentChatsOpen] = useState(true)
  const recentChatsDisclosureId = useId()
  const isGuest = viewerMode === 'guest'
  const currentSearch = searchParams.toString()
  const currentHref = `${pathname}${currentSearch ? `?${currentSearch}` : ''}`
  const signInHref = buildAuthPageHref('/sign-in', { callbackUrl: currentHref })
  const signUpHref = buildAuthPageHref('/sign-up', { callbackUrl: currentHref })
  const requestedSettingsTab = searchParams.get('tab')
  const currentSettingsTab = requestedSettingsTab
    ? resolveSettingsTab(requestedSettingsTab)
    : isGuest
      ? 'appearance'
      : resolveSettingsTab(requestedSettingsTab)
  const isSettingsRoute = pathname.startsWith('/settings')
  const settingsSection = pathname.startsWith('/settings/models')
    ? 'models'
    : isSettingsRoute
      ? resolveSidebarSettingsSection(currentSettingsTab)
      : null
  const getSettingsCurrentAria = (primaryTab: 'account' | 'support' | 'billing' | 'models' | 'appearance'): 'page' | 'location' | undefined => {
    if (!isSettingsRoute || settingsSection !== primaryTab) {
      return undefined
    }

    const isExactTab = primaryTab === 'models'
      ? pathname.startsWith('/settings/models') || currentSettingsTab === 'models'
      : currentSettingsTab === primaryTab

    return isExactTab ? 'page' : 'location'
  }

  const handleSignOut = useCallback(async () => {
    if (isSigningOut) {
      return
    }

    setIsSigningOut(true)
    setSignOutError(null)

    try {
      await signOutCurrentUser()
    } catch {
      setSignOutError('Eco could not sign you out. Check your connection and try again.')
      setIsSigningOut(false)
      return
    }

    // The server session is revoked. Local cleanup is best-effort and must never
    // trap the user on the "Signing you out…" overlay — bound it so a stalled
    // browser-storage / service-worker teardown can't block, then navigate
    // regardless. (See settleWithinBudget for why resolving early is safe.)
    await settleWithinBudget(clearClientState(), CLIENT_CLEANUP_BUDGET_MS)
    window.location.replace(buildSignedOutHref())
  }, [isSigningOut])

  const isChatRoute = pathname === '/chat' || pathname.startsWith('/chat/')
  const chatItem: NavItem = {
    id: 'chat',
    label: 'Chat',
    href: '/chat',
    icon: <ChatIcon className="h-4 w-4" />,
    isActive: isChatRoute,
    currentAria: isChatRoute ? 'page' : undefined,
  }

  const workspaceItems: NavItem[] = [
    {
      id: 'models',
      label: 'Models',
      href: buildSettingsHref('models'),
      icon: <SettingsIcon className="h-4 w-4" />,
      isActive: settingsSection === 'models',
      currentAria: getSettingsCurrentAria('models'),
    },
    {
      id: 'learn',
      label: 'Learn',
      href: withReturnTo('/impact', currentHref),
      icon: <LeafIcon className="h-4 w-4" />,
      isActive: pathname === '/impact',
      currentAria: pathname === '/impact' ? 'page' : undefined,
    },
  ]

  const accountItems: NavItem[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      href: buildSettingsHref('appearance'),
      icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path fillRule="evenodd" d="M1 10a9 9 0 1118 0 9 9 0 01-18 0zm9-7.5a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 2.5zM10 15a.75.75 0 01.75.75v1a.75.75 0 01-1.5 0v-1A.75.75 0 0110 15zm-5.303-2.197a.75.75 0 010-1.06l.707-.708a.75.75 0 011.06 1.061l-.707.707a.75.75 0 01-1.06 0zM14.243 6.464a.75.75 0 010-1.06l.707-.708a.75.75 0 111.06 1.061l-.707.707a.75.75 0 01-1.06 0zM2.5 10a.75.75 0 01.75-.75h1a.75.75 0 010 1.5h-1A.75.75 0 012.5 10zM15 10a.75.75 0 01.75-.75h1a.75.75 0 010 1.5h-1A.75.75 0 0115 10zM5.404 5.404a.75.75 0 010 1.06l-.707.708a.75.75 0 01-1.06-1.061l.707-.707a.75.75 0 011.06 0zM13.536 13.536a.75.75 0 010 1.06l-.707.708a.75.75 0 01-1.06-1.061l.707-.707a.75.75 0 011.06 0z" clipRule="evenodd" /></svg>,
      isActive: settingsSection === 'appearance',
      currentAria: getSettingsCurrentAria('appearance'),
    },
    {
      id: 'account',
      label: 'Account',
      href: buildSettingsHref('account'),
      icon: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4"><path d="M10 8a3 3 0 100-6 3 3 0 000 6zM3.465 14.493a1.23 1.23 0 00.41 1.412A9.957 9.957 0 0010 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 00-13.074.003z" /></svg>,
      isActive: settingsSection === 'account',
      currentAria: getSettingsCurrentAria('account'),
    },
    {
      id: 'support',
      label: 'Support',
      href: buildSettingsHref('support'),
      icon: <SupportIcon className="h-4 w-4" />,
      isActive: settingsSection === 'support',
      currentAria: getSettingsCurrentAria('support'),
    },
  ]

  const trustItems: NavItem[] = [
    {
      id: 'privacy',
      label: 'Privacy',
      href: withReturnTo('/privacy', currentHref),
      icon: <ShieldIcon className="h-4 w-4" />,
      isActive: pathname === '/privacy',
      currentAria: pathname === '/privacy' ? 'page' : undefined,
    },
    {
      id: 'transparency',
      label: 'Transparency',
      href: withReturnTo('/transparency', currentHref),
      icon: <LeafIcon className="h-4 w-4" />,
      isActive: pathname === '/transparency',
      currentAria: pathname === '/transparency' ? 'page' : undefined,
    },
    {
      id: 'terms',
      label: 'Terms',
      href: withReturnTo('/terms', currentHref),
      icon: <SupportIcon className="h-4 w-4" />,
      isActive: pathname === '/terms',
      currentAria: pathname === '/terms' ? 'page' : undefined,
    },
  ]

  return (
    <>
    {isSigningOut ? (
      <div
        className="fixed inset-0 z-[2147483000] grid place-items-center bg-[var(--eco-surface-chat)]/92 px-6 backdrop-blur-sm"
        role="status"
        aria-live="polite"
      >
        <div className="grain-subtle w-full max-w-sm rounded-xl border border-[var(--eco-border)]/70 bg-[var(--eco-surface-elevated)] p-6 text-center shadow-xl">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--eco-primary)] border-t-transparent" />
          <p className="mt-4 text-sm font-semibold text-[var(--eco-text)]">Signing you out…</p>
          <p className="mt-2 text-sm leading-6 text-[var(--eco-text-secondary)]">
            Clearing this session while keeping Eco ready for guest chat.
          </p>
        </div>
      </div>
    ) : null}
    <aside
      className="grain-subtle flex h-full max-w-full flex-col border-r border-[var(--eco-border)]/60 bg-[var(--eco-surface-elevated)] transition-all duration-300"
      style={{ width: collapsed ? 60 : onClose ? '100%' : 280 }}
    >
      {/* Header — suppressed when embedded (BottomSheet provides its own
          title bar + close X). Top spacer keeps "+ New chat" from butting
          against the BottomSheet's title border. */}
      {embedded ? (
        <div className="pt-2" aria-hidden="true" />
      ) : (
        <div className={`flex items-center py-5 ${collapsed ? 'justify-center px-2' : 'justify-between px-5'}`}>
          {!collapsed && <EcoLogo size="md" />}
          <div className="flex items-center gap-1">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg p-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)] lg:hidden"
                aria-label="Close sidebar"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            )}
            {onToggleCollapse && (
              <button
                type="button"
                onClick={onToggleCollapse}
                className="cursor-pointer rounded-lg p-1.5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)]"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                  {collapsed ? (
                    <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
                  ) : (
                    <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 10.5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75zM2 10a.75.75 0 01.75-.75h7.5a.75.75 0 010 1.5h-7.5A.75.75 0 012 10z" clipRule="evenodd" />
                  )}
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* New chat */}
      <div className={collapsed ? 'px-2 pb-3' : 'px-4 pb-3'}>
        <button
          type="button"
          onClick={onNewChat}
          aria-label={collapsed ? 'New chat' : undefined}
          className={`flex w-full cursor-pointer items-center rounded-xl text-sm font-medium transition-all hover:shadow-md hover:shadow-[var(--eco-primary)]/10 ${collapsed ? 'justify-center px-0 py-3' : 'gap-2.5 px-4 py-3'}`}
          style={{ backgroundColor: 'var(--eco-primary-soft)', color: 'var(--eco-primary)' }}
          title={collapsed ? 'New chat' : undefined}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 shrink-0">
            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
          </svg>
          {!collapsed && 'New chat'}
        </button>
      </div>

      <div className={`flex-1 overflow-y-auto ${collapsed ? 'px-2' : 'px-4 pb-4'}`}>
        <div className="space-y-5">
          {collapsed ? (
            <SidebarNavSection title="Workspace" items={[chatItem, ...workspaceItems]} collapsed onNavigate={onClose} />
          ) : (
            <div className="space-y-2">
              <p className="px-3 text-[12px] font-medium text-[var(--eco-text-secondary)]/80">
                Workspace
              </p>
              <div className="space-y-1">
                <SidebarChatDisclosure
                  item={chatItem}
                  open={recentChatsOpen}
                  controlsId={recentChatsDisclosureId}
                  onOpenChange={setRecentChatsOpen}
                  onNavigate={onClose}
                />
                {workspaceItems.map((item) => (
                  <SidebarNavLink key={item.id} item={item} onNavigate={onClose} />
                ))}
              </div>
            </div>
          )}
          <SidebarNavSection title="Account & support" items={accountItems} collapsed={collapsed} onNavigate={onClose} />
          <SidebarNavSection
            title="Trust"
            items={trustItems}
            collapsed={collapsed}
            onNavigate={onClose}
            showTrailingArrow
          />
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-[var(--eco-border)]/60 px-4 py-4">
        {isGuest ? collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <Link
              href={signUpHref}
              aria-label="Create account"
              className="cursor-pointer rounded-lg p-2 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)]"
              title="Create account"
            >
              <AccountAddIcon className="h-5 w-5" />
            </Link>
            <Link
              href={signInHref}
              aria-label="Sign in"
              className="cursor-pointer rounded-lg p-2 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)]"
              title="Sign in"
            >
              <SignInIcon className="h-5 w-5" />
            </Link>
            <div className="mt-1">
              <ThemeToggle />
            </div>
          </div>
        ) : (
          <>
            <Link
              href={signUpHref}
              className="flex min-h-11 w-full items-center justify-between rounded-xl border border-[var(--eco-border)]/70 bg-[var(--eco-surface)] px-3 py-2.5 text-left text-sm text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)]/40 hover:bg-[var(--eco-primary-soft)]/30"
            >
              <span className="flex items-center gap-2.5">
                <AccountAddIcon className="h-4 w-4 shrink-0 text-[var(--eco-primary)]" />
                Create account
              </span>
              <span
                className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--eco-primary-soft) 72%, white 12%)',
                  color: 'var(--eco-primary)',
                }}
              >
                Sync
              </span>
            </Link>
            <Link
              href={signInHref}
              className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-[var(--eco-border)]/60 px-3 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)]/40 hover:bg-[var(--eco-primary-soft)]/30"
            >
              Sign in
            </Link>
            <div className="mt-3 flex items-center justify-end">
              <ThemeToggle />
            </div>
          </>
        ) : collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              aria-busy={isSigningOut}
              aria-label={isSigningOut ? 'Signing out' : 'Sign out'}
              className="cursor-pointer rounded-lg p-2 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)] disabled:cursor-wait disabled:opacity-60"
              title={isSigningOut ? 'Signing out' : 'Sign out'}
            >
              <SignOutIcon className="h-5 w-5" />
            </button>
            {signOutError ? (
              <span className="sr-only" role="alert">{signOutError}</span>
            ) : null}
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              aria-busy={isSigningOut}
              className="w-full cursor-pointer rounded-xl px-3 py-2.5 text-left text-sm text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-primary-soft)] hover:text-[var(--eco-text)] disabled:cursor-wait disabled:opacity-70"
            >
              <span className="flex items-center gap-2.5">
                <SignOutIcon className="h-4 w-4 shrink-0" />
                {isSigningOut ? 'Signing out…' : 'Sign out'}
              </span>
            </button>
            {signOutError ? (
              <p className="mt-2 rounded-lg border border-[var(--eco-coral)]/20 bg-[var(--eco-coral)]/10 px-3 py-2 text-xs leading-5 text-[var(--eco-coral)]" role="alert">
                {signOutError}
              </p>
            ) : null}
            <div className="mt-3 flex items-center justify-end">
              <ThemeToggle />
            </div>
          </>
        )}
      </div>
    </aside>
    </>
  )
}
