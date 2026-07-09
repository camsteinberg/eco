// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

/**
 * Subtle visual divider marking the boundary between messages that are
 * no longer in the model's context window and those that are.
 */
export function ContextDivider() {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2"
      role="note"
      aria-label="Context window boundary"
    >
      <div className="flex-1 border-t border-[var(--eco-border)]" />
      <span className="whitespace-nowrap text-xs text-[var(--eco-text-secondary)]">
        Messages above are no longer in context
      </span>
      <div className="flex-1 border-t border-[var(--eco-border)]" />
    </div>
  );
}
