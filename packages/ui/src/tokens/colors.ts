// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const colors = {
  light: {
    bg: {
      primary: '#fafdf9',
      secondary: '#ffffff',
      tertiary: '#f4f4f4',
      accent: '#d8f3dc',
    },
    text: {
      primary: '#374151',
      secondary: '#6b7280',
      accent: '#2d6a4f',
      muted: '#9ca3af',
    },
    border: {
      default: '#e5e7eb',
      subtle: '#f3f4f6',
    },
    status: {
      success: '#16a34a',
      warning: '#d97706',
      error: '#dc2626',
    },
  },
  dark: {
    bg: {
      primary: '#0a0f0d',
      secondary: '#111827',
      tertiary: '#1f2937',
      accent: '#14532d',
    },
    text: {
      primary: '#f3f4f6',
      secondary: '#9ca3af',
      accent: '#74c69d',
      muted: '#6b7280',
    },
    border: {
      default: '#374151',
      subtle: '#1f2937',
    },
    status: {
      success: '#4ade80',
      warning: '#fbbf24',
      error: '#f87171',
    },
  },
} as const

export type Theme = 'light' | 'dark' | 'system'
