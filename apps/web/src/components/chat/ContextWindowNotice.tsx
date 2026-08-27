// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useChatStore } from "../../stores/chatStore";

/**
 * The note that says Eco can no longer see the start of this chat.
 *
 * Once a conversation outgrows the model's context window, the earliest turns
 * are no longer sent to the model. The divider in the transcript marks that
 * boundary, but it sits off-screen above, and the model itself never says it
 * cannot see the earlier turns — measured on the 1.2B, it summarizes "what we
 * decided" confidently and wrongly. So this note sits by the composer, says
 * how many messages are out of view, and says what to do: start a new chat or
 * paste the details that matter. Nothing is lost — the messages are still on
 * screen and still in the conversation — so it is a note, not an alert.
 *
 * The lifecycle lives in `chatStore` (`contextWindowNotice`): `useChat` raises
 * it while the divider exists, withdraws it if the chat fits again, and a
 * dismissal sticks for the conversation.
 */
export function ContextWindowNotice({
  className = "",
  droppedCount = 0,
}: {
  className?: string;
  /** Messages above the divider — the ones the model no longer reads. */
  droppedCount?: number;
}) {
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
          aria-label="Earlier messages are out of context"
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
              {contextWindowNoticeCopy(droppedCount)}
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

/** @internal Exported for unit testing. */
export function contextWindowNoticeCopy(droppedCount: number): string {
  const which =
    droppedCount === 1
      ? "the first message"
      : droppedCount > 1
        ? `the first ${droppedCount} messages`
        : "the earliest messages";
  return `Eco can no longer see ${which} in this chat. Start a new chat, or paste the details that matter into your next message.`;
}
