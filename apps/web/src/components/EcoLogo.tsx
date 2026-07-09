// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

type EcoLogoProps = {
  size?: 'sm' | 'md' | 'lg'
  iconOnly?: boolean
  className?: string
}

const sizes = {
  sm: { icon: 20, text: 'text-sm' },
  md: { icon: 26, text: 'text-lg' },
  lg: { icon: 34, text: 'text-2xl' },
}

export function EcoLogo({ size = 'md', iconOnly = false, className = '' }: EcoLogoProps) {
  const s = sizes[size]

  return (
    <span className={`inline-flex items-center gap-2 ${className}`} aria-label="Eco logo">
      <svg
        width={s.icon}
        height={s.icon}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path
          d="M7 25C7 25 5.5 16 11 11C16.5 6 25 4.5 28 4.5C28 4.5 29.5 13.5 24 19C18.5 24.5 10 25 7 25Z"
          fill="var(--eco-primary)"
          opacity="0.85"
        />
        <path
          d="M7.5 24.5C11 21 16 16 28 4.5"
          stroke="var(--eco-surface)"
          strokeWidth="1.2"
          strokeLinecap="round"
          opacity="0.5"
        />
      </svg>
      {!iconOnly && (
        <span
          className={`${s.text} font-serif font-semibold tracking-tight`}
          style={{ color: 'var(--eco-primary)' }}
        >
          eco
        </span>
      )}
    </span>
  )
}
