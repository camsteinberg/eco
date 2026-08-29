// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { isAccountDeletionInProgress, setAccountDeletionInProgress } from '../../lib/account-lifecycle'

const {
  bestEffortSignOutMock,
  clearClientStateMock,
  settleWithinBudgetMock,
  exportUserDataMock,
} = vi.hoisted(() => ({
  bestEffortSignOutMock: vi.fn().mockResolvedValue(undefined),
  clearClientStateMock: vi.fn().mockResolvedValue(undefined),
  // Stands in for the real bound (unit-tested in lib/auth.test.ts); resolves so
  // the deletion flow proceeds while clearClientState() is still invoked as its arg.
  settleWithinBudgetMock: vi.fn().mockResolvedValue(undefined),
  exportUserDataMock: vi.fn().mockResolvedValue({
    filename: 'eco-account-export.json',
    exportedAt: '2026-04-30T10:00:00.000Z',
    included: ['conversations', 'settings'],
    failed: [],
  }),
}))

vi.mock('../../lib/auth', () => ({
  useSession: () => ({
    data: { user: { name: 'Alice', email: 'alice@eco.network' } },
  }),
  bestEffortSignOut: bestEffortSignOutMock,
  clearClientState: clearClientStateMock,
  settleWithinBudget: settleWithinBudgetMock,
  CLIENT_CLEANUP_BUDGET_MS: 4000,
}))

vi.mock('../../hooks/useSupporterMembership', () => ({
  useSupporterMembership: () => ({
    tier: 'free',
    isSupporter: false,
    loading: false,
    error: null,
    supporterPriceMonthlyUsd: 15,
    billingConfigured: true,
  }),
}))

vi.mock('../../lib/data-export', () => ({
  exportUserData: exportUserDataMock,
}))

let mockBillingUiEnabled = true
vi.mock('../../lib/billing-ui-gate', () => ({
  isBillingUiEnabled: () => mockBillingUiEnabled,
}))

// Mock HTMLDialogElement methods for ConfirmDialog
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

import { AccountTab } from '../settings/AccountTab'

const originalLocation = window.location
const originalRequestAnimationFrame = window.requestAnimationFrame

type MockFetchFn = (...args: unknown[]) => unknown

function mockFetch(impl: MockFetchFn) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

function url(args: unknown[]): string {
  return String(args[0] ?? '')
}

function opts(args: unknown[]): { method?: string } {
  return (args[1] as { method?: string }) ?? {}
}

async function renderAccountTabAndWaitForInitialEffects() {
  render(<AccountTab />)
  // The tab renders its session-derived profile fields synchronously; wait for
  // the email field to confirm the component has mounted before interacting.
  await waitFor(() => {
    expect(screen.getByDisplayValue('alice@eco.network')).toBeInTheDocument()
  })
}

describe('AccountTab', () => {
  beforeEach(() => {
    bestEffortSignOutMock.mockReset()
    bestEffortSignOutMock.mockResolvedValue(undefined)
    clearClientStateMock.mockReset()
    clearClientStateMock.mockResolvedValue(undefined)
    settleWithinBudgetMock.mockReset()
    settleWithinBudgetMock.mockResolvedValue(undefined)
    exportUserDataMock.mockReset()
    exportUserDataMock.mockResolvedValue({
      filename: 'eco-account-export.json',
      exportedAt: '2026-04-30T10:00:00.000Z',
      included: ['conversations', 'settings'],
      failed: [],
    })
    Object.defineProperty(window, 'location', {
      value: {
        ...originalLocation,
        replace: vi.fn(),
      },
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'requestAnimationFrame', {
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
      writable: true,
      configurable: true,
    })

    // Default: every request resolves ok with an empty body.
    mockFetch(() => Promise.resolve({ ok: true, json: async () => ({}) }))
  })

  afterEach(() => {
    vi.useRealTimers()
    setAccountDeletionInProgress(false)
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(window, 'requestAnimationFrame', {
      value: originalRequestAnimationFrame,
      writable: true,
      configurable: true,
    })
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('displays session user name and email', async () => {
    await renderAccountTabAndWaitForInitialEffects()
    expect(screen.getByDisplayValue('Alice')).toBeInTheDocument()
    expect(screen.getByDisplayValue('alice@eco.network')).toBeInTheDocument()
  })

  it('keeps the read-only email in a bordered field like the name field', async () => {
    await renderAccountTabAndWaitForInitialEffects()

    // The email is de-emphasised (recessed fill, secondary text) but still reads
    // as a field — without a border its value floats under orphaned padding.
    const email = screen.getByDisplayValue('alice@eco.network')
    expect(email).toHaveClass('border', 'border-[var(--eco-border)]')
  })

  it('renders profile heading', async () => {
    await renderAccountTabAndWaitForInitialEffects()
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })

  it('does not render the removed API keys section', async () => {
    await renderAccountTabAndWaitForInitialEffects()
    expect(screen.queryByText('API keys')).toBeNull()
    expect(screen.queryByText('Create new key')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      '/v1/api-keys',
      expect.anything(),
    )
  })

  it('renders the inline Billing link when billing UI is enabled', async () => {
    mockBillingUiEnabled = true
    await renderAccountTabAndWaitForInitialEffects()

    // Heading "Membership" is gone — replaced with a one-sentence inline link
    expect(screen.queryByRole('heading', { name: 'Membership' })).toBeNull()
    const link = screen.getByRole('link', { name: /^billing$/i })
    expect(link).toHaveAttribute(
      'href',
      '/settings?tab=billing',
    )
  })

  it('hides the inline Billing link when billing UI is disabled', async () => {
    mockBillingUiEnabled = false
    await renderAccountTabAndWaitForInitialEffects()

    expect(screen.queryByRole('link', { name: /^billing$/i })).not.toBeInTheDocument()
  })

  // --- Profile Save ---

  it('does not show Save button when name is unchanged', async () => {
    render(<AccountTab />)
    await waitFor(() => {
      expect(screen.queryByText('Save')).not.toBeInTheDocument()
    })
  })

  it('shows Save button when name differs from session', async () => {
    const user = userEvent.setup()
    render(<AccountTab />)
    const nameInput = screen.getByDisplayValue('Alice')
    await user.clear(nameInput)
    await user.type(nameInput, 'Bob')
    expect(screen.getByText('Save')).toBeInTheDocument()
  })

  it('keeps a durable visible success message after saving the profile', async () => {
    const user = userEvent.setup()
    mockFetch((...a: unknown[]) => {
      if (url(a).includes('/v1/auth/profile') && opts(a).method === 'PATCH') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<AccountTab />)
    const nameInput = screen.getByDisplayValue('Alice')
    await user.clear(nameInput)
    await user.type(nameInput, 'Bob')
    await user.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(
        screen.getByText(/^Saved\.$/i),
      ).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.queryByText('Save')).not.toBeInTheDocument()
    })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500))
    })

    expect(
      screen.getByText(/^Saved\.$/i),
    ).toBeInTheDocument()
  }, 10000)

  it('states the save succeeded as a quiet line, not a card', async () => {
    const user = userEvent.setup()
    mockFetch(() => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }))

    render(<AccountTab />)
    const nameInput = screen.getByDisplayValue('Alice')
    await user.clear(nameInput)
    await user.type(nameInput, 'Bob')
    await user.click(screen.getByText('Save'))

    const saved = await screen.findByRole('status')
    expect(saved).toHaveTextContent(/^Saved\.$/)
    // Success and failure share one anatomy: a single line beside the field.
    expect(saved.className).not.toMatch(/\b(border|bg-|rounded-)/)
  })

  it('shows error when profile save fails', async () => {
    const user = userEvent.setup()
    mockFetch((...a: unknown[]) => {
      if (url(a).includes('/v1/auth/profile') && opts(a).method === 'PATCH') {
        return Promise.resolve({ ok: false, json: async () => ({}) })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<AccountTab />)
    const nameInput = screen.getByDisplayValue('Alice')
    await user.clear(nameInput)
    await user.type(nameInput, 'Bob')
    await user.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.getByText("We couldn't save your name. Please try again.")).toBeInTheDocument()
    })
  })

  it('never renders a raw internal error message when the profile save throws', async () => {
    const user = userEvent.setup()
    mockFetch((...a: unknown[]) => {
      if (url(a).includes('/v1/auth/profile') && opts(a).method === 'PATCH') {
        return Promise.reject(new Error('NetworkError when attempting to fetch resource.'))
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<AccountTab />)
    const nameInput = screen.getByDisplayValue('Alice')
    await user.clear(nameInput)
    await user.type(nameInput, 'Bob')
    await user.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.getByText("We couldn't save your name. Please try again.")).toBeInTheDocument()
    })
    expect(screen.queryByText(/NetworkError/)).not.toBeInTheDocument()
  })

  // --- Data export ---

  it('exports account data explicitly', async () => {
    const user = userEvent.setup()

    await renderAccountTabAndWaitForInitialEffects()

    await user.click(screen.getByRole('button', { name: /export my data/i }))

    expect(exportUserDataMock).toHaveBeenCalledWith({
      name: 'Alice',
      email: 'alice@eco.network',
    })
    expect(await screen.findByText(/browser started downloading/i)).toBeInTheDocument()
    expect(screen.getByText('eco-account-export.json')).toBeInTheDocument()
  })

  // --- Account deletion ---

  it('cancels account deletion without deleting or clearing session state', async () => {
    const user = userEvent.setup()

    await renderAccountTabAndWaitForInitialEffects()

    await user.click(screen.getByRole('button', { name: 'Delete account' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      '/v1/auth/account',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(clearClientStateMock).not.toHaveBeenCalled()
    expect(bestEffortSignOutMock).not.toHaveBeenCalled()
    expect(isAccountDeletionInProgress()).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows an inline error when account deletion fails', async () => {
    const user = userEvent.setup()
    mockFetch((...a: unknown[]) => {
      if (url(a).includes('/v1/auth/account') && opts(a).method === 'DELETE') {
        return Promise.resolve({ ok: false })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<AccountTab />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete account' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /delete my account/i }))

    expect(
      await screen.findByText(
        "We couldn't delete your account. Nothing was changed — please try again.",
      ),
    ).toBeInTheDocument()
  })

  it('shows visible delete progress before redirecting away', async () => {
    const user = userEvent.setup()
    type DeleteResponse = {
      ok: boolean
      json: () => Promise<Record<string, never>>
    }
    let resolveDelete: ((value: DeleteResponse) => void) | undefined

    mockFetch((...a: unknown[]) => {
      if (url(a).includes('/v1/auth/account') && opts(a).method === 'DELETE') {
        return new Promise<DeleteResponse>((resolve) => {
          resolveDelete = resolve
        })
      }
      return Promise.resolve({ ok: true, json: async () => ({}) })
    })

    render(<AccountTab />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete account' })).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: 'Delete account' }))
    const dialog = screen.getByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: /delete my account/i }))

    expect(
      await screen.findByText(/Deleting your account and browser chat\/settings now/i),
    ).toBeInTheDocument()
    expect(isAccountDeletionInProgress()).toBe(true)
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: /^Deleting/i })).toBeDisabled()

    resolveDelete?.({ ok: true, json: async () => ({}) })

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100))
    })

    expect(clearClientStateMock).toHaveBeenCalledTimes(1)
    // Cleanup goes through the bounded helper so a stalled teardown can't hang deletion.
    expect(settleWithinBudgetMock).toHaveBeenCalledTimes(1)
    expect(bestEffortSignOutMock).toHaveBeenCalledTimes(1)
    expect(isAccountDeletionInProgress()).toBe(true)
    expect(
      screen.getByText(/Deleting your account and browser chat\/settings now/i),
    ).toBeInTheDocument()
    // Inside the dialog, the loading message replaces the warning copy.
    // (The same warning also appears in the page section, so scope the
    //  assertion to the dialog.)
    expect(within(dialog).queryByText(/This permanently deletes your account/i)).not.toBeInTheDocument()
    expect(window.location.replace).toHaveBeenCalledWith('/')
  }, 10000)
})
