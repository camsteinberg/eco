// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import { SettingsTabs } from '../SettingsTabs'
import { useSettingsStore } from '../../../stores/settingsStore'

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('tab=billing'),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/settings',
}))

vi.mock('../../../lib/auth', () => ({
  useSession: () => ({ data: { user: { id: 'u1' } } }),
}))

vi.mock('../../../lib/billing-ui-gate', () => ({
  isBillingUiEnabled: () => true,
}))

// The tab bodies pull in the whole settings tree; this suite is about the tab
// strip's underline geometry, so stub them out.
vi.mock('../AccountTab', () => ({ AccountTab: () => <div /> }))
vi.mock('../BillingTab', () => ({ BillingTab: () => <div /> }))
vi.mock('../ModelsTab', () => ({ ModelsTab: () => <div /> }))
vi.mock('../AppearanceTab', () => ({ AppearanceTab: () => <div /> }))
vi.mock('../SupportTab', () => ({ SupportTab: () => <div /> }))

/** Pins an element's measured box so jsdom (which measures nothing) can stand in. */
function stubRect(el: Element, left: number, width: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left,
    width,
    top: 0,
    right: left + width,
    bottom: 0,
    height: 52,
    x: left,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

/** The underline is aria-hidden, so it is only reachable through the DOM. */
function underline() {
  const el = document.querySelector('[role="presentation"]')
  if (!el) throw new Error('underline not rendered')
  return el
}

describe('SettingsTabs sliding underline', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState({ hasLoaded: true })
  })

  it('re-measures when the tab row settles, so a stale mount measurement cannot strand it', () => {
    render(<SettingsTabs />)

    const nav = screen.getByRole('tablist')
    const billing = screen.getByRole('tab', { name: /billing/i })

    // Mount measured a row that had not laid out yet — the underline is stranded.
    expect(underline()).toHaveStyle({ width: '0px' })

    stubRect(nav, 100, 600)
    stubRect(billing, 340, 108)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(underline()).toHaveStyle({ left: '240px', width: '108px' })
  })

  it('measures the offset into the strip, not the on-screen gap, when it is scrolled', () => {
    render(<SettingsTabs />)

    const nav = screen.getByRole('tablist')
    const billing = screen.getByRole('tab', { name: /billing/i })

    // A scrolled strip: the active pill sits 240px into the content but only
    // 60px from the visible left edge. The underline scrolls with the content,
    // so it has to be placed at 240 — placing it at 60 walks it off the pill.
    Object.defineProperty(nav, 'scrollLeft', { value: 180, configurable: true })
    stubRect(nav, 100, 600)
    stubRect(billing, 160, 108)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(underline()).toHaveStyle({ left: '240px', width: '108px' })
  })
})
