// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * Research pill — a static, greyed-out "coming later" affordance in the
 * composer.
 *
 * "Research" here means a future deeper-research mode, not the everyday web
 * lookups (facts + weather) that are on by default and controlled in
 * Settings → Eco. It renders a disabled pill (search icon + "Research" label
 * + tooltip) with no toggle state, no click handler, and no store reads — it
 * reads as "coming later" and never becomes interactive.
 */
export function ResearchToggle() {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      data-testid="research-toggle"
      aria-label="Deeper research mode, coming later"
      title="Deeper research mode isn't part of web v1 yet. Everyday lookups for facts and weather are on by default — manage them in Settings → Eco."
      className="hidden min-h-11 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-full border border-[var(--eco-border)] px-3 py-2 text-xs font-medium text-[var(--eco-text-secondary)] opacity-70 sm:flex"
    >
      <span className="flex items-center" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
      </span>
      <span className="hidden sm:inline">Research</span>
    </button>
  );
}
