// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useState, useEffect } from 'react'
import {
  bestEffortSignOut,
  clearClientState,
  settleWithinBudget,
  CLIENT_CLEANUP_BUDGET_MS,
  useSession,
} from '../../lib/auth'
import { setAccountDeletionInProgress } from '../../lib/account-lifecycle'
import { DONATION_URL } from '../../lib/donation'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { ErrorLine } from '../ui/ErrorNotice'
import { DataExportButton } from './DataExportButton'
import { SettingsSection } from './SettingsSection'

const DELETE_PROGRESS_VISIBILITY_MS = 900

// Both of these surfaces used to render `err.message` verbatim, which meant any
// lower-level failure (a fetch TypeError, a thrown internal sentinel) reached the
// user as a raw developer string. What went wrong internally is not what the
// person needs to read; these two lines are, and they stay honest about the fact
// that nothing was saved / nothing was deleted.
const PROFILE_SAVE_ERROR = "We couldn't save your name. Please try again."
const DELETE_ACCOUNT_ERROR =
  "We couldn't delete your account. Nothing was changed — please try again."

/**
 * The api refuses a deletion it cannot tie to a fresh proof of identity and
 * says why in words written for display: a credential account needs its
 * password, an OAuth-only account needs a sign-in newer than ten minutes. The
 * client cannot tell those two apart — the session carries no provider list —
 * so it always offers the password field and lets the api's own message name
 * the remedy. Anything else keeps the generic line above.
 */
const REAUTHENTICATION_REQUIRED = 'reauthentication_required'

type ApiErrorBody = { error?: { code?: unknown; message?: unknown } }

/** The api's display message for a 403 that asks for proof, else null. */
async function readReauthenticationMessage(response: Response): Promise<string | null> {
  if (response.status !== 403) return null

  let body: ApiErrorBody
  try {
    body = (await response.json()) as ApiErrorBody
  } catch {
    return null
  }

  if (body.error?.code !== REAUTHENTICATION_REQUIRED) return null
  const message = body.error.message
  return typeof message === 'string' && message.trim() !== '' ? message : null
}

async function waitForNextPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    await Promise.resolve()
    return
  }

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

async function waitForMinimumDuration(startedAt: number, minimumMs: number): Promise<void> {
  const remaining = minimumMs - (Date.now() - startedAt)
  if (remaining <= 0) {
    return
  }

  await new Promise<void>((resolve) => {
    setTimeout(resolve, remaining)
  })
}

export function AccountTab() {
  const { data: session } = useSession()
  const user = session?.user as { name?: string; email?: string } | undefined
  const [name, setName] = useState(user?.name ?? '')
  const [savedName, setSavedName] = useState(user?.name ?? '')

  // Profile save state
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Delete account state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [deleteAccountError, setDeleteAccountError] = useState<string | null>(null)
  const [deletePassword, setDeletePassword] = useState('')

  useEffect(() => {
    const nextName = user?.name ?? ''
    setName(nextName)
    setSavedName(nextName)
  }, [user?.name])

  useEffect(() => {
    if (!showDeleteConfirm) {
      setDeleteAccountError(null)
      setDeletePassword('')
    }
  }, [showDeleteConfirm])

  const trimmedName = name.trim()
  const isDirty = trimmedName !== savedName

  async function handleSave() {
    if (!isDirty) {
      return
    }

    setSaving(true)
    setSaveError(null)
    setSaveSuccess(false)
    try {
      const nextName = trimmedName
      const res = await fetch(`/v1/auth/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
        credentials: 'include',
      })
      if (!res.ok) throw new Error(`Profile PATCH failed with ${res.status}`)
      setName(nextName)
      setSavedName(nextName)
      setSaveSuccess(true)
    } catch {
      setSaveError(PROFILE_SAVE_ERROR)
    } finally {
      setSaving(false)
    }
  }

  async function handleDeleteAccount() {
    const deleteStartedAt = Date.now()
    setAccountDeletionInProgress(true)
    setDeleteLoading(true)
    setDeleteAccountError(null)
    try {
      await waitForNextPaint()
      // The body goes only when there is a password to send. An OAuth-only
      // account has none and proves itself with a recent session instead, so an
      // empty field must still reach the api rather than being blocked here.
      const password = deletePassword
      const res = await fetch(`/v1/auth/account`, {
        method: 'DELETE',
        credentials: 'include',
        ...(password
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password }),
            }
          : {}),
      })
      if (!res.ok) {
        // Nothing was deleted and nothing local is touched: the dialog stays
        // open on the api's own sentence so the person can answer it.
        const reauthenticationMessage = await readReauthenticationMessage(res)
        if (reauthenticationMessage) {
          setAccountDeletionInProgress(false)
          setDeleteLoading(false)
          setDeleteAccountError(reauthenticationMessage)
          return
        }
        throw new Error(`Account DELETE failed with ${res.status}`)
      }
      await Promise.all([
        waitForMinimumDuration(deleteStartedAt, DELETE_PROGRESS_VISIBILITY_MS),
        // Bound best-effort local cleanup so a stalled browser-storage /
        // service-worker teardown can't strand the user on the deletion overlay.
        settleWithinBudget(
          clearClientState({ includeModelFiles: true }),
          CLIENT_CLEANUP_BUDGET_MS,
        ),
        bestEffortSignOut(),
      ])
      window.location.replace('/')
    } catch {
      setAccountDeletionInProgress(false)
      setDeleteLoading(false)
      setDeleteAccountError(DELETE_ACCOUNT_ERROR)
    }
  }

  return (
    <div>
      {DONATION_URL && (
        <p className="text-sm text-[var(--eco-text-secondary)]">
          Eco is free. If it&apos;s useful to you, you can{' '}
          <a
            href={DONATION_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--eco-primary)] underline underline-offset-2 hover:text-[var(--eco-primary-hover)]"
          >
            support it with a donation
          </a>
          .
        </p>
      )}

      <SettingsSection title="Profile" hairline={false} className="mt-10">
        <div className="space-y-4">
          <div>
            <label htmlFor="settings-name" className="block text-sm font-medium text-[var(--eco-text-secondary)]">
              Name
            </label>
            <input
              id="settings-name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (saveSuccess) {
                  setSaveSuccess(false)
                }
              }}
              className="mt-1 w-full rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-4 py-3 text-base text-[var(--eco-text)] outline-none transition-all duration-150 ease focus:border-[var(--eco-primary)] focus:ring-2 focus:ring-[var(--eco-primary)]/20"
            />
          </div>
          <div>
            <label htmlFor="settings-email" className="block text-sm font-medium text-[var(--eco-text-secondary)]">
              Email
            </label>
            <input
              id="settings-email"
              type="email"
              value={user?.email ?? ''}
              readOnly
              tabIndex={-1}
              className="mt-1 w-full cursor-default rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface)] px-4 py-3 text-base text-[var(--eco-text-secondary)] outline-none"
            />
          </div>
          {(isDirty || saveSuccess || saveError) && (
            <div className="flex items-center gap-3">
              {isDirty ? (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !isDirty}
                  aria-busy={saving}
                  className={[
                    "cursor-pointer rounded-xl px-4 py-2.5 text-base font-medium transition-all duration-150 ease",
                    saving
                      ? "bg-[var(--eco-primary-soft)] text-[var(--eco-primary)] disabled:cursor-wait"
                      : "bg-[var(--eco-primary)] text-[var(--eco-on-primary)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
                  ].join(" ")}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              ) : null}
              {saveSuccess && (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-sm text-[var(--eco-text-secondary)]"
                >
                  Saved.
                </p>
              )}
              {saveError && (
                <ErrorLine>{saveError}</ErrorLine>
              )}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Your data"
        description="Download your conversations, settings, and memories."
      >
        <DataExportButton />
      </SettingsSection>

      <SettingsSection title="Delete account">
        <p className="text-sm text-[var(--eco-text-secondary)]">
          This permanently deletes your account, account-linked data, and the AI models
          downloaded to this browser. This can&apos;t be undone.
        </p>
        <button
          type="button"
          onClick={() => setShowDeleteConfirm(true)}
          className="mt-4 cursor-pointer rounded-xl border border-[var(--eco-coral)] px-4 py-2.5 text-sm font-medium text-[var(--eco-coral)] transition-colors hover:bg-[var(--eco-coral-soft)]"
        >
          Delete account
        </button>
      </SettingsSection>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete your account"
        message={
          deleteLoading
            ? "Deleting your account and browser chat/settings now. You'll return to the home screen once account-linked data is cleared."
            : "This permanently deletes your account, account-linked data, and the AI models downloaded to this browser. This can't be undone."
        }
        confirmLabel={deleteLoading ? 'Deleting…' : 'Delete my account'}
        destructive
        errorMessage={deleteAccountError}
        confirmDisabled={deleteLoading}
        cancelDisabled={deleteLoading}
        onConfirm={handleDeleteAccount}
        onCancel={() => {
          if (!deleteLoading) {
            setShowDeleteConfirm(false)
          }
        }}
      >
        {!deleteLoading && (
          <div>
            <label
              htmlFor="delete-account-password"
              className="block text-sm font-medium text-[var(--eco-text)]"
            >
              Confirm your password
            </label>
            <input
              id="delete-account-password"
              type="password"
              required
              autoComplete="current-password"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="mt-1.5 block w-full rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface)] px-3 py-2 text-sm text-[var(--eco-text)] transition-all duration-150 ease focus:border-[var(--eco-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/20"
            />
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
