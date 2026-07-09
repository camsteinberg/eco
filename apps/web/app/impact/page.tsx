// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Metadata } from 'next'
import Link from 'next/link'
import { use } from 'react'
import { ImpactHero } from '../../src/components/impact/ImpactHero'
import { ImpactPillar } from '../../src/components/impact/ImpactPillar'
import { ComparisonFigure } from '../../src/components/impact/ComparisonFigure'
import { Methodology } from '../../src/components/impact/Methodology'
import { Footnotes } from '../../src/components/impact/Footnotes'
import { PublicFooter } from '../../src/components/public/PublicFooter'
import { PublicNav } from '../../src/components/public/PublicNav'
import { resolveReturnTo } from '../../src/lib/navigation-return'

type SearchParamValue = string | string[] | undefined

function getFirstSearchParam(value: SearchParamValue): string | null {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return value[0] ?? null
  }

  return null
}

export const metadata: Metadata = {
  title: 'Our Impact | Eco',
  description:
    'How running AI on your own device, instead of a data-center API call, avoids the water, energy, and exposure of cloud inference.',
}

/** Small leaf SVG divider between pillar sections */
function PillarDivider() {
  return (
    <div className="my-16 flex items-center justify-center gap-4 opacity-20">
      <div className="h-px flex-1 bg-[var(--eco-border)]" />
      <svg
        className="h-4 w-4 shrink-0"
        viewBox="0 0 20 20"
        fill="var(--eco-primary)"
        aria-hidden="true"
      >
        <path d="M10 2C10 2 4 7 4 12C4 15 6 17 8 18C8 14 10 10 10 10C10 10 12 14 12 18C14 17 16 15 16 12C16 7 10 2 10 2Z" />
      </svg>
      <div className="h-px flex-1 bg-[var(--eco-border)]" />
    </div>
  )
}

export default function ImpactPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, SearchParamValue>>
}) {
  const resolvedSearchParams = searchParams ? use(searchParams) : undefined
  const requestedReturnTo = getFirstSearchParam(resolvedSearchParams?.returnTo)
  const returnTo = requestedReturnTo ? resolveReturnTo(requestedReturnTo, '/') : null

  return (
    <div
      className="min-h-screen overflow-x-hidden"
      style={{ backgroundColor: 'var(--eco-surface)' }}
    >
      <PublicNav />

      {returnTo && (
        <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 lg:px-10">
          <Link
            href={returnTo}
            className="inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-4 py-2 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path fillRule="evenodd" d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z" clipRule="evenodd" />
            </svg>
            Back to app
          </Link>
        </div>
      )}

      <main className="min-w-0">
      <ImpactHero />

      <PillarDivider />

      {/* Pillar 1 — Water */}
      <ImpactPillar
        overline="Water"
        heading="Every query to a cloud AI drinks a sip of water."
        direction="left"
        figure={
          <ComparisonFigure
            left={{ value: '~250', unit: 'mL', label: 'per query \u2014 data-center API call' }}
            right={{ value: '~0', unit: 'mL', label: 'data-center cooling \u2014 on your device' }}
          />
        }
      >
        <p>
          Large AI data centers rely on evaporative cooling towers that consume
          enormous volumes of fresh water. Microsoft&apos;s 2023 sustainability
          report revealed a 34% year-over-year increase in water
          consumption&thinsp;
          <sup className="text-xs opacity-50">[2]</sup>, driven largely by AI
          workloads. Google&apos;s data centers consumed 5.6 billion gallons of
          water that same year&thinsp;
          <sup className="text-xs opacity-50">[3]</sup>.
        </p>
        <p>
          Researchers at UC Riverside found that a single conversation with
          GPT-4 uses roughly 500&thinsp;mL of cooling
          water&thinsp;&mdash;&thinsp;about a full water bottle&thinsp;&mdash;&thinsp;which
          works out to an estimated 250&thinsp;mL per query&thinsp;
          <sup className="text-xs opacity-50">[1]</sup>.
        </p>
        <p>
          When the model runs on your own device, that query never reaches a
          data center, so it doesn&apos;t draw on a cooling tower at all. Your
          laptop or phone still uses electricity and may warm up, but it carries
          no evaporative-cooling footprint to spend.
        </p>
      </ImpactPillar>

      <PillarDivider />

      {/* Pillar 2 — Energy */}
      <ImpactPillar
        overline="Energy"
        heading="The device in your hand was already on."
        direction="right"
        bgColor="var(--eco-primary-soft)"
        figure={
          <ComparisonFigure
            left={{
              value: '1.5',
              unit: '%',
              label: 'of global electricity \u2014 data centers',
            }}
            right={{
              value: '~0',
              unit: 'racks',
              label: 'new infrastructure \u2014 on your device',
            }}
          />
        }
      >
        <p>
          Data centers currently consume 1&ndash;1.5% of global
          electricity&thinsp;
          <sup className="text-xs opacity-50">[4]</sup>. Goldman Sachs projects
          that AI workloads alone will drive a 160% increase in data center
          power demand by 2030&thinsp;
          <sup className="text-xs opacity-50">[5]</sup>.
        </p>
        <p>
          A small model running on the laptop or phone you already own draws a
          tiny fraction of what a dedicated data-center GPU rack pulls to serve
          the same query&thinsp;&mdash;&thinsp;and it skips the data
          center&apos;s surrounding overhead entirely: the cooling, the
          networking, the idle capacity kept warm for the next request.
        </p>
        <p>
          We don&apos;t claim a precise per-query energy
          number&thinsp;&mdash;&thinsp;consumer hardware varies far too much for
          an honest figure. What we can say is that running AI on a device
          that&apos;s already powered on adds no new power-hungry infrastructure
          to the grid.
        </p>
      </ImpactPillar>

      <PillarDivider />

      {/* Pillar 3 — Privacy */}
      <ImpactPillar
        overline="Privacy"
        heading="The greenest query is the one that never travels."
        direction="left"
        figure={
          <div className="space-y-3">
            {[
              {
                tier: 'Runs in your browser',
                desc: 'The model is downloaded once and runs on your own device',
              },
              {
                tier: 'Stays on your device',
                desc: 'Your prompts and replies aren\u2019t sent to a server to answer them',
              },
              {
                tier: 'No data-center round-trip',
                desc: 'No remote GPU to power, cool, or trust with your words',
              },
            ].map((item, i) => (
              <div
                key={item.tier}
                className="flex items-baseline gap-3 rounded-lg px-4 py-3"
                style={{
                  backgroundColor:
                    i === 0
                      ? 'var(--eco-primary-soft)'
                      : 'var(--eco-surface-elevated)',
                  border:
                    i === 0
                      ? '1px solid var(--eco-primary)'
                      : '1px solid var(--eco-border)',
                }}
              >
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-xs tabular-nums"
                  style={{
                    backgroundColor: 'var(--eco-primary-soft)',
                    color: 'var(--eco-primary)',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <p className="text-sm font-medium text-[var(--eco-text)]">
                    {item.tier}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--eco-text-secondary)]">
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        }
      >
        <p>
          Centralized AI forces a false trade-off: use a service that collects
          your data, or don&apos;t use AI at all. Eco answers a third
          way&thinsp;&mdash;&thinsp;the model runs on your own device, so the
          conversation has no reason to leave it.
        </p>
        <p>
          That privacy is also why the impact adds up. A query that never
          reaches a data center has no remote GPU to power and no cooling tower
          to feed. The two stories are the same story: keeping the work close to
          you keeps it light on the planet.
        </p>
        <p>
          To be precise about what &ldquo;on your device&rdquo; means&thinsp;&mdash;&thinsp;your
          conversation can still be saved locally in your browser&apos;s storage
          so you can return to it. It just isn&apos;t shipped to us, or to anyone
          else, to generate a reply.
        </p>
      </ImpactPillar>

      <Methodology />
      <Footnotes />
      </main>
      <PublicFooter />
    </div>
  )
}
