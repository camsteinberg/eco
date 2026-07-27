// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Citation } from "../../lib/citation-parser";

/**
 * Renders the source attribution below a finished assistant message.
 *
 * The production path is web lookups: a citation carrying a `source`
 * ("Wikipedia"/"Wikidata" from grounding) renders as a single calm "specimen-tag"
 * chip — a direct link, not collapsible. A lone source shouldn't hide behind an
 * expand. The render is source-generic; anything without a `source` (no path
 * produces this today) renders nothing.
 */
export function CitationBlock({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  // Invariant: the grounding tool emits exactly one sourced citation; a future
  // multi-citation feature must revisit this (it currently renders only the first).
  const [first] = citations;
  return first?.source ? <GroundingChip citation={first} /> : null;
}

/**
 * The grounding "specimen-tag" chip: `[leaf]  Wikipedia  ·  as of 2023`.
 *
 * Trust through quiet precision (Signal/Proton restraint) with a single botanical
 * delight — a leaf that gives a gentle spring sway on hover. The "as of {year}"
 * is the trust signal: legible but calm.
 */
function GroundingChip({ citation }: { citation: Citation }) {
  const shouldReduce = useReducedMotion();

  const source = citation.source ?? "";
  const asOf = citation.asOf;
  const accessibleName = asOf
    ? `Source: ${source}, as of ${asOf} (opens in a new tab)`
    : `Source: ${source} (opens in a new tab)`;

  // Parent drives a "hover" animation state; the leaf opts in via `variants`,
  // so Motion propagates the sway down without prop-drilling hover state.
  const swaySpring = { type: "spring" as const, stiffness: 300, damping: 12 };

  return (
    <div className="mt-2">
      <motion.a
        href={citation.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={accessibleName}
        data-testid="grounding-citation"
        initial={shouldReduce ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
        whileHover="hover"
        className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--eco-border)] px-3 py-1 text-xs no-underline transition-[border-color,box-shadow,background-color] hover:border-[var(--eco-primary)]/30 hover:shadow-[var(--eco-shadow-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eco-primary)]"
        style={{
          backgroundColor: "var(--eco-surface-elevated)",
        }}
      >
        {/* Botanical motif: a single pressed-leaf glyph that sways on hover. */}
        <motion.svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--eco-primary)", originX: 0.5, originY: 1 }}
          aria-hidden="true"
          variants={
            shouldReduce
              ? undefined
              : {
                  hover: { rotate: [0, -8, 5, 0], scale: 1.08 },
                }
          }
          transition={swaySpring}
        >
          {/* A single leaf: midrib + lamina. */}
          <path d="M11 20c0-7 3-12 9-15-1 8-4 13-9 15z" />
          <path d="M11 20c0-4 2-7 5-9" />
        </motion.svg>

        <span
          className="truncate font-medium"
          style={{
            color: "var(--eco-primary)",
            fontFamily: "var(--eco-font-body)",
          }}
        >
          {source}
        </span>

        {asOf && (
          <span
            className="shrink-0 whitespace-nowrap"
            style={{
              color: "var(--eco-text-secondary)",
              fontFamily: "var(--eco-font-body)",
            }}
          >
            <span aria-hidden="true">·</span> as of {asOf}
          </span>
        )}
      </motion.a>
    </div>
  );
}
