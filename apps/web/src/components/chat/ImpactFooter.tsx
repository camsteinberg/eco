// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { calculateImpact } from "../../lib/impact-calc";
import { formatImpactCo2, formatImpactEnergy, formatImpactWater } from "../../lib/impact-format";

type ImpactFooterProps = {
  queryCount: number;
  onShare: () => void;
};

export function ImpactFooter({ queryCount, onShare }: ImpactFooterProps) {
  if (queryCount <= 0) {
    // Always render the wrapper so the tour can target it
    return <div data-tour-target="impact-footer" />;
  }

  const impact = calculateImpact(queryCount);

  return (
    <>
    <style>{`
      @keyframes droplet-pulse {
        0%, 100% { opacity: 0.7; transform: scale(1); }
        50% { opacity: 1; transform: scale(1.05); }
      }
      .impact-droplet-pulse {
        animation: droplet-pulse 3s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .impact-droplet-pulse { animation: none; }
      }
    `}</style>
    <div
      data-tour-target="impact-footer"
      // pr reserves the lane the help button occupies above the composer bar
      // (right-4 / md:right-6 plus its 44px diameter), so the controls below
      // are never tucked underneath it. flex-wrap lets the controls take their
      // own row once the metrics no longer leave them room. From min-[84rem]
      // up, the inner box caps at the chat's reading column (56rem at xl) and
      // the padding turns symmetric so the strip's contents share the
      // transcript and composer's edges instead of pinning to the screen's —
      // 84rem is the narrowest width where the column's right flank clears
      // the help button's reserved lane.
      className="border-t border-[var(--eco-border)]/40 py-2 pl-5 pr-[4.25rem] md:pr-[4.75rem] min-[84rem]:px-5"
      style={{
        backgroundColor: "rgba(var(--eco-primary-rgb, 45, 90, 61), 0.05)",
      }}
      aria-label="Environmental impact summary"
    >
      <div className="mx-auto flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 min-[84rem]:max-w-4xl">
      {/* On phones this row is the whole strip: one line, and it links to
          the methodology itself so the page below can drop its own links. */}
      <a
        href="/impact"
        className="flex min-h-[44px] flex-wrap items-center gap-x-3 text-xs text-[var(--eco-text-secondary)] sm:min-h-0 sm:gap-x-4"
        aria-label="Environmental impact of this chat — estimated; how it is calculated"
      >
        <span className="opacity-70">est.</span>
        {/* Water saved */}
        <span className="flex items-center gap-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="impact-droplet-pulse h-3.5 w-3.5"
            style={{ color: "var(--eco-primary)" }}
            aria-hidden="true"
          >
            <path d="M10 2.083c-.376 0-.752.12-1.072.364C6.932 4.052 4 7.334 4 11a6 6 0 1012 0c0-3.666-2.932-6.948-4.928-8.553A1.727 1.727 0 0010 2.083z" />
          </svg>
          {formatImpactWater(impact.waterSavedLiters)}
          <span className="hidden sm:inline"> saved</span>
        </span>

        {/* Energy saved */}
        <span className="flex items-center gap-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
            style={{ color: "var(--eco-primary)" }}
            aria-hidden="true"
          >
            <path d="M11.983 1.907a.75.75 0 00-1.292-.657l-8.5 9.5A.75.75 0 002.75 12h6.572l-1.305 6.093a.75.75 0 001.292.657l8.5-9.5A.75.75 0 0017.25 8h-6.572l1.305-6.093z" />
          </svg>
          {formatImpactEnergy(impact.energySavedWh)}
          <span className="hidden sm:inline"> saved</span>
        </span>

        {/* CO2 avoided */}
        <span className="flex items-center gap-1">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
            style={{ color: "var(--eco-primary)" }}
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.157 2.175a1.5 1.5 0 00-1.147 0l-4.084 1.69A1.5 1.5 0 002 5.251v10.877a1.5 1.5 0 002.074 1.386L8 15.823l3.926 1.691a1.5 1.5 0 001.147 0l4.084-1.69A1.5 1.5 0 0018 14.438V3.56a1.5 1.5 0 00-2.074-1.386L12 3.866 8.157 2.175z"
              clipRule="evenodd"
            />
          </svg>
          {formatImpactCo2(impact.co2SavedGrams)} CO2
          <span className="sm:hidden"> saved</span>
          <span className="hidden sm:inline"> avoided</span>
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3 w-3 sm:hidden"
          style={{ color: "var(--eco-primary)" }}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
            clipRule="evenodd"
          />
        </svg>
      </a>

      {/* Phones get Share from the header and the methodology from the row
          above, so this row only appears from sm up. */}
      <div className="hidden items-center gap-3 text-xs sm:flex">
        <a
          href="/impact"
          className="flex items-center gap-0.5 whitespace-nowrap transition-colors hover:underline"
          style={{ color: "var(--eco-primary)" }}
          aria-label="Learn more about environmental impact"
        >
          Learn more
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3 w-3"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clipRule="evenodd"
            />
          </svg>
        </a>
        <button
          type="button"
          onClick={onShare}
          className="cursor-pointer rounded-md px-2 py-0.5 flex items-center whitespace-nowrap font-medium transition-colors hover:bg-[var(--eco-primary-soft)]"
          style={{ color: "var(--eco-primary)" }}
          aria-label="Share conversation"
        >
          Share chat
        </button>
      </div>
      </div>
    </div>
    </>
  );
}
