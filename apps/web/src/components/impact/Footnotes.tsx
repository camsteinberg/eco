// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export type Citation = {
  id: number
  text: string
  url?: string
}

const citations: Citation[] = [
  {
    id: 1,
    text: 'Li, P. et al. "Making AI Less Thirsty." University of California, Riverside. Communications of the ACM, 2024.',
    url: 'https://cacm.acm.org/research/making-ai-less-thirsty/',
  },
  {
    id: 2,
    text: 'Microsoft Environmental Sustainability Report 2023. 34% increase in water consumption year-over-year.',
    url: 'https://www.microsoft.com/en-us/corporate-responsibility/sustainability/report',
  },
  {
    id: 3,
    text: 'Associated Press. "Google\u2019s data centers consumed 5.6 billion gallons of water in 2023." 2024.',
    url: 'https://apnews.com/article/google-data-centers-water-use-environmental-impact',
  },
  {
    id: 4,
    text: 'International Energy Agency. "Data Centres and Data Transmission Networks." Electricity 2024 Report.',
    url: 'https://www.iea.org/energy-system/buildings/data-centres-and-data-transmission-networks',
  },
  {
    id: 5,
    text: 'Goldman Sachs Research. "AI is poised to drive 160% increase in data center power demand." 2024.',
    url: 'https://www.goldmansachs.com/insights/articles/AI-poised-to-drive-160-increase-in-power-demand',
  },
]

export function Footnotes() {
  return (
    <footer
      className="border-t px-4 py-16 sm:px-6"
      style={{ borderColor: 'var(--eco-border)' }}
    >
      <div className="mx-auto max-w-3xl min-w-0">
        <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--eco-text-secondary)]">
          Sources
        </h3>
        <ol className="mt-6 space-y-3">
          {citations.map((cite) => (
            <li
              key={cite.id}
              className="flex min-w-0 gap-3 text-sm leading-relaxed text-[var(--eco-text-secondary)]"
            >
              <span className="shrink-0 tabular-nums opacity-50">
                [{cite.id}]
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {cite.url ? (
                  <a
                    href={cite.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="transition-colors hover:text-[var(--eco-text)] hover:underline"
                  >
                    {cite.text}
                  </a>
                ) : (
                  cite.text
                )}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </footer>
  )
}
