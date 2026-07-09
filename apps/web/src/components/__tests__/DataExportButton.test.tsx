// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exportUserDataMock } = vi.hoisted(() => ({
  exportUserDataMock: vi.fn(),
}))

vi.mock('../../lib/auth', () => ({
  useSession: () => ({
    data: { user: { name: 'Forest User', email: 'forest@eco.network' } },
  }),
}))

vi.mock('../../lib/data-export', () => ({
  exportUserData: exportUserDataMock,
}))

import { DataExportButton } from '../settings/DataExportButton'

describe('DataExportButton', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps a durable export confirmation visible with the downloaded filename', async () => {
    exportUserDataMock.mockResolvedValue({
      filename: 'eco-data-export-2026-04-20.zip',
      exportedAt: '2026-04-20T12:34:56.000Z',
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
