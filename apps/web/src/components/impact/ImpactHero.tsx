// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useScrollReveal } from '../../hooks/useScrollReveal'

export function ImpactHero() {
  const sectionRef = useScrollReveal<HTMLElement>()

  return (
    <section
      ref={sectionRef}
      className="scroll-reveal grain relative min-w-0 px-4 py-28 sm:px-6 sm:py-40"
      style={{ backgroundColor: 'var(--eco-surface)' }}
    >
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="text-sm font-semibold uppercase tracking-[0.25em] text-[var(--eco-text-secondary)]">
          Our Impact
        </h1>

        <div className="mt-10 flex flex-col items-center">
          {/* Water droplet */}
          <svg
            width="44"
            height="54"
            viewBox="0 0 36 44"
            fill="none"
            className="opacity-70"
            style={{ animation: 'float-gentle 4s ease-in-out infinite' }}
            aria-hidden="true"
          >
            <path
              d="M18 2C18 2 4 18 4 28C4 35.7 10.3 42 18 42C25.7 42 32 35.7 32 28C32 18 18 2 18 2Z"
              fill="var(--eco-sky)"
            />
            <path
              d="M14 27Q14 23 18 21Q22 23 22 27Q22 31 18 33Q14 31 14 27Z"
              fill="var(--eco-surface)"
              opacity="0.35"
            />
          </svg>

          {/* Static, methodology-backed estimate — the per-query data-center
              water footprint that an on-device reply avoids. Top of the
              published 10–50 mL range (Li et al.), never a live or per-user
              number; the methodology below says why the high end. */}
          <div className="mt-4 flex min-w-0 flex-wrap items-baseline justify-center gap-2 sm:gap-3">
            <span
              className="font-serif text-6xl font-light tracking-tighter sm:text-7xl lg:text-8xl"
              style={{ color: 'var(--eco-primary)' }}
            >
              ~50
            </span>
            <span
              className="font-serif text-2xl font-medium tracking-tight sm:text-3xl"
              style={{ color: 'var(--eco-primary)', opacity: 0.6 }}
            >
              mL
            </span>
          </div>
        </div>

        <p className="mx-auto mt-6 max-w-lg text-lg leading-relaxed text-[var(--eco-text-secondary)] sm:text-xl">
          of water a single AI query can draw in a data center, at the high end
          of published estimates&thinsp;&mdash;&thinsp;water your reply
          doesn&rsquo;t spend when the model runs on your own device.
        </p>

        <p className="mx-auto mt-4 max-w-md text-sm text-[var(--eco-text-secondary)] opacity-70">
          Estimated, not measured. Eco keeps no per-query telemetry. See the
          methodology below.
        </p>
      </div>
    </section>
  )
}
