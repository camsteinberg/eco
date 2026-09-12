// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, useReducedMotion } from "motion/react";
import type { Citation } from "../../lib/citation-parser";

/**
 * Renders the source attribution below a finished assistant message.
 *
 * Two sourced paths. Grounding (`source` = "Wikipedia"/"Wikidata") emits exactly
 * one citation and renders as a single calm "specimen-tag" chip — a direct link,
 * not collapsible, because a lone source shouldn't hide behind an expand. A web
 * search (`source` = "Web search") emits one citation per result and renders the
 * whole set: the time it was fetched and every title as a link, so a person can
 * always tell which turns went out to the network and what they read.
 *
 * Anything without a `source` renders nothing.
 */
export function CitationBlock({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;
  const [first] = citations;
  if (!first?.source) return null;
  if (first.source === WEB_SEARCH_SOURCE) {
    return (
      <WebSearchChip
        citations={citations.filter((citation) => citation.source === WEB_SEARCH_SOURCE)}
      />
    );
  }
  // Invariant: the grounding tool emits exactly one sourced citation; a future
  // multi-citation feature must revisit this (it currently renders only the first).
  return <GroundingChip citation={first} />;
}

/** The `source` a web-searched turn's citations carry (set in `tool-step.ts`). */
const WEB_SEARCH_SOURCE = "Web search";

/**
 * Local `HH:MM` for an ISO timestamp, or `null` when it is unparseable.
 *
 * The time is the point of the chip: a small local model cannot be trusted to
 * date its own answer, so the host states when the sources were actually read.
 * It is rendered in the READER's zone (the relay's ISO string is kept verbatim in
 * `data-fetched-at`), because "14:32" only means anything locally.
 */
function formatFetchedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The web-search chip: "Searched the web at 14:32 · 3 sources", then each title
 * as an outbound link.
 *
 * Same tokens and quiet shape as {@link GroundingChip}; it carries a list rather
 * than one link because a search is answered from several results and naming
 * only the first would misstate what the model read.
 */
function WebSearchChip({ citations }: { citations: Citation[] }) {
  const shouldReduce = useReducedMotion();
  const fetchedAtIso = citations[0]?.asOf;
  const time = formatFetchedAt(fetchedAtIso);
  const count = citations.length;
  const headline = `Searched the web${time ? ` at ${time}` : ""} · ${String(count)} ${
    count === 1 ? "source" : "sources"
  }`;

  return (
    <motion.div
      className="mt-2 flex flex-col gap-1.5"
      data-testid="web-search-citation"
      {...(fetchedAtIso ? { "data-fetched-at": fetchedAtIso } : {})}
      initial={shouldReduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
    >
      <span
        className="inline-flex items-center gap-1.5 text-xs"
        style={{
          color: "var(--eco-text-secondary)",
          fontFamily: "var(--eco-font-body)",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--eco-primary)" }}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
            clipRule="evenodd"
          />
        </svg>
        {headline}
      </span>

      <ul className="flex flex-wrap gap-1.5" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {citations.map((citation, index) => (
          <li key={`${citation.url}-${String(index)}`} className="max-w-full">
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${citation.title} (opens in a new tab)`}
              className="inline-flex max-w-full items-center rounded-full border border-[var(--eco-border)] px-3 py-1 text-xs no-underline transition-[border-color,box-shadow,background-color] motion-reduce:transition-none hover:border-[var(--eco-primary)]/30 hover:shadow-[var(--eco-shadow-md)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eco-primary)]"
              style={{
                backgroundColor: "var(--eco-surface-elevated)",
                color: "var(--eco-primary)",
                fontFamily: "var(--eco-font-body)",
              }}
            >
              <span className="truncate">{citation.title}</span>
            </a>
          </li>
        ))}
      </ul>
    </motion.div>
  );
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
