// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exportUserDataMock, sessionRef } = vi.hoisted(() => ({
  exportUserDataMock: vi.fn(),
  // Parameterised so the guest case (no session at all) can be exercised — the
  // export reads only local storage, so it has to work signed out.
  sessionRef: {
    current: null as { user: { name: string; email: string } } | null,
  },
}))

const SIGNED_IN_SESSION = { user: { name: 'Forest User', email: 'forest@eco.network' } }

vi.mock('../../lib/auth', () => ({
  useSession: () => ({ data: sessionRef.current }),
}))

vi.mock('../../lib/data-export', () => ({
  exportUserData: exportUserDataMock,
}))

import { DataExportButton } from '../settings/DataExportButton'

describe('DataExportButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionRef.current = SIGNED_IN_SESSION
  })

  it('keeps a durable export confirmation visible with the downloaded filename', async () => {
    exportUserDataMock.mockResolvedValue({
      filename: 'eco-data-export-2026-04-20.zip',
      exportedAt: '2026-04-20T12:34:56.000Z',
      included: ['conversations', 'settings'],
      failed: [],
    })

    const user = userEvent.setup()
    render(<DataExportButton />)

    await user.click(screen.getByRole('button', { name: /export my data/i }))

    await waitFor(() => {
      expect(exportUserDataMock).toHaveBeenCalledWith({
        name: 'Forest User',
        email: 'forest@eco.network',
      })
    })

    expect(screen.getByRole('button', { name: /download again/i })).toBeInTheDocument()
    expect(screen.getByText(/eco-data-export-2026-04-20\.zip/i)).toBeInTheDocument()
    expect(
      screen.getByText(/your browser started downloading the archive/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/couldn't be read/i)).not.toBeInTheDocument()
  })

  it('names the part missing from the archive when one store could not be read', async () => {
    exportUserDataMock.mockResolvedValue({
      filename: 'eco-data-export-2026-04-20.zip',
      exportedAt: '2026-04-20T12:34:56.000Z',
      included: ['settings'],
      failed: ['conversations'],
    })

    const user = userEvent.setup()
    render(<DataExportButton />)

    await user.click(screen.getByRole('button', { name: /export my data/i }))

    const notice = await screen.findByText(/couldn't be read from this browser's storage/i)
    expect(notice).toHaveTextContent('The archive has your settings and memories')
    expect(notice).toHaveTextContent('your conversations')
  })

  it('does not leave an earlier receipt on screen when a later export fails', async () => {
    exportUserDataMock.mockResolvedValueOnce({
      filename: 'eco-data-export-2026-04-20.zip',
      exportedAt: '2026-04-20T12:34:56.000Z',
      included: ['conversations', 'settings'],
      failed: [],
    })

    const user = userEvent.setup()
    render(<DataExportButton />)

    await user.click(screen.getByRole('button', { name: /export my data/i }))
    expect(
      await screen.findByText(/your browser started downloading the archive/i),
    ).toBeInTheDocument()

    exportUserDataMock.mockRejectedValueOnce(
      new Error("Eco could not read your conversations or your settings from this browser's storage"),
    )
    await user.click(screen.getByRole('button', { name: /download again/i }))

    expect(
      await screen.findByText(/eco could not read your conversations or your settings/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/your browser started downloading the archive/i),
    ).not.toBeInTheDocument()
  })

  it('shows an inline export failure without clearing the button', async () => {
    exportUserDataMock.mockRejectedValue(new Error('Export failed hard'))

    const user = userEvent.setup()
    render(<DataExportButton />)

    await user.click(screen.getByRole('button', { name: /export my data/i }))

    expect(await screen.findByText('Export failed hard')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /export my data/i })).toBeInTheDocument()
  })
})

describe('DataExportButton when there is no account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionRef.current = null
  })

  it('exports with a null profile and reports success, not a partial failure', async () => {
    exportUserDataMock.mockResolvedValue({
      filename: 'eco-data-export-2026-04-20.zip',
      exportedAt: '2026-04-20T12:34:56.000Z',
      included: ['conversations', 'settings'],
      failed: [],
      hasAccount: false,
    })

    const user = userEvent.setup()
    render(<DataExportButton />)

    await user.click(screen.getByRole('button', { name: /export my data/i }))

    await waitFor(() => {
      expect(exportUserDataMock).toHaveBeenCalledWith(null)
    })

    expect(
      await screen.findByText(/your browser started downloading the archive/i),
    ).toBeInTheDocument()
    expect(screen.queryByText(/couldn't be read/i)).not.toBeInTheDocument()
  })
})
