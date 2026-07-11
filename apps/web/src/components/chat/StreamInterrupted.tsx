// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type InterruptedReason = "user-stop" | "fault" | "restore-detected";

type StreamInterruptedProps = {
  onRetry: () => void;
  /**
   * Why the reply stopped, when known. Drives honest per-cause copy. Inference
   * runs on-device, so nothing here ever mentions a network "connection":
   * - `user-stop` acknowledges the user's own Stop.
   * - `fault` / `restore-detected` / unknown fall back to neutral "didn't
   *   finish" phrasing (also correct for an empty bubble left by a crash/reload).
   */
  reason?: InterruptedReason;
};

// Lead-in copy per cause. The user-stop line names what the user did; every
// other cause states plainly that the reply didn't finish, without guessing at
// or dramatizing why.
function leadCopy(reason: InterruptedReason | undefined): string {
  return reason === "user-stop"
    ? "You stopped this reply."
    : "This reply didn’t finish.";
}

export function StreamInterrupted({ onRetry, reason }: StreamInterruptedProps) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="mt-2 text-xs leading-relaxed text-[var(--eco-text-secondary)]"
    >
      {leadCopy(reason)}{" "}
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
