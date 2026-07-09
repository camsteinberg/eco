// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { type ReactNode } from 'react'
import { useScrollReveal } from '../../hooks/useScrollReveal'

type ImpactPillarProps = {
  overline: string
  heading: string
  children: ReactNode
  figure: ReactNode
  direction: 'left' | 'right'
  bgColor?: string
}

export function ImpactPillar({
  overline,
  heading,
  children,
  figure,
  direction,
  bgColor,
}: ImpactPillarProps) {
  const sectionRef = useScrollReveal<HTMLElement>()

  const textOrder = direction === 'left' ? 'sm:order-1' : 'sm:order-2'
  const figureOrder = direction === 'left' ? 'sm:order-2' : 'sm:order-1'

  return (
    <section
      ref={sectionRef}
      className="scroll-reveal grain relative min-w-0 px-4 py-24 sm:px-6 sm:py-32"
      style={{ backgroundColor: bgColor ?? 'var(--eco-surface)' }}
    >
      <div className="mx-auto grid max-w-4xl min-w-0 grid-cols-1 items-center gap-12 sm:grid-cols-2 sm:gap-16">
        {/* Text side */}
        <div className={`${textOrder} min-w-0`}>
          <p
            className="text-xs font-semibold uppercase tracking-[0.3em]"
            style={{ color: 'var(--eco-primary)' }}
          >
            {overline}
          </p>
          <h2 className="mt-4 font-serif font-medium leading-tight tracking-[-0.02em] text-[var(--eco-text)]" style={{ fontSize: 'clamp(2rem, 1rem + 5vw, 3rem)' }}>
            {heading}
          </h2>
          <div className="mt-6 min-w-0 space-y-4 text-base leading-relaxed text-[var(--eco-text-secondary)] [overflow-wrap:anywhere] sm:text-lg">
            {children}
          </div>
        </div>

        {/* Figure side */}
        <div
          className={`${figureOrder} min-w-0 overflow-hidden ${direction === 'left' ? 'scroll-reveal-right' : 'scroll-reveal-left'}`}
        >
          {figure}
        </div>
      </div>
    </section>
  )
}
