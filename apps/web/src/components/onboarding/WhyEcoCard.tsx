// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { VALUE_PILLARS } from "../../lib/value-pillars";

/**
 * "Why Eco?" brand line for the empty chat state.
 *
 * Always rendered below SuggestedPrompts. It stays intentionally quiet so it
 * supports the chat surface instead of competing with it.
 */
export function WhyEcoCard() {
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-2">
      <div className="flex w-full flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {VALUE_PILLARS.map((pillar, i) => (
          <div key={pillar.title} className="flex items-center gap-4">
            {i > 0 && (
              <div
                className="hidden h-7 w-px shrink-0 sm:block"
                style={{ backgroundColor: "var(--eco-border)" }}
              />
            )}
            <div className="flex items-start gap-2">
              <span
                className="mt-0.5 shrink-0"
                style={{ color: "var(--eco-primary)" }}
              >
                {pillar.icon}
              </span>
              <div>
                <p className="text-sm font-semibold text-[var(--eco-text)]">
                  {pillar.title}
                </p>
                <p className="text-xs text-[var(--eco-text-secondary)]">
                  {pillar.body}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <a
        href="/impact"
        className="inline-flex items-center text-xs font-medium transition-colors hover:underline"
        style={{ color: "var(--eco-primary)" }}
      >
        Read the methodology &rarr;
      </a>
    </div>
  );
}
