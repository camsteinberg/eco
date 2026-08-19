// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useState } from 'react'
import { useSession } from '../../lib/auth'
import { exportUserData } from '../../lib/data-export'

type ExportState = 'idle' | 'exporting' | 'done' | 'error'
type ExportReceipt = {
  filename: string
  exportedAt: string
}

export function DataExportButton() {
  const { data: session } = useSession()
  const [state, setState] = useState<ExportState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<ExportReceipt | null>(null)

  async function handleExport() {
    setState('exporting')
    setErrorMessage(null)
    try {
      const user = session?.user
      const profile = user
        ? { name: 'name' in user ? String(user.name) : undefined, email: 'email' in user ? String(user.email) : undefined }
        : null
      const nextReceipt = await exportUserData(profile)
      setReceipt(nextReceipt)
      setState('done')
    } catch (err) {
      setState('error')
      setErrorMessage(err instanceof Error ? err.message : 'Export failed')
    }
  }

  const label: Record<ExportState, string> = {
    idle: 'Export my data',
    exporting: 'Exporting...',
    done: 'Download again',
    error: 'Export my data',
  }

  const exportedAtLabel = receipt
    ? new Date(receipt.exportedAt).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleExport}
        disabled={state === 'exporting'}
        aria-busy={state === 'exporting'}
        className="cursor-pointer rounded-[var(--eco-radius-sm)] border border-[var(--eco-primary)] px-4 py-2.5 text-base font-medium text-[var(--eco-primary)] transition-colors hover:bg-[var(--eco-primary-soft)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label[state]}
      </button>

      {receipt ? (
        <div
          aria-live="polite"
          className="rounded-2xl border border-[var(--eco-primary)]/25 bg-[var(--eco-primary-soft)] px-4 py-3 text-sm text-[var(--eco-text-secondary)]"
        >
          <p className="font-medium text-[var(--eco-text)]">
            Your browser started downloading the archive.
          </p>
          <p className="mt-1">
            File: <span className="font-medium text-[var(--eco-text)]">{receipt.filename}</span>
          </p>
          {exportedAtLabel ? (
            <p className="mt-1 text-xs uppercase tracking-[0.14em] text-[var(--eco-primary)]">
              Prepared {exportedAtLabel}
            </p>
          ) : null}
        </div>
      ) : null}

      {state === 'error' && errorMessage ? (
        <p aria-live="polite" className="text-sm text-[var(--eco-coral)]">
          {errorMessage}
        </p>
      ) : null}
    </div>
  )
}
