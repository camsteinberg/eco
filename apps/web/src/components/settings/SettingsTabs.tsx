// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSettingsStore } from '../../stores/settingsStore'
import { AccountTab } from './AccountTab'
import { BillingTab } from './BillingTab'
import { ModelsTab } from './ModelsTab'
import { AppearanceTab } from './AppearanceTab'
import { SupportTab } from './SupportTab'
import { SETTINGS_TABS, getVisibleSettingsTabs, buildSettingsHref, resolveSettingsTab } from './settingsNavigation'
import { useSession } from '../../lib/auth'
import { getViewerMode, isGuestLockedSettingsTab } from '../../lib/access-policy'
import { LockedSettingsPreview } from '../guest/LockedSettingsPreview'
import { isBillingUiEnabled } from '../../lib/billing-ui-gate'

type TabId = (typeof SETTINGS_TABS)[number]['id']

function SettingsSkeleton() {
  return (
    <div className="animate-pulse" aria-hidden="true">
      {/* Tab bar skeleton */}
      <div className="flex gap-1 border-b border-[var(--eco-border)] pb-0">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-[52px] px-5 py-4"
          >
            <div
              className="h-4 rounded skeleton-shimmer"
              style={{ width: `${60 + (i % 3) * 16}px` }}
            />
          </div>
        ))}
      </div>
      {/* Content skeleton */}
      <div className="space-y-4 pt-8">
        <div className="h-5 w-40 rounded skeleton-shimmer" />
        <div className="h-10 w-full max-w-md rounded skeleton-shimmer" />
        <div className="h-5 w-56 rounded skeleton-shimmer" />
        <div className="h-10 w-full max-w-md rounded skeleton-shimmer" />
      </div>
    </div>
  )
}

export function SettingsTabs() {
  const { data: session } = useSession()
  const hasLoaded = useSettingsStore((s) => s.hasLoaded)
  const loadFromDB = useSettingsStore((s) => s.loadFromDB)
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const viewerMode = getViewerMode(Boolean(session))
  const rawTabParam = searchParams.get('tab')
  const tabFromUrl = rawTabParam
    ? resolveSettingsTab(rawTabParam)
    : viewerMode === 'guest'
      ? 'appearance'
      : resolveSettingsTab(rawTabParam)
  const [activeTab, setActiveTab] = useState<TabId>(tabFromUrl)
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 })
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const navRef = useRef<HTMLDivElement>(null)
  const currentSearch = searchParams.toString()
  const callbackUrl = `${pathname}${currentSearch ? `?${currentSearch}` : ''}`
  const visibleTabs = getVisibleSettingsTabs()
  const activeTabMeta = visibleTabs.find((tab) => tab.id === activeTab) ?? visibleTabs[0]!
  const tabIdFor = useCallback((tabId: TabId) => `settings-tab-${tabId}`, [])
  const panelIdFor = useCallback((tabId: TabId) => `settings-panel-${tabId}`, [])

  useEffect(() => {
    if (!hasLoaded) {
      void loadFromDB()
    }
  }, [hasLoaded, loadFromDB])

  useEffect(() => {
    setActiveTab(tabFromUrl)
  }, [tabFromUrl])

  const updateUnderline = useCallback(() => {
    const el = tabRefs.current.get(activeTab)
    const nav = navRef.current
    if (el && nav) {
      const navRect = nav.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      setUnderlineStyle({
        // The underline is absolutely positioned inside the scroll container, so
        // it scrolls with the strip: `left` must be the offset into the content,
        // not the on-screen gap. Adding scrollLeft back makes a re-measurement
        // taken while the strip is scrolled agree with one taken at rest.
        left: elRect.left - navRect.left + nav.scrollLeft,
        width: elRect.width,
      })
    }
  }, [activeTab])

  // A single measurement on mount can land before the tab row is final — the
  // web fonts still swapping, the container still sizing — and leave the
  // underline stranded off the active pill. Re-measure whenever the strip or
  // the active tab actually changes size, and once the fonts have settled.
  useEffect(() => {
    updateUnderline()

    const nav = navRef.current
    const el = tabRefs.current.get(activeTab)
    const observer =
      nav && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateUnderline) : null

    if (nav && observer) {
      observer.observe(nav)
      if (el) observer.observe(el)
    }

    window.addEventListener('resize', updateUnderline)

    let active = true
    // JSDOM has no FontFaceSet, so this is genuinely absent there despite the
    // DOM types insisting otherwise.
    if ('fonts' in document) {
      void document.fonts.ready.then(() => {
        if (active) updateUnderline()
      })
    }

    return () => {
      active = false
      observer?.disconnect()
      window.removeEventListener('resize', updateUnderline)
    }
  }, [updateUnderline, activeTab, hasLoaded])

  useEffect(() => {
    const el = tabRefs.current.get(activeTab)
    // JSDOM doesn't implement scrollIntoView; guard so tests don't throw.
    if (!el || typeof el.scrollIntoView !== 'function') return
    // Defer to next frame: parent's scrollWidth needs to settle before
    // inline: 'center' can compute a valid scrollLeft.
    const rafId = requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
    })
    return () => cancelAnimationFrame(rafId)
  }, [activeTab, hasLoaded])

  const handleTabChange = useCallback((tabId: TabId) => {
    setActiveTab(tabId)

    const href = buildSettingsHref(tabId)
    const current = `${pathname}${currentSearch ? `?${currentSearch}` : ''}`

    if (current !== href) {
      router.replace(href)
    }
  }, [currentSearch, pathname, router])

  const focusTab = useCallback((tabId: TabId) => {
    tabRefs.current.get(tabId)?.focus()
  }, [])

  const scheduleKeyboardFocus = useCallback((tabId: TabId) => {
    const focusCurrentTab = () => {
      const tab = document.getElementById(tabIdFor(tabId)) as HTMLButtonElement | null
      tab?.focus()
    }

    window.requestAnimationFrame(focusCurrentTab)
    window.setTimeout(focusCurrentTab, 120)
  }, [tabIdFor])

  const handleTabKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, tabId: TabId) => {
    const currentIndex = visibleTabs.findIndex((tab) => tab.id === tabId)
    if (currentIndex < 0) return

    const lastIndex = visibleTabs.length - 1
    const nextIndex =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (currentIndex + 1) % visibleTabs.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? (currentIndex - 1 + visibleTabs.length) % visibleTabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? lastIndex
              : null

    if (nextIndex !== null) {
      event.preventDefault()
      const nextTab = visibleTabs[nextIndex]!.id
      handleTabChange(nextTab)
      scheduleKeyboardFocus(nextTab)
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleTabChange(tabId)
    }
  }, [focusTab, handleTabChange, visibleTabs])

  if (!hasLoaded) {
    return <SettingsSkeleton />
  }

  return (
    <div>
      {/* Tab bar */}
      <div
        ref={navRef}
        className="eco-tabstrip-scrollbar relative flex overflow-x-auto border-b border-[var(--eco-border)]"
        role="tablist"
        aria-label="Settings sections"
      >
        {visibleTabs.map((tab) => (
            (() => {
              const lockedForGuest = viewerMode === 'guest' && isGuestLockedSettingsTab(tab.id)

              return (
                <button
                  key={tab.id}
                  type="button"
                  ref={(el) => {
                    if (el) tabRefs.current.set(tab.id, el)
                  }}
                  role="tab"
                  id={tabIdFor(tab.id)}
                  aria-selected={activeTab === tab.id}
                  aria-controls={activeTab === tab.id ? panelIdFor(tab.id) : undefined}
                  tabIndex={activeTab === tab.id ? 0 : -1}
                  onClick={() => handleTabChange(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
                  className={`shrink-0 cursor-pointer px-3 py-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--eco-surface)] motion-reduce:transition-none sm:px-4 sm:text-base lg:px-5 ${
                    activeTab === tab.id
                      ? 'bg-[var(--eco-primary-soft)]/50 rounded-t-lg text-[var(--eco-primary)]'
                      : 'text-[var(--eco-text-secondary)] hover:text-[var(--eco-text)]'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {tab.icon}
                    {tab.label}
                    {lockedForGuest && (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5 text-[var(--eco-text-secondary)]">
                        <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                      </svg>
                    )}
                  </span>
                </button>
              )
            })()
          ))}
        {/* Sliding underline */}
        <div
          className="absolute bottom-0 h-0.5 bg-[var(--eco-primary)] transition-all duration-200"
          aria-hidden="true"
          role="presentation"
          style={{ left: underlineStyle.left, width: underlineStyle.width }}
        />
      </div>

      {/* Tab content */}
      <div
        key={activeTab}
        id={panelIdFor(activeTab)}
        className="pt-8 animate-[tab-fade-in_200ms_ease-out] motion-reduce:animate-none"
        role="tabpanel"
        aria-labelledby={tabIdFor(activeTab)}
        tabIndex={0}
      >
        <p className="sr-only" role="status" aria-live="polite">
          {activeTabMeta.label} settings selected
        </p>
        {viewerMode === 'guest' && isGuestLockedSettingsTab(activeTab) ? (
          <LockedSettingsPreview tab={activeTab} callbackUrl={callbackUrl} />
        ) : null}
        {viewerMode === 'member' && activeTab === 'account' && <AccountTab />}
        {activeTab === 'support' && <SupportTab />}
        {viewerMode === 'member' && activeTab === 'billing' && isBillingUiEnabled() && <BillingTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'appearance' && <AppearanceTab />}
      </div>
    </div>
  )
}
