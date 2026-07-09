// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

'use client';

import { motion, useReducedMotion } from 'motion/react';

type GrowingStemProgressProps = {
  /** Progress value from 0 to 1 */
  progress: number;
};

/**
 * A botanical growing stem progress indicator.
 *
 * An SVG stem grows from bottom to top based on progress.
 * Leaves sprout at 25%, 50%, 75% milestones. At 100% a small
 * flower blooms at the top.
 *
 * Falls back to a standard horizontal bar when the user prefers
 * reduced motion.
 */
export function GrowingStemProgress({ progress }: GrowingStemProgressProps) {
  const shouldReduceMotion = useReducedMotion();
  const clampedProgress = Math.min(Math.max(progress, 0), 1);

  // Reduced motion: simple progress bar
  if (shouldReduceMotion) {
    return (
      <div
        data-testid="growing-stem-progress"
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--eco-surface-elevated)]"
        role="progressbar"
        aria-valuenow={Math.round(clampedProgress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-[var(--eco-accent)]"
          style={{ width: `${String(Math.round(clampedProgress * 100))}%` }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid="growing-stem-progress"
      className="flex justify-center"
      role="progressbar"
      aria-valuenow={Math.round(clampedProgress * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg
        width="60"
        height="120"
        viewBox="0 0 60 120"
        fill="none"
        className="text-[var(--eco-primary)]"
      >
        {/* Stem: grows from bottom to top */}

        <motion.path
          d="M30 110 C30 95, 28 80, 30 65 C32 50, 29 35, 30 20"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: clampedProgress }}
          transition={{ type: 'spring', stiffness: 100, damping: 20 }}
        />

        {/* Leaf at 25% milestone (right side, y ~88) */}
        {clampedProgress >= 0.25 && (
          <motion.path
            d="M30 88 C35 85, 42 83, 44 86 C42 89, 35 90, 30 88"
            fill="currentColor"
            opacity={0.7}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 15 }}
            style={{ transformOrigin: '30px 88px' }}
          />
        )}

        {/* Leaf at 50% milestone (left side, y ~65) */}
        {clampedProgress >= 0.5 && (
          <motion.path
            d="M30 65 C25 62, 18 60, 16 63 C18 66, 25 67, 30 65"
            fill="currentColor"
            opacity={0.7}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 15 }}
            style={{ transformOrigin: '30px 65px' }}
          />
        )}

        {/* Leaf at 75% milestone (right side, y ~42) */}
        {clampedProgress >= 0.75 && (
          <motion.path
            d="M30 42 C35 39, 42 37, 44 40 C42 43, 35 44, 30 42"
            fill="currentColor"
            opacity={0.7}
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 15 }}
            style={{ transformOrigin: '30px 42px' }}
          />
        )}

        {/* Flower at 100% */}
        {clampedProgress >= 1 && (
          <motion.g
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 200, damping: 12 }}
            style={{ transformOrigin: '30px 18px' }}
          >
            {/* Petals */}
            <circle cx="30" cy="14" r="4" fill="currentColor" opacity={0.5} />
            <circle cx="25" cy="18" r="3.5" fill="currentColor" opacity={0.4} />
            <circle cx="35" cy="18" r="3.5" fill="currentColor" opacity={0.4} />
            <circle cx="27" cy="22" r="3" fill="currentColor" opacity={0.3} />
            <circle cx="33" cy="22" r="3" fill="currentColor" opacity={0.3} />
            {/* Center */}
            <circle cx="30" cy="18" r="2.5" fill="var(--eco-accent)" />
          </motion.g>
        )}
      </svg>
    </div>
  );
}
