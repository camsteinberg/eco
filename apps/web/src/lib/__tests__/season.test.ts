// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { getSeason } from '../season'

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
})
