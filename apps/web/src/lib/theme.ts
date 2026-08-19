// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Theme } from '@eco/ui'
import { safeStorage, STORAGE_KEYS } from './local-storage'

const VALID_THEMES = new Set<string>(['light', 'dark', 'system'])

export function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = safeStorage.get(STORAGE_KEYS.THEME)
    if (stored && VALID_THEMES.has(stored)) return stored as Theme
  } catch {
    return 'system'
  }
  return 'system'
}

export function setStoredTheme(theme: Theme): void {
  if (typeof window === 'undefined') return
  try {
    if (theme === 'system') {
      safeStorage.remove(STORAGE_KEYS.THEME)
    } else {
      safeStorage.set(STORAGE_KEYS.THEME, theme)
    }
  } catch {
    // Storage can be unavailable in private browsing or locked-down contexts.
  }
}

export function getSystemPreference(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function getResolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') return getSystemPreference()
  return theme
}

export function applyTheme(resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }
  document.documentElement.style.colorScheme = resolved
  // The brand primary is defined once in CSS. An earlier build set it inline on the
  // root per calendar season; clear those leftovers so a session that started on the
  // old code (or restores from bfcache) falls back to the stylesheet value.
  document.documentElement.style.removeProperty('--eco-primary')
  document.documentElement.style.removeProperty('--eco-primary-soft')
}
