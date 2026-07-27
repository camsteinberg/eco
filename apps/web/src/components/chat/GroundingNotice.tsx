// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useSettingsStore } from "../../stores/settingsStore";
import { buildSettingsHref } from "../settings/settingsNavigation";

/**
 * One-time "first grounded answer" disclosure (#5 S5-notice).
 *
 * Web lookups ship default-ON. The first time a turn actually produces an answer
 * backed by a web source (Wikipedia/Wikidata for facts), this calm, dismissible
 * note appears once under that message.
 *
 * The copy is written for the USER, not the architecture. A person who just got a
 * grounded answer wants two reassurances: that it's reliable (came from a real
 * source, not a guess) and that it stayed private. So that is all the note says. It
 * deliberately does NOT enumerate which sources exist — naming our internal
 * source-routing (e.g. "Wikipedia for facts") is dev-context drift that means
 * something to us, not to the user. The citation chip directly
 * above already names the specific source for THIS answer, which is where a user
 * looks for that. (Keep this principle: reassurance microcopy speaks to the user's
 * concern; specifics live on the chip and the transparency page.)
 * Dismissing (× or "Manage") flips `groundingNoticeSeen` → it disappears everywhere
 * and never returns.
 *
 * Register: Signal/Proton restraint — trust through quiet precision, not a
 * celebration. It shares the elevated-surface + hairline-border vocabulary of
 * the source chip just above it so the two read as one family, with a single
 * botanical motif (a leaf inside a shield — "grounded, on your device").
 */
export function GroundingNotice() {
  const setGroundingNoticeSeen = useSettingsStore((s) => s.setGroundingNoticeSeen);
  const shouldReduce = useReducedMotion();

  // Local dismissal so the spring exit actually plays. The parent renders us as
  // `{showGroundingNotice && <GroundingNotice />}`, so flipping the global
  // `groundingNoticeSeen` flag synchronously would unmount us before the exit
  // could animate. Instead, the × button flips `dismissed` → AnimatePresence
  // removes the child and runs the exit → `onExitComplete` flips the global flag
  // (which then unmounts the already-exited node harmlessly).
  const [dismissed, setDismissed] = useState(false);

  // × / Dismiss: start the exit; the global flag flips on exit-complete.
  const dismiss = () => {
    setDismissed(true);
  };

  // Manage: navigates away to Settings, so the exit animation is moot — mark the
  // notice seen directly.
  const markSeen = () => {
    setGroundingNoticeSeen();
  };

  // Spring entrance/exit; collapses its own height on the way out so the layout
  // settles gently. Reduced motion → instant in, instant out.
  const enter = shouldReduce
    ? { opacity: 1 }
    : { opacity: 1, y: 0, height: "auto" as const };
  const initial = shouldReduce ? { opacity: 0 } : { opacity: 0, y: 4, height: 0 };
  const exit = shouldReduce ? { opacity: 0 } : { opacity: 0, y: -2, height: 0 };

  return (
    <AnimatePresence initial={!shouldReduce} onExitComplete={setGroundingNoticeSeen}>
      {!dismissed && (
        <motion.aside
          key="grounding-notice"
          data-testid="grounding-notice"
          role="note"
          aria-label="About grounded answers"
          initial={initial}
          animate={enter}
          exit={exit}
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
          className="mt-2 overflow-hidden"
        >
          <div
            className="flex items-start gap-2.5 rounded-[var(--eco-radius-md)] border border-[var(--eco-border)] px-3 py-2.5"
            style={{ backgroundColor: "var(--eco-surface-elevated)" }}
          >
            {/* Botanical motif: a leaf nestled in a shield — grounded, on device. */}
            <span
              className="mt-px shrink-0"
              style={{ color: "var(--eco-primary)" }}
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
                {/* Shield silhouette */}
                <path d="M12 3l7 2.5v5c0 4.2-2.9 7.4-7 8.5-4.1-1.1-7-4.3-7-8.5v-5L12 3z" />
                {/* Leaf within: midrib + lamina */}
                <path d="M9.5 14.5c0-3 1.6-5 4.5-6.2-.3 3.4-1.8 5.6-4.5 6.2z" />
              </svg>
            </span>

            <p
              className="min-w-0 flex-1 text-[13px] leading-relaxed"
              style={{
                color: "var(--eco-text-secondary)",
                fontFamily: "var(--eco-font-body)",
              }}
            >
              Eco looked this up from a real source, so the answer isn&rsquo;t
              guesswork. The lookup went straight from your device to the source —
              Eco&rsquo;s servers never saw it.{" "}
              <a
                href={buildSettingsHref("models")}
                onClick={markSeen}
                data-testid="grounding-notice-manage"
                className="whitespace-nowrap font-medium underline decoration-[var(--eco-primary)]/30 underline-offset-2 transition-colors hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--eco-primary)]"
                style={{ color: "var(--eco-primary)" }}
              >
                Manage in Settings
              </a>
            </p>

            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
              data-testid="grounding-notice-dismiss"
              className="-mr-1 -mt-0.5 shrink-0 rounded-[var(--eco-radius-sm)] p-1 transition-colors hover:bg-[var(--eco-surface)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--eco-primary)]"
              style={{ color: "var(--eco-text-secondary)" }}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-3.5 w-3.5"
                aria-hidden="true"
              >
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
