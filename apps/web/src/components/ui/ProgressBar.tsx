// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, useReducedMotion } from "motion/react";

export type ProgressBarProps = {
  percent: number;
  label?: string;
  ariaLabel?: string;
  working?: boolean;
};

export function ProgressBar({ percent, label, ariaLabel, working = false }: ProgressBarProps) {
  const reducedMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, percent));

  return (
    <div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel ?? label ?? "Progress"}
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: "var(--eco-border-muted)" }}
      >
        <motion.div
          className="h-full rounded-full"
          style={{ backgroundColor: "var(--eco-primary)" }}
          initial={false}
          animate={{
            width: `${Math.max(clamped, 2)}%`,
            opacity: working && !reducedMotion ? [1, 0.55, 1] : 1,
          }}
          transition={{
            width: reducedMotion
              ? { duration: 0 }
              : { type: "spring", stiffness: 120, damping: 26 },
            opacity: working
              ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 },
          }}
        />
      </div>
      {label && (
        <p
          className="mt-1.5 text-[11px] tabular-nums"
          style={{ color: "var(--eco-text-muted)" }}
        >
          {label}
        </p>
      )}
    </div>
  );
}
