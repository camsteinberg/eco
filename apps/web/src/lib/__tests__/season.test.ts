// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { getSeason, SEASONAL_OVERRIDES, applySeasonalOverrides } from '../season'
import type { Season } from '../season'

describe('season', () => {
  describe('getSeason', () => {
    it('returns "spring" for months 2-4 (Mar-May)', () => {
      // March = 2, April = 3, May = 4
      for (const month of [2, 3, 4]) {
        const date = new Date(2026, month, 15)
        expect(getSeason(date)).toBe('spring')
      }
    })

    it('returns "summer" for months 5-7 (Jun-Aug)', () => {
      for (const month of [5, 6, 7]) {
        const date = new Date(2026, month, 15)
        expect(getSeason(date)).toBe('summer')
      }
    })

    it('returns "autumn" for months 8-10 (Sep-Nov)', () => {
      for (const month of [8, 9, 10]) {
        const date = new Date(2026, month, 15)
        expect(getSeason(date)).toBe('autumn')
      }
    })

    it('returns "winter" for months 0-1, 11 (Dec-Feb)', () => {
      for (const month of [0, 1, 11]) {
        const date = new Date(2026, month, 15)
        expect(getSeason(date)).toBe('winter')
      }
    })
  })

  describe('SEASONAL_OVERRIDES', () => {
    it('has entries for all 4 seasons', () => {
      const seasons: Season[] = ['spring', 'summer', 'autumn', 'winter']
      for (const season of seasons) {
        expect(SEASONAL_OVERRIDES[season]).toBeDefined()
      }
    })

    it('each season override has light and dark mode variants', () => {
      const seasons: Season[] = ['spring', 'summer', 'autumn', 'winter']
      for (const season of seasons) {
        expect(SEASONAL_OVERRIDES[season].light).toBeDefined()
        expect(SEASONAL_OVERRIDES[season].dark).toBeDefined()
        expect(typeof SEASONAL_OVERRIDES[season].light).toBe('object')
        expect(typeof SEASONAL_OVERRIDES[season].dark).toBe('object')
      }
    })
  })

  describe('applySeasonalOverrides', () => {
    beforeEach(() => {
      // Clear any CSS variables set on document root
      const style = document.documentElement.style
      style.removeProperty('--eco-primary')
      style.removeProperty('--eco-primary-soft')
    })

    it('applies seasonal CSS variable overrides to document root', () => {
      applySeasonalOverrides('light')
      const style = document.documentElement.style
      // Should have set --eco-primary based on current season
      expect(style.getPropertyValue('--eco-primary')).toBeTruthy()
      expect(style.getPropertyValue('--eco-primary-soft')).toBeTruthy()
    })

    it('applies dark mode variants when resolved is dark', () => {
      applySeasonalOverrides('dark')
      const style = document.documentElement.style
      expect(style.getPropertyValue('--eco-primary')).toBeTruthy()
      expect(style.getPropertyValue('--eco-primary-soft')).toBeTruthy()
    })
  })
})
