// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, useReducedMotion } from "motion/react";
import { SeedlingIllustration } from "@eco/ui";

/**
 * The composer, present from first paint — before the on-device model is ready.
 *
 * While Eco sets up, the real chat composer isn't wired yet, but a painted page
 * with no place to type reads as broken. This renders a quiet, disabled stand-in
 * in the exact box geometry the live composer (`ChatInput`) will occupy, so the
 * input is visibly "here, warming up" instead of missing. When the model becomes
 * ready the seedling in the send slot springs into the real send button and the
 * placeholder swaps to the live one — a single, calm sign of life.
 *
 * Presentational only: the textarea is disabled (no hidden submit path), and no
 * download progress is narrated here — that detail lives on the setup surface.
 */

const MAX_HEIGHT = 192;

export type GerminatingComposerProps = {
  /** True once the on-device model is ready. Springs the send slot to life. */
  ready?: boolean;
};

export function GerminatingComposer({ ready = false }: GerminatingComposerProps) {
  const reducedMotion = useReducedMotion();

  return (
    <div className="rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] shadow-sm">
      <div className="flex items-center gap-3 px-4 py-3">
        {/* The textarea holds the 44px tap-target height (not collapsed at sm+)
            so this box matches the live ChatInput's row height exactly — the
            live composer's row is 44px tall (its research toggle), so nothing
            resizes when the stand-in swaps for the real composer. */}
        <textarea
          value=""
          readOnly
          disabled
          aria-disabled="true"
          aria-label="Message input"
          rows={1}
          placeholder={
            ready ? "Ask Eco anything..." : "Eco is getting ready on this device…"
          }
          className="min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[15px] leading-normal text-[var(--eco-text)] placeholder:text-[var(--eco-text-secondary)] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: `${MAX_HEIGHT}px`, overflowY: "auto" }}
          tabIndex={-1}
        />

        {/* Send slot. The seedling (a thing that grows toward ready) occupies the
            send button's footprint, then springs into the real send button on
            ready. One transition — respects reduced motion. The ready button is
            disabled here: this is the pre-live stand-in, so it never sends. */}
        <motion.span
          key={ready ? "ready" : "germinating"}
          className="inline-flex shrink-0"
          initial={reducedMotion ? false : { scale: 0.72, opacity: 0.5 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 320, damping: 26 }
          }
        >
          {ready ? (
            <button
              type="button"
              disabled
              aria-label="Send message"
              className="flex h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 shrink-0 items-center justify-center rounded-full text-white disabled:cursor-not-allowed"
              style={{ backgroundColor: "var(--eco-accent)" }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M3.105 2.289a.75.75 0 00-.826.95l1.903 6.557H13.5a.75.75 0 010 1.5H4.182l-1.903 6.557a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
              </svg>
            </button>
          ) : (
            <span
              aria-hidden="true"
              className="flex h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 shrink-0 items-center justify-center rounded-full text-[var(--eco-primary)]"
            >
              <SeedlingIllustration size={20} />
            </span>
          )}
        </motion.span>
      </div>

      {/* One calm, polite status — no chatter. Announces readiness to assistive
          tech without pulling focus. */}
      <span role="status" aria-live="polite" className="sr-only">
        {ready ? "Eco is ready" : "Eco is getting ready"}
      </span>
    </div>
  );
}
