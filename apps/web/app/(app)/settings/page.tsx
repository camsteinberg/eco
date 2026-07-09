// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import Link from 'next/link'
import { SettingsTabs } from '../../../src/components/settings/SettingsTabs'
import { useConversationStore } from '../../../src/stores/conversationStore'
import { useChatStore } from '../../../src/stores/chatStore'

export default function SettingsPage() {
  const activeConversationId = useConversationStore((s) => s.activeConversationId)
  const conversations = useConversationStore((s) => s.conversations)
  const composerDraft = useChatStore((s) => s.composerDraft)
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
  const returnLabel = composerDraft.trim().length > 0
    ? 'Return to your draft'
    : activeConversation?.title
      ? `Back to ${activeConversation.title}`
      : 'Back to chat'

  return (
    <div className="h-full overflow-y-auto"><div className="mx-auto max-w-4xl px-4 py-10">
        <div className="relative mb-8 flex items-center gap-4">
          <Link
            href="/chat"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-primary-soft)] hover:text-[var(--eco-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--eco-surface)]"
            aria-label="Back to chat"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
          </Link>
          <div>
            <h1 className="font-serif text-3xl tracking-[-0.02em] text-[var(--eco-text)]">Settings</h1>
            <p className="mt-1 text-sm text-[var(--eco-text-secondary)]">
              {returnLabel}. Your local chat context stays right where you left it.
            </p>
          </div>
        </div>
        <div className="mx-auto max-w-3xl">
          <SettingsTabs />
        </div>
      </div></div>
  )
}
