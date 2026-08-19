// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { getStoredTheme, setStoredTheme, getResolvedTheme, applyTheme } from '../theme'

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.classList.remove('dark')
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    })
  })

  describe('getStoredTheme', () => {
    it('returns "system" when no theme is stored', () => {
      expect(getStoredTheme()).toBe('system')
    })

    it('returns the stored theme', () => {
      localStorage.setItem('eco-theme', 'dark')
      expect(getStoredTheme()).toBe('dark')
    })

    it('returns "system" for invalid stored values', () => {
      localStorage.setItem('eco-theme', 'invalid')
      expect(getStoredTheme()).toBe('system')
    })
  })

  describe('setStoredTheme', () => {
    it('persists the theme to localStorage', () => {
      setStoredTheme('dark')
      expect(localStorage.getItem('eco-theme')).toBe('dark')
    })

    it('removes localStorage entry for "system"', () => {
      setStoredTheme('dark')
      setStoredTheme('system')
      expect(localStorage.getItem('eco-theme')).toBeNull()
    })
  })

  describe('getResolvedTheme', () => {
    it('returns "light" when stored is "light"', () => {
      expect(getResolvedTheme('light')).toBe('light')
    })

    it('returns "dark" when stored is "dark"', () => {
      expect(getResolvedTheme('dark')).toBe('dark')
    })

    it('returns system preference for "system"', () => {
      // jsdom defaults to light
      expect(getResolvedTheme('system')).toBe('light')
    })
  })

  describe('applyTheme', () => {
    it('adds "dark" class for dark theme', () => {
      applyTheme('dark')
      expect(document.documentElement.classList.contains('dark')).toBe(true)
      expect(document.documentElement.style.colorScheme).toBe('dark')
    })

    it('removes "dark" class for light theme', () => {
      document.documentElement.classList.add('dark')
      applyTheme('light')
      expect(document.documentElement.classList.contains('dark')).toBe(false)
      expect(document.documentElement.style.colorScheme).toBe('light')
    })

    it('never sets the brand primary inline on the document root', () => {
      // The primary is token-defined in CSS. Setting it inline here (as the removed
      // seasonal override did) forks the brand color by route and calendar month.
      for (const resolved of ['light', 'dark'] as const) {
        applyTheme(resolved)
        const style = document.documentElement.style
        expect(style.getPropertyValue('--eco-primary')).toBe('')
        expect(style.getPropertyValue('--eco-primary-soft')).toBe('')
      }
    })

    it('clears an inline primary left over from an earlier session', () => {
      const style = document.documentElement.style
      style.setProperty('--eco-primary', '#a67c52')
      style.setProperty('--eco-primary-soft', '#faf0e6')
      applyTheme('light')
      expect(style.getPropertyValue('--eco-primary')).toBe('')
      expect(style.getPropertyValue('--eco-primary-soft')).toBe('')
    })
  })
})
