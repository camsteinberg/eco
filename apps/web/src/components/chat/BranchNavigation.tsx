// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { motion, AnimatePresence, useReducedMotion } from "motion/react";

type BranchNavigationProps = {
  currentIndex: number;
  totalSiblings: number;
  onPrevious: () => void;
  onNext: () => void;
};

export function BranchNavigation({
  currentIndex,
  totalSiblings,
  onPrevious,
  onNext,
}: BranchNavigationProps) {
  const shouldReduce = useReducedMotion();

  if (totalSiblings <= 1) return null;

  return (
    <div className="flex items-center gap-0.5 text-xs text-[var(--eco-text-secondary)]">
      <button
        type="button"
        onClick={onPrevious}
        disabled={currentIndex === 0}
        aria-label="Previous version"
        className="flex h-5 w-5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 items-center justify-center rounded transition-colors hover:bg-[var(--eco-primary-soft)] disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3 w-3"
        >
          <path
            fillRule="evenodd"
            d="M9.78 4.22a.75.75 0 0 1 0 1.06L7.06 8l2.72 2.72a.75.75 0 1 1-1.06 1.06L5.47 8.53a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      <span className="min-w-[2ch] text-center tabular-nums">
        <AnimatePresence mode="wait">
          {shouldReduce ? (
            <span key={currentIndex}>
              {currentIndex + 1} / {totalSiblings}
            </span>
          ) : (
            <motion.span
              key={currentIndex}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
              className="inline-block"
            >
              {currentIndex + 1} / {totalSiblings}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={currentIndex === totalSiblings - 1}
        aria-label="Next version"
        className="flex h-5 w-5 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 items-center justify-center rounded transition-colors hover:bg-[var(--eco-primary-soft)] disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 16 16"
          fill="currentColor"
          className="h-3 w-3"
        >
          <path
            fillRule="evenodd"
            d="M6.22 4.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L8.94 8 6.22 5.28a.75.75 0 0 1 0-1.06Z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
