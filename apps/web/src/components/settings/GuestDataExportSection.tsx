// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useSession } from '../../lib/auth'
import { getViewerMode } from '../../lib/access-policy'
import { SettingsSection } from './SettingsSection'
import { DataExportButton } from './DataExportButton'

/**
 * "Your data" for someone using Eco without an account.
 *
 * The export reads only this browser's storage, so it never needed an account
 * — but its only home was the Account tab, which guests cannot open. This puts
 * the SAME button on the guest-allowed Eco tab.
 *
 * Members render nothing here: their copy still lives in Settings → Account
 * beside the profile and account deletion it belongs with, and nobody should
 * ever face two competing export buttons.
 */
export function GuestDataExportSection() {
  const { data: session } = useSession()

  if (getViewerMode(Boolean(session)) === 'member') return null

  return (
    <SettingsSection
      title="Your data"
      description="Download everything Eco has stored on this device — your conversations, settings, and memories. The archive is built here in your browser; nothing is uploaded."
    >
      <DataExportButton />
    </SettingsSection>
  )
}
