// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export type Season = 'spring' | 'summer' | 'autumn' | 'winter'

/**
 * Determine the current season based on calendar month.
 * Months: 2-4 = spring, 5-7 = summer, 8-10 = autumn, 0-1 + 11 = winter
 *
 * Used only by the chat easter-egg animations. The season must never influence
 * theme colors — the brand primary is defined once in CSS.
 */
export function getSeason(date: Date = new Date()): Season {
  const month = date.getMonth()
  if (month >= 2 && month <= 4) return 'spring'
  if (month >= 5 && month <= 7) return 'summer'
  if (month >= 8 && month <= 10) return 'autumn'
  return 'winter'
}
