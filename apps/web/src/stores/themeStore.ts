// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { create } from 'zustand'
import type { Theme } from '@eco/ui'
import { getStoredTheme, setStoredTheme, getResolvedTheme, applyTheme } from '../lib/theme'

type ThemeState = {
  theme: Theme
  resolved: 'light' | 'dark'
}

type ThemeActions = {
  setTheme: (theme: Theme) => void
  toggle: () => void
  init: () => void
}

export const useThemeStore = create<ThemeState & ThemeActions>()((set, get) => ({
  theme: 'system',
  resolved: 'light',

  setTheme(theme) {
    const resolved = getResolvedTheme(theme)
    setStoredTheme(theme)
    applyTheme(resolved)
    set({ theme, resolved })
  },

  toggle() {
    const current = get().resolved
    const next = current === 'light' ? 'dark' : 'light'
    const theme = next as Theme
    setStoredTheme(theme)
    applyTheme(next)
    set({ theme, resolved: next })
  },

  init() {
    const theme = getStoredTheme()
    const resolved = getResolvedTheme(theme)
    applyTheme(resolved)
    set({ theme, resolved })
  },
}))

// Sync store with actual theme on client (inline script in layout.tsx already
// applied the dark class before React hydrates — match the store to reality)
if (typeof window !== 'undefined') {
  const theme = getStoredTheme()
  const resolved = getResolvedTheme(theme)
  applyTheme(resolved)
  useThemeStore.setState({ theme, resolved })
}
