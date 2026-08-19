// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useState } from 'react'
import { useThemeStore } from '../../stores/themeStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { playMessageSent } from '../../lib/sounds'
import type { Theme } from '@eco/ui'
import { SettingsSection } from './SettingsSection'
import { SettingsRow } from './SettingsRow'
import { SettingsSwitch } from './SettingsSwitch'
import { safeStorage, STORAGE_KEYS } from '../../lib/local-storage'

const themes: { id: Theme; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
]

const fontSizes = ['Default', 'Compact', 'Comfortable'] as const

export function AppearanceTab() {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const soundsEnabled = useSettingsStore((s) => s.soundsEnabled)
  const setSoundsEnabled = useSettingsStore((s) => s.setSoundsEnabled)
  const autoAcceptTools = useSettingsStore((s) => s.autoAcceptTools)
  const setAutoAcceptTools = useSettingsStore((s) => s.setAutoAcceptTools)
  const showTechnicalDetails = useSettingsStore((s) => s.showTechnicalDetails)
  const setShowTechnicalDetails = useSettingsStore((s) => s.setShowTechnicalDetails)
  const [fontSize, setFontSize] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Default'
    return safeStorage.get(STORAGE_KEYS.FONT_SIZE) ?? 'Default'
  })

  function handleFontSize(size: string) {
    setFontSize(size)
    safeStorage.set(STORAGE_KEYS.FONT_SIZE, size)
    document.documentElement.dataset.fontSize = size.toLowerCase()
  }

  return (
    <div>
      <SettingsSection title="Theme" hairline={false}>
        <div className="inline-flex rounded-lg border border-[var(--eco-border)] p-1">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
              className={`min-h-11 sm:min-h-0 sm:h-9 rounded-md px-4 text-sm font-medium transition-colors motion-reduce:transition-none ${
                theme === t.id
                  ? 'bg-[var(--eco-primary)] text-[var(--eco-on-primary)]'
                  : 'bg-[var(--eco-surface-elevated)] text-[var(--eco-text-secondary)] hover:text-[var(--eco-text)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Font size">
        <div className="inline-flex rounded-lg border border-[var(--eco-border)] p-1">
          {fontSizes.map((size) => (
            <button
              key={size}
              type="button"
              onClick={() => handleFontSize(size)}
              aria-pressed={fontSize === size}
              className={`min-h-11 sm:min-h-0 sm:h-9 rounded-md px-4 text-sm font-medium transition-colors motion-reduce:transition-none ${
                fontSize === size
                  ? 'bg-[var(--eco-primary)] text-[var(--eco-on-primary)]'
                  : 'bg-[var(--eco-surface-elevated)] text-[var(--eco-text-secondary)] hover:text-[var(--eco-text)]'
              }`}
            >
              {size}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Sounds & feedback">
        <SettingsRow
          label="Sound effects"
          description="Soft tones when sending and receiving messages."
          control={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => playMessageSent(true)}
                className="min-h-11 rounded-md border border-[var(--eco-border)] px-3 py-1.5 text-xs font-medium text-[var(--eco-text-secondary)] transition-colors hover:border-[var(--eco-text-secondary)] hover:text-[var(--eco-text)] motion-reduce:transition-none"
                aria-label="Preview sound effect"
              >
                Preview
              </button>
              <SettingsSwitch
                checked={soundsEnabled}
                onChange={setSoundsEnabled}
                ariaLabel="Toggle sound effects"
              />
            </div>
          }
        />
        <SettingsRow
          label="Expand tool results"
          description="Open the details of a lookup or calculation automatically, instead of starting collapsed."
          divider={false}
          control={
            <SettingsSwitch
              checked={autoAcceptTools}
              onChange={setAutoAcceptTools}
              ariaLabel="Toggle expand tool results"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Display">
        <SettingsRow
          label="Show technical details"
          description="Show token counts, generation speed, and model details in chat."
          divider={false}
          control={
            <SettingsSwitch
              checked={showTechnicalDetails}
              onChange={setShowTechnicalDetails}
              ariaLabel="Toggle technical details"
            />
          }
        />
      </SettingsSection>
    </div>
  )
}
