// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useState, useRef, useCallback, useEffect } from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { SettingsSection } from './SettingsSection'

const MAX_INSTRUCTIONS_LENGTH = 1500
const DEBOUNCE_MS = 500

type CustomInstructionsSectionProps = {
  /** Draw the top hairline divider above the section. Defaults to true so it
   * sits comfortably beneath the preceding Eco-tab section. */
  hairline?: boolean
}

/**
 * Live custom-instructions editor — the system-prompt personalization that
 * applies to every conversation. Folded into the Eco settings tab (C-14);
 * previously lived in a standalone Instructions tab. Wires directly to the
 * encrypted settingsStore.
 */
export function CustomInstructionsSection({ hairline = true }: CustomInstructionsSectionProps) {
  const customInstructions = useSettingsStore((s) => s.customInstructions)
  const setCustomInstructions = useSettingsStore((s) => s.setCustomInstructions)

  const [localText, setLocalText] = useState(customInstructions)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setLocalText(customInstructions)
  }, [customInstructions])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleChange = useCallback(
    (value: string) => {
      const clamped = value.slice(0, MAX_INSTRUCTIONS_LENGTH)
      setLocalText(clamped)

      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        setCustomInstructions(clamped)
      }, DEBOUNCE_MS)
    },
    [setCustomInstructions]
  )

  return (
    <SettingsSection
      title="How Eco talks to you"
      description="Tell Eco about yourself and how you'd like it to respond. Applies to every conversation, and stays on this device."
      hairline={hairline}
    >
      <textarea
        value={localText}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="e.g., I prefer concise answers. I work as a frontend developer using TypeScript…"
        rows={5}
        maxLength={MAX_INSTRUCTIONS_LENGTH}
        className="w-full resize-y rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-4 py-3 text-sm text-[var(--eco-text)] placeholder:text-[var(--eco-text-secondary)]/60 transition-all duration-150 ease focus:border-[var(--eco-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/20"
        aria-label="Custom instructions"
      />
      <div className="mt-1 text-right text-xs text-[var(--eco-text-secondary)]">
        {localText.length} / {MAX_INSTRUCTIONS_LENGTH}
      </div>
    </SettingsSection>
  )
}
