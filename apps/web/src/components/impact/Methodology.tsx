// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useScrollReveal } from '../../hooks/useScrollReveal'

const methodologyItems = [
  {
    term: 'Water saved per query',
    definition:
      'Each AI query to a traditional data center is estimated to use about 250\u2009mL of cooling water\u200A\u2014\u200Athe midpoint of the 200\u2013300\u2009mL range identified by researchers at the University of California, Riverside for GPT-4 class models. When the model runs on your own device, that query never reaches a data center and so avoids this evaporative-cooling footprint. Your device still consumes electricity and may warm up under ordinary hardware cooling.',
  },
  {
    term: 'Energy saved per query',
    definition:
      'Running the model on your device avoids the data-center GPU inference a cloud query would use. Following Luccioni et al. (2023)\u200A\u2014\u200Aabout 0.005\u2009kWh per data-center query versus roughly 0.003\u2009kWh for local inference\u200A\u2014\u200Awe credit a conservative 0.002\u2009kWh saved per query. Like the water figure, it is a published-research estimate, not a measurement of your hardware.',
  },
  {
    term: 'CO2 avoided per query',
    definition:
      'From the energy above and the US average grid carbon intensity (EPA eGRID 2024, about 0.42\u2009kg CO2 per kWh) with a typical data-center PUE of about 1.2, we estimate roughly 1.26\u2009g of CO2 avoided per query. It is an estimate, not a measurement\u200A\u2014\u200Aand we make no carbon-offset claim.',
  },
  {
    term: 'What these figures are',
    definition:
      'Published research estimates, not measurements of your usage. Eco keeps no per-query telemetry and nothing about your queries leaves your device; the totals you see apply these per-query estimates to a count Eco keeps only on your device.',
  },
  {
    term: 'What we don\u2019t claim',
    definition:
      'We don\u2019t claim carbon offsets, and none of these numbers are measured from your own hardware\u200A\u2014\u200Aconsumer configurations vary too much for that. Every figure is a clearly labeled, deliberately conservative estimate.',
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
