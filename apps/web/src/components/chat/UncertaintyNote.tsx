// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, useReducedMotion } from "motion/react";
import type { GroundingVerification } from "../../lib/tools";

/**
 * The deterministic "couldn't confirm this" marker (#grounding-uncertainty Task 3).
 *
 * Grounding KNOWS when an answer isn't backed by a confirmed source — it hedged or
 * couldn't reach its sources — but the small 1–2B model often under-writes that
 * caveat in prose, so nothing reaches the user. This is the honest counterpart to
 * the FOUND source chip ({@link CitationBlock}): a turn is either backed by a source
 * (chip) or it isn't (this note). They are mutually exclusive; the host renders the
 * one that matches the turn so an unverified answer is never surfaced unmarked.
 *
 * Register: calm honesty, NOT an alarm. Trust-through-restraint
 * (Signal/Proton). It shares the source chip's family vocabulary — elevated surface,
 * hairline border — as a calm full-width note under the answer (the {@link GroundingNotice}
 * treatment, so a per-message caveat is actually seen) — but swaps the
 * confident `--eco-primary` leaf for a SPARING `--eco-amber` accent (a tinted left
 * edge + a sprout glyph, never a fill) and `--eco-text-secondary` body text. Honesty
 * should feel reassuring, not like a warning banner.
 *
 * Botanical motif: where the found chip is a full mature leaf, this is a young
 * *sprout* breaking soil — "this hasn't grown into a confirmed fact yet." The soil
 * line is dashed (unsettled), the two cotyledons just emerging.
 *
 * Copy is written for the USER, not the architecture: it speaks to reliability in
 * plain language and never names an internal source ("Wikipedia"/"hedge"/"grounding").
 * `"unreachable"` reads as transient/retryable — distinct from `"unverified"` (no
 * source confirmed the claim).
 */
export function UncertaintyNote({
  status,
}: {
  status: GroundingVerification["status"];
}) {
  const shouldReduce = useReducedMotion();

  const text =
    status === "unreachable"
      ? "Eco couldn’t reach its sources to check this just now — try again in a moment."
      : "Eco couldn’t confirm this against a source — worth a quick double-check if it matters.";

  // Screen-reader prefix matches the state: "unverified" is the epistemic case (no
  // source confirmed the claim); "unreachable" is transient (sources couldn't be
  // reached just now), so it gets the accurate "couldn’t verify" framing, not a flat
  // "unverified" verdict.
  const accessibleName =
    status === "unreachable"
      ? "Couldn’t verify: Eco couldn’t reach its sources to check this just now"
      : "Unverified: Eco couldn’t confirm this against a source";

  return (
    <motion.aside
      role="note"
      aria-label={accessibleName}
      data-testid="uncertainty-note"
      data-status={status}
      initial={shouldReduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      className="mt-2"
    >
      <div
        className="flex items-start gap-2 rounded-[var(--eco-radius-md)] border border-[var(--eco-border)] border-l-2 border-l-[var(--eco-amber)] px-3 py-2"
        style={{ backgroundColor: "var(--eco-surface-elevated)" }}
      >
        {/* Botanical motif: a young sprout breaking dashed soil — not yet a fact. */}
        <span
          className="mt-px shrink-0"
          style={{ color: "var(--eco-amber)" }}
          aria-hidden="true"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            {/* Dashed soil line — unsettled ground. */}
            <path d="M4 19h16" strokeDasharray="2.5 2.5" />
            {/* Stem rising from the soil. */}
            <path d="M12 19v-6" />
            {/* Two cotyledons just unfurling. */}
            <path d="M12 13c-.6-2.6-2.6-3.8-4.8-3.6-.2 2.6 1.4 4.2 4.8 3.6z" />
            <path d="M12 13c.6-2.6 2.6-3.8 4.8-3.6.2 2.6-1.4 4.2-4.8 3.6z" />
          </svg>
        </span>

        <p
          className="min-w-0 flex-1 text-[13px] leading-relaxed"
          style={{
            color: "var(--eco-text-secondary)",
            fontFamily: "var(--eco-font-body)",
          }}
        >
          {text}
        </p>
      </div>
    </motion.aside>
  );
}
