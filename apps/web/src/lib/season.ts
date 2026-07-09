// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export type Season = 'spring' | 'summer' | 'autumn' | 'winter'

/**
 * Determine the current season based on calendar month.
 * Months: 2-4 = spring, 5-7 = summer, 8-10 = autumn, 0-1 + 11 = winter
 */
export function getSeason(date: Date = new Date()): Season {
  const month = date.getMonth()
  if (month >= 2 && month <= 4) return 'spring'
  if (month >= 5 && month <= 7) return 'summer'
  if (month >= 8 && month <= 10) return 'autumn'
  return 'winter'
}

/**
 * Seasonal accent color overrides for light and dark mode.
 * These are subtle shifts that make the app feel seasonally aware —
 * users notice subconsciously that the accent greens are fresh in spring,
 * warm amber in autumn, cool blue in winter.
 */
export const SEASONAL_OVERRIDES: Record<Season, { light: Record<string, string>; dark: Record<string, string> }> = {
  spring: {
    light: { '--eco-primary': '#5a9e6f', '--eco-primary-soft': '#e8f5e9' },
    dark: { '--eco-primary': '#6fb87f', '--eco-primary-soft': '#1a2e1f' },
  },
  summer: {
    light: { '--eco-primary': '#6b8f4e', '--eco-primary-soft': '#f0f4e8' },
    dark: { '--eco-primary': '#8aad6a', '--eco-primary-soft': '#1f2e1a' },
  },
  autumn: {
    light: { '--eco-primary': '#a67c52', '--eco-primary-soft': '#faf0e6' },
    dark: { '--eco-primary': '#c49a6c', '--eco-primary-soft': '#2e241a' },
  },
  winter: {
    light: { '--eco-primary': '#5b8fa8', '--eco-primary-soft': '#e8f0f5' },
    dark: { '--eco-primary': '#7ab0c8', '--eco-primary-soft': '#1a242e' },
  },
}

/**
 * Apply seasonal CSS variable overrides to the document root.
 * Called from applyTheme() so seasonal colors update with theme changes.
 */
export function applySeasonalOverrides(resolved: 'light' | 'dark'): void {
  if (typeof document === 'undefined') return

  const season = getSeason()
  const overrides = SEASONAL_OVERRIDES[season][resolved]
  const style = document.documentElement.style

  for (const [property, value] of Object.entries(overrides)) {
    style.setProperty(property, value)
  }
}
