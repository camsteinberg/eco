// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type StreamInterruptedProps = {
  onRetry: () => void;
};

export function StreamInterrupted({ onRetry }: StreamInterruptedProps) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="mt-2 text-xs leading-relaxed text-[var(--eco-text-secondary)]"
    >
      We lost the connection partway through.{" "}
      <button
        type="button"
        onClick={onRetry}
        className="cursor-pointer font-medium text-[var(--eco-primary)] underline-offset-2 transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
      >
        Try again
      </button>
      .
    </p>
  );
}
