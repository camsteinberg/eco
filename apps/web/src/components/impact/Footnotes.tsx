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
  {
    id: 6,
    text: 'Elsworth, C. et al. "Measuring the environmental impact of delivering AI at Google Scale." Google, 2025. Median Gemini Apps text prompt: 0.24 Wh, 0.03 gCO2e, 0.26 mL of on-site water.',
    url: 'https://arxiv.org/abs/2508.15734',
  },
  {
    id: 7,
    text: 'de Vries, A. "The growing energy footprint of artificial intelligence." Joule, 2023. At most 2.9 Wh per ChatGPT request.',
    url: 'https://www.cell.com/joule/fulltext/S2542-4351(23)00365-3',
  },
  {
    id: 8,
    text: 'Epoch AI. "How much energy does ChatGPT use?" 2025. Roughly 0.3 Wh per GPT-4o query.',
    url: 'https://epoch.ai/gradient-updates/how-much-energy-does-chatgpt-use',
  },
  {
    id: 9,
    text: 'US EPA. eGRID 2022 summary data. US average output emission rate: 823.1 lb CO2 per MWh (about 0.37 kg per kWh).',
    url: 'https://www.epa.gov/egrid/summary-data',
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
