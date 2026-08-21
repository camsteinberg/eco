// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useChatStore } from "../../stores/chatStore";

/**
 * The quiet note for a model that holds less of the conversation.
 *
 * Models differ in how much of a chat they can hold at once, and the deeper
 * model on most devices holds about half what the everyday one does. Switching
 * to it mid-conversation silently pushes more of the history out of context —
 * the divider in the transcript moves down, and nothing says why.
 *
 * So this says why, once per conversation, and then gets out of the way. It is
 * deliberately NOT a modal and NOT a demand to start a new chat: nothing is
 * lost, the earlier messages are still on screen and still in the conversation,
 * they are simply outside what this model reads. It also does not restate what
 * the divider already says; it points at it.
 *
 * The lifecycle lives in `chatStore` (`contextWindowNotice`), so switching
 * conversations resets it and a dismissal sticks. `useChat` owns the predicate
 * that raises it.
 */
export function ContextWindowNotice({ className = "" }: { className?: string }) {
  const notice = useChatStore((s) => s.contextWindowNotice);
  const dismiss = useChatStore((s) => s.dismissContextWindowNotice);
  const shouldReduce = useReducedMotion();

  // Collapses its own height on the way out so the transcript above settles
  // gently instead of jumping. Reduced motion: instant in, instant out.
  const initial = shouldReduce ? { opacity: 0 } : { opacity: 0, y: 4, height: 0 };
  const enter = shouldReduce
    ? { opacity: 1 }
    : { opacity: 1, y: 0, height: "auto" as const };
  const exit = shouldReduce ? { opacity: 0 } : { opacity: 0, y: -2, height: 0 };

  return (
    <AnimatePresence initial={!shouldReduce}>
      {notice === "visible" && (
        <motion.aside
          key="context-window-notice"
          data-testid="context-window-notice"
          role="note"
          aria-label="About this model's context"
          initial={initial}
          animate={enter}
          exit={exit}
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
          className={`overflow-hidden ${className}`}
        >
          <div
            className="flex items-start gap-2.5 rounded-[var(--eco-radius-md)] border px-3 py-2.5"
            style={{
              backgroundColor: "var(--eco-surface-elevated)",
              borderColor: "var(--eco-border)",
            }}
          >
            <p
              className="min-w-0 flex-1 text-xs leading-relaxed"
              style={{
                color: "var(--eco-text-secondary)",
                fontFamily: "var(--eco-font-body)",
              }}
            >
              This model holds less of the conversation, so more of the earlier
              messages are set aside above the line.
            </p>

            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss"
              data-testid="context-window-notice-dismiss"
              className="-mr-1 -mt-0.5 shrink-0 rounded-[var(--eco-radius-sm)] p-1 transition-colors hover:bg-[var(--eco-surface)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--eco-primary)] motion-reduce:transition-none"
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
