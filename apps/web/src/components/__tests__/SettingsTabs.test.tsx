// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { useSettingsStore } from '../../stores/settingsStore'
import { SettingsTabs } from '../settings/SettingsTabs'
import { GuestDataExportSection } from '../settings/GuestDataExportSection'

const mockReplace = vi.fn()
let mockSearchParams = new URLSearchParams()
let mockSession: { user: { id: string } } | null = { user: { id: '1' } }

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings',
  useRouter: () => ({
    replace: mockReplace,
  }),
  useSearchParams: () => mockSearchParams,
}))

vi.mock('../../lib/auth', () => ({
  useSession: () => ({ data: mockSession, isPending: false }),
}))

vi.mock('../guest/LockedSettingsPreview', () => ({
  LockedSettingsPreview: ({ tab }: { tab: string }) => <div data-testid="locked-settings-preview">{tab}</div>,
}))

// Mock tab content components to keep the test focused
vi.mock('../settings/AccountTab', () => ({
  AccountTab: () => <div data-testid="account-tab">Account content</div>,
}))

vi.mock('../settings/SupportTab', () => ({
  SupportTab: () => <div data-testid="support-tab">Support content</div>,
}))

// The real ModelsTab pulls in the whole local-ai adapter, which this file is
// not about. It is stubbed down to the one thing that matters here: the Eco tab
// is where a guest's data export lives, so the stub renders the REAL section.
vi.mock('../settings/ModelsTab', () => ({
  ModelsTab: () => (
    <div data-testid="models-tab">
      Models content
      <GuestDataExportSection />
    </div>
  ),
}))

vi.mock('../settings/DataExportButton', () => ({
  DataExportButton: () => <button type="button">Export my data</button>,
}))

vi.mock('../settings/AppearanceTab', () => ({
  AppearanceTab: () => <div data-testid="appearance-tab">Appearance content</div>,
}))

describe('SettingsTabs', () => {
  beforeEach(() => {
    // Ensure the store reports as hydrated so the skeleton is not shown
    useSettingsStore.setState({ hasLoaded: true })
    mockSearchParams = new URLSearchParams()
    mockSession = { user: { id: '1' } }
    mockReplace.mockReset()
  })

  it('renders the four settings tabs', () => {
    render(<SettingsTabs />)
    const tabNames = screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())
    expect(tabNames).toEqual(['Account', 'Support', 'Eco', 'Appearance'])
  })

  it('has no Billing tab — Eco is free', () => {
    render(<SettingsTabs />)
    expect(screen.queryByRole('tab', { name: 'Billing' })).toBeNull()
  })

  it('no longer renders the retired Privacy, Tools, or Personality tabs', () => {
    render(<SettingsTabs />)
    expect(screen.queryByRole('tab', { name: 'Privacy' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Tools' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Personality' })).toBeNull()
  })

  it('shows Account tab content by default', () => {
    render(<SettingsTabs />)
    expect(screen.getByTestId('account-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('appearance-tab')).not.toBeInTheDocument()
  })

  it('defaults guests to the appearance tab when no tab is selected', () => {
    mockSession = null

    render(<SettingsTabs />)

    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('account-tab')).not.toBeInTheDocument()
  })

  it('hydrates the requested settings tab from the URL', () => {
    mockSearchParams = new URLSearchParams('tab=models')

    render(<SettingsTabs />)

    expect(screen.getByTestId('models-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('account-tab')).not.toBeInTheDocument()
  })

  it('switches to Support tab when clicked and reflects it in the URL', async () => {
    const user = userEvent.setup()
    render(<SettingsTabs />)

    await user.click(screen.getByRole('tab', { name: 'Support' }))

    expect(screen.getByTestId('support-tab')).toBeInTheDocument()
    expect(mockReplace).toHaveBeenCalledWith('/settings?tab=support')
  })

  it('sets aria-selected on the active tab', async () => {
    const user = userEvent.setup()
    render(<SettingsTabs />)

    const accountBtn = screen.getByRole('tab', { name: 'Account' })
    const supportBtn = screen.getByRole('tab', { name: 'Support' })

    expect(accountBtn).toHaveAttribute('aria-selected', 'true')
    expect(supportBtn).toHaveAttribute('aria-selected', 'false')

    await user.click(supportBtn)

    expect(accountBtn).toHaveAttribute('aria-selected', 'false')
    expect(supportBtn).toHaveAttribute('aria-selected', 'true')
  })

  it('follows the ARIA tab pattern with labelled panels and stable controls', () => {
    mockSearchParams = new URLSearchParams('tab=models')

    render(<SettingsTabs />)

    const tablist = screen.getByRole('tablist', { name: 'Settings sections' })
    const modelsTab = screen.getByRole('tab', { name: 'Eco' })
    const panel = screen.getByRole('tabpanel', { name: 'Eco' })

    expect(tablist).toContainElement(modelsTab)
    expect(modelsTab.parentElement).toBe(tablist)
    expect(modelsTab).toHaveAttribute('id', 'settings-tab-models')
    expect(modelsTab).toHaveAttribute('aria-controls', 'settings-panel-models')
    expect(modelsTab).toHaveAttribute('tabIndex', '0')
    expect(panel).toHaveAttribute('id', 'settings-panel-models')
    expect(panel).toHaveAttribute('aria-labelledby', 'settings-tab-models')
  })

  it('only points aria-controls at the mounted settings panel', () => {
    mockSearchParams = new URLSearchParams('tab=models')

    render(<SettingsTabs />)

    const panels = screen.getAllByRole('tabpanel')
    expect(panels).toHaveLength(1)

    for (const tab of screen.getAllByRole('tab')) {
      const controls = tab.getAttribute('aria-controls')

      if (tab.getAttribute('aria-selected') === 'true') {
        expect(controls).toBe('settings-panel-models')
        expect(document.getElementById(controls!)).toBe(panels[0])
      } else {
        expect(controls).toBeNull()
      }
    }
  })

  it('supports keyboard tab movement and URL activation', async () => {
    const user = userEvent.setup()
    render(<SettingsTabs />)

    const accountTab = screen.getByRole('tab', { name: 'Account' })
    accountTab.focus()

    await user.keyboard('{ArrowRight}')

    const supportTab = screen.getByRole('tab', { name: 'Support' })
    await waitFor(() => expect(supportTab).toHaveFocus())
    expect(supportTab).toHaveAttribute('aria-selected', 'true')
    expect(mockReplace).toHaveBeenCalledWith('/settings?tab=support')

    await user.keyboard('{End}')

    const appearanceTab = screen.getByRole('tab', { name: 'Appearance' })
    await waitFor(() => expect(appearanceTab).toHaveFocus())
    expect(appearanceTab).toHaveAttribute('aria-selected', 'true')
    expect(mockReplace).toHaveBeenLastCalledWith('/settings?tab=appearance')
  })

  it('renders an SVG icon inside each tab button', () => {
    render(<SettingsTabs />)
    const tabButtons = screen.getAllByRole('tab')
    for (const btn of tabButtons) {
      expect(btn.querySelector('svg')).toBeTruthy()
    }
  })

  it('applies active background tint to the selected tab', () => {
    render(<SettingsTabs />)
    const accountBtn = screen.getByRole('tab', { name: 'Account' })
    expect(accountBtn.className).toContain('bg-[var(--eco-primary-soft)]')
    expect(accountBtn.className).toContain('rounded-t-lg')
  })

  it('loads settings from IndexedDB when the page hydrates directly', () => {
    const loadFromDB = vi.fn()
    useSettingsStore.setState({ hasLoaded: false, loadFromDB })

    render(<SettingsTabs />)

    expect(loadFromDB).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument()
  })

  it('applies fade-in animation class to tab content panel', () => {
    render(<SettingsTabs />)
    const panel = screen.getByRole('tabpanel')
    expect(panel.className).toContain('animate-[tab-fade-in_200ms_ease-out]')
  })

  it('shows a guest upgrade preview instead of locked account content for guests', () => {
    mockSession = null
    mockSearchParams = new URLSearchParams('tab=account')

    render(<SettingsTabs />)

    expect(screen.getByTestId('locked-settings-preview')).toHaveTextContent('account')
    expect(screen.queryByTestId('account-tab')).not.toBeInTheDocument()
  })

  it('keeps the guest account tab on a locked preview without mounting member content', () => {
    mockSession = null
    mockSearchParams = new URLSearchParams('tab=account')

    render(<SettingsTabs />)

    expect(screen.getByTestId('locked-settings-preview')).toHaveTextContent('account')
    expect(screen.queryByTestId('account-tab')).not.toBeInTheDocument()
  })

  it('redirects the retired guest ?tab=billing deep link to account', () => {
    mockSession = null
    mockSearchParams = new URLSearchParams('tab=billing')

    render(<SettingsTabs />)

    // billing resolves to account, which shows the locked preview for account
    expect(screen.getByTestId('locked-settings-preview')).toHaveTextContent('account')
  })

  it.each(['instructions', 'privacy', 'integrations'] as const)(
    'redirects the retired ?tab=%s deep link onto the Eco tab instead of 404ing',
    (retiredTab) => {
      mockSearchParams = new URLSearchParams(`tab=${retiredTab}`)

      render(<SettingsTabs />)

      expect(screen.getByRole('tab', { name: 'Eco' })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByTestId('models-tab')).toBeInTheDocument()
    },
  )

  it('lets guests open the Eco tab without the upgrade preview', () => {
    mockSession = null
    mockSearchParams = new URLSearchParams('tab=models')

    render(<SettingsTabs />)

    expect(screen.getByRole('tab', { name: 'Eco' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('models-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('locked-settings-preview')).not.toBeInTheDocument()
  })

  it('lets a guest reach the data export from the Eco tab', () => {
    mockSession = null
    mockSearchParams = new URLSearchParams('tab=models')

    render(<SettingsTabs />)

    expect(screen.getByRole('heading', { name: 'Your data' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export my data/i })).toBeInTheDocument()
  })

  it('does not show a member a second export button on the Eco tab', () => {
    mockSearchParams = new URLSearchParams('tab=models')

    render(<SettingsTabs />)

    expect(screen.queryByRole('button', { name: /export my data/i })).not.toBeInTheDocument()
  })

  it('lets guests open safe tabs without showing the upgrade preview', async () => {
    mockSession = null
    const user = userEvent.setup()

    render(<SettingsTabs />)

    await user.click(screen.getByRole('tab', { name: 'Support' }))

    expect(screen.getByTestId('support-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('locked-settings-preview')).not.toBeInTheDocument()
  })

  it('redirects the retired member ?tab=billing deep link to account', () => {
    mockSearchParams = new URLSearchParams('tab=billing')

    render(<SettingsTabs />)

    expect(screen.getByRole('tab', { name: 'Account' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('account-tab')).toBeInTheDocument()
  })
})
