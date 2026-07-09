// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSettingsStore } from '../../stores/settingsStore'

type HeaderProps = {
  title: string
  onToggleSidebar: () => void
  showShareButton?: boolean
  onShare?: () => void
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2"
      stroke="currentColor"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 8.25H7.5a2.25 2.25 0 0 0-2.25 2.25v9a2.25 2.25 0 0 0 2.25 2.25h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25H15M12 3v11.25m0-11.25L9.75 5.25M12 3l2.25 2.25"
      />
    </svg>
  )
}

export function Header({
  title,
  onToggleSidebar,
  showShareButton = false,
  onShare,
}: HeaderProps) {
  const customInstructions = useSettingsStore((s) => s.customInstructions)
  const router = useRouter()
  const [hasMounted, setHasMounted] = useState(false)

  useEffect(() => {
    setHasMounted(true)
  }, [])

  return (
    <header className="relative flex min-h-14 sm:min-h-16 items-center justify-between gap-1 overflow-hidden border-b border-[var(--eco-border)]/60 bg-[var(--eco-surface-elevated)] px-2 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3">
        <button
          type="button"
          onClick={onToggleSidebar}
          className="cursor-pointer rounded-lg p-2 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)] lg:hidden"
          aria-label="Toggle sidebar"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
            <path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zM2 10a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 10zm0 5.25a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd" />
          </svg>
        </button>
        <h1 className="min-w-0 truncate font-serif text-base font-medium text-[var(--eco-text)] sm:text-lg">{title}</h1>
      </div>

      <div className="flex shrink-0 items-center gap-1 sm:gap-3">
        {/* Instructions chip -- visible when custom instructions are active */}
        {hasMounted && customInstructions.trim().length > 0 && (
          <button
            type="button"
            onClick={() => router.push('/settings?tab=models')}
            className="inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 min-h-[44px] md:min-h-0 text-[11px] font-medium transition-colors hover:opacity-80"
            style={{
              backgroundColor: 'var(--eco-primary-soft)',
              color: 'var(--eco-primary)',
            }}
            aria-label="Custom instructions are active. Click to edit."
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3 w-3">
              <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
            </svg>
            Instructions on
          </button>
        )}

        {showShareButton && onShare && (
          <button
            type="button"
            onClick={onShare}
            className="inline-flex cursor-pointer items-center justify-center rounded-lg p-2.5 text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-border)]/20 hover:text-[var(--eco-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]/50 mr-1 sm:mr-2"
            aria-label="Share conversation"
            title="Share conversation"
          >
            <ShareIcon className="h-6 w-6" />
          </button>
        )}
      </div>
    </header>
  )
}

