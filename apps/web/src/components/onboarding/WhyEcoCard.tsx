// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

const pillars = [
  {
    title: "Private",
    description: "Local chats stay in this browser",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  {
    title: "On-device",
    description: "The model runs on your machine",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-3.105a3.501 3.501 0 001.1 1.677A.75.75 0 0113.26 18H6.74a.75.75 0 01-.484-1.323A3.501 3.501 0 007.355 15H4.25A2.25 2.25 0 012 12.75v-8.5zm1.5 0a.75.75 0 01.75-.75h11.5a.75.75 0 01.75.75v7.5a.75.75 0 01-.75.75H4.25a.75.75 0 01-.75-.75v-7.5z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
  {
    title: "Waterless",
    description: "Designed to avoid data-center water waste",
    icon: (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-4 w-4"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.157 2.176a1.5 1.5 0 00-1.147 0l-4.084 1.69A1.5 1.5 0 002 5.251v10.877a1.5 1.5 0 002.074 1.386l3.51-1.453 4.26 1.763a1.5 1.5 0 001.146 0l4.083-1.69A1.5 1.5 0 0018 14.748V3.873a1.5 1.5 0 00-2.073-1.386l-3.51 1.452-4.26-1.763zM7.58 5a.75.75 0 01.75.75v6.5a.75.75 0 01-1.5 0v-6.5A.75.75 0 017.58 5zm5.59 2.75a.75.75 0 00-1.5 0v6.5a.75.75 0 001.5 0v-6.5z"
          clipRule="evenodd"
        />
      </svg>
    ),
  },
] as const;

/**
 * "Why Eco?" brand line for the empty chat state.
 *
 * Always rendered below SuggestedPrompts. It stays intentionally quiet so it
 * supports the chat surface instead of competing with it.
 */
export function WhyEcoCard() {
  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-2 opacity-90">
      <div className="flex w-full flex-col gap-2 px-5 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        {pillars.map((pillar, i) => (
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
                  {pillar.description}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <a
        href="/impact"
        className="inline-flex min-h-11 items-center text-xs font-medium transition-colors hover:underline"
        style={{ color: "var(--eco-primary)" }}
      >
        Read the methodology &rarr;
      </a>
    </div>
  );
}
