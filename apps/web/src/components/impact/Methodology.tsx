// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client"

import { useScrollReveal } from '../../hooks/useScrollReveal'

const methodologyItems = [
  {
    term: 'Water saved per query',
    definition:
      'Researchers at UC Riverside estimated that GPT-3 consumes a 500\u2009mL bottle of water for roughly 10\u201350 medium-length responses, depending on when and where it runs\u200A\u2014\u200A10\u201350\u2009mL per reply, counting on-site cooling and the water used to generate the electricity. We credit the high end, 50\u2009mL, because the worst-placed data centers are the ones worth avoiding; the leanest report far less. When the model runs on your own device, the reply never reaches a data center at all. Your device still uses electricity and may warm up under ordinary hardware cooling.',
  },
  {
    term: 'Energy saved per query',
    definition:
      'Running the model on your device avoids the data-center serving a cloud query would use. We credit 2.9\u2009Wh per reply\u200A\u2014\u200Ade Vries (2023) put a 2023-era ChatGPT request at most 2.9\u2009Wh, the high end of published estimates. Newer, optimized deployments report about a tenth of that (Epoch AI, 2025: ~0.3\u2009Wh; Google, 2025: 0.24\u2009Wh median). We do not subtract your own device\u2019s draw, because we don\u2019t measure it; a small model on a laptop typically runs for a few seconds at well under the machine\u2019s peak power.',
  },
  {
    term: 'CO2 avoided per query',
    definition:
      'The energy above times the US average grid carbon intensity (EPA eGRID 2022, 823\u2009lb CO2 per MWh, about 0.37\u2009kg per kWh) gives roughly 1.08\u2009g of CO2 per reply. No extra data-center overhead is added: the 2.9\u2009Wh is already a whole-service figure. It is an estimate, not a measurement\u200A\u2014\u200Aand we make no carbon-offset claim.',
  },
  {
    term: 'What these figures are',
    definition:
      'Published research estimates, not measurements of your usage. Eco keeps no per-query telemetry and nothing about your queries leaves your device; the totals you see apply these per-query estimates to a count Eco keeps only on your device.',
  },
  {
    term: 'What we don\u2019t claim',
    definition:
      'We don\u2019t claim carbon offsets, and none of these numbers are measured from your own hardware\u200A\u2014\u200Aconsumer configurations vary too much for that. Every figure is a clearly labeled estimate of what a data-center query costs at the high end of the published range; the best-run data centers cost far less, and the totals you see are an upper bound, not a promise.',
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
            est_water_per_query &asymp; 50&thinsp;mL (high end of 10&ndash;50&thinsp;mL, Li et al.)
          </code>
        </div>

        {/* Closing statement */}
        <div className="mt-12 space-y-4 text-base leading-relaxed text-[var(--eco-text-secondary)]">
          <p>
            Our figures describe the worst common case, and say so. All source
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
