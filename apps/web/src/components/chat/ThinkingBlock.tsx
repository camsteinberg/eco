// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { getTransition } from "@eco/ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThinkingBlockProps = {
  content: string;
  defaultCollapsed?: boolean;
};

// ---------------------------------------------------------------------------
// Brain icon SVG (16x16)
// ---------------------------------------------------------------------------

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className ?? "h-4 w-4"}
      aria-hidden="true"
    >
      <path d="M8 1a4 4 0 00-4 4c0 .7.2 1.4.5 2A4 4 0 003 11a4 4 0 004 4h2a4 4 0 004-4 4 4 0 00-1.5-4c.3-.6.5-1.3.5-2a4 4 0 00-4-4zm0 2a2 2 0 012 2 2 2 0 01-.5 1.3l-.5.7.5.7A2 2 0 0111 11a2 2 0 01-2 2H7a2 2 0 01-2-2 2 2 0 011.5-3.3l.5-.7-.5-.7A2 2 0 016 5a2 2 0 012-2z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Chevron icon
// ---------------------------------------------------------------------------

function ChevronIcon({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={`${className ?? "h-3 w-3"} transition-transform ${expanded ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M4.22 6.22a.75.75 0 011.06 0L8 8.94l2.72-2.72a.75.75 0 111.06 1.06l-3.25 3.25a.75.75 0 01-1.06 0L4.22 7.28a.75.75 0 010-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ThinkingBlock({
  content,
  defaultCollapsed = true,
}: ThinkingBlockProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const shouldReduce = useReducedMotion();
  const transition = getTransition("gentle", shouldReduce);

  return (
    <div className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-3">
      {/* Toggle header */}
      <button
        type="button"
        data-testid="thinking-toggle"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 text-left"
      >
        <BrainIcon className="h-4 w-4 shrink-0 text-[var(--eco-text-muted)]" />
        <span className="flex-1 text-xs font-medium text-[var(--eco-text-muted)]">
          Thinking...
        </span>
        <ChevronIcon
          expanded={!collapsed}
          className="h-3 w-3 text-[var(--eco-text-muted)]"
        />
      </button>

      {/* Collapsible content area */}
      <motion.div
        data-testid="thinking-content"
        data-collapsed={collapsed ? "true" : "false"}
        animate={{
          height: collapsed ? 0 : "auto",
          opacity: collapsed ? 0 : 1,
        }}
        initial={false}
        transition={transition}
        className="overflow-hidden"
      >
        <p className="mt-2 text-sm leading-relaxed text-[var(--eco-text-secondary)]">
          {content}
        </p>
      </motion.div>
    </div>
  );
}
