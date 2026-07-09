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

    it('applies seasonal CSS variable overrides to document root', () => {
      applyTheme('light')
      const style = document.documentElement.style
      // applyTheme now calls applySeasonalOverrides, which sets seasonal primary colors
      expect(style.getPropertyValue('--eco-primary')).toBeTruthy()
      expect(style.getPropertyValue('--eco-primary-soft')).toBeTruthy()
    })
  })
})
