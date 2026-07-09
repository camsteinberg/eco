// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useScrollReveal } from '../../hooks/useScrollReveal'

const methodologyItems = [
  {
    term: 'Water savings per query',
    definition:
      'Each AI query to a traditional data center is estimated to use about 250\u2009mL of cooling water\u200A\u2014\u200Athe midpoint of the 200\u2013300\u2009mL range identified by researchers at the University of California, Riverside for GPT-4 class models. When the model runs on your own device, that query never reaches a data center and so avoids this evaporative-cooling footprint. Your device still consumes electricity and may warm up under ordinary hardware cooling.',
  },
  {
    term: 'What this figure is',
    definition:
      'A published research estimate, not a measurement of your usage. Eco keeps no per-query telemetry, so the number above describes the data-center footprint a typical cloud query would carry\u200A\u2014\u200Anot a count of queries you\u2019ve run.',
  },
  {
    term: 'What we don\u2019t count',
    definition:
      'We don\u2019t claim carbon offsets. We don\u2019t publish a precise per-query energy saving\u200A\u2014\u200Athere are too many variables in consumer hardware configurations to make an honest figure. We report only the water estimate, clearly labeled as an estimate.',
  },
]

export function Methodology() {
  const sectionRef = useScrollReveal<HTMLElement>()

  return (
    <section
      ref={sectionRef}
      className="scroll-reveal grain relative min-w-0 px-4 py-28 sm:px-6 sm:py-36"
      style={{ backgroundColor: 'var(--eco-surface-elevated)' }}
    >
      <div className="mx-auto max-w-3xl min-w-0">
        <h2 className="font-serif font-medium tracking-[-0.02em] text-[var(--eco-text)]" style={{ fontSize: 'clamp(1.5rem, 1rem + 2.5vw, 2.25rem)' }}>
          How we calculate impact
        </h2>

        <dl className="mt-12 space-y-6">
          {methodologyItems.map((item) => (
            <div
              key={item.term}
              className="rounded-xl p-5"
              style={{
                backgroundColor: 'var(--eco-surface)',
                border: '1px solid var(--eco-border)',
              }}
            >
              <dt className="text-sm font-semibold uppercase tracking-[0.15em] text-[var(--eco-primary)]">
                {item.term}
              </dt>
              <dd className="mt-3 text-base leading-relaxed text-[var(--eco-text-secondary)] [overflow-wrap:anywhere] sm:text-lg">
                {item.definition}
              </dd>
            </div>
          ))}
        </dl>

        {/* Formula */}
        <div
          className="mt-12 rounded-xl px-6 py-5"
          style={{
            backgroundColor: 'var(--eco-surface-elevated)',
            border: '1px solid var(--eco-border)',
          }}
        >
          <code
            className="block whitespace-normal break-words font-mono text-sm tracking-wide sm:text-base"
            style={{ color: 'var(--eco-text)' }}
          >
            est_water_per_query &asymp; 0.25&thinsp;L of data-center cooling avoided
          </code>
        </div>

        {/* Closing statement */}
        <div className="mt-12 space-y-4 text-base leading-relaxed text-[var(--eco-text-secondary)]">
          <p>
            Our methodology is deliberately conservative. We&apos;d rather
            understate our impact than overclaim it. All source
            code&thinsp;&mdash;&thinsp;including the calculation you see on this
            page&thinsp;&mdash;&thinsp;is open source under AGPL-3.0.
          </p>
        </div>

        <a
          href="https://github.com/camsteinberg/eco"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 inline-flex min-h-11 items-center gap-2 text-base font-medium transition-colors hover:opacity-80"
          style={{ color: 'var(--eco-primary)' }}
        >
          Verify our methodology
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 8h10M9 4l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>
    </section>
  )
}
