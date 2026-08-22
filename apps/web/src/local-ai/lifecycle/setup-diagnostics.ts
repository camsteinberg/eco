// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Setup-failure visibility.
 *
 * Each first-run model attempt that fails is demoted by the cascade and its
 * real reason is folded into the generic SETUP_EXHAUSTED_REASON screen. The
 * net effect: a real-hardware setup failure (e.g. a WebGPU/iGPU wall the
 * catalog can't predict, like an adapter that downloads a model then can't
 * run it) is hard to diagnose from the field — the rich smoke diagnostic
 * isn't always written.
 *
 * This logs each failed attempt to `console.error` with a stable tag, so the
 * exact error, phase, and model are always visible in the user's own console.
 * It is a diagnostic signal, not chatty logging — it fires only on a setup
 * failure.
 *
 * The same failures are also kept in a small in-memory ring buffer so the
 * user-facing diagnostics dump (`exportDiagnostics`) carries them: a support
 * export taken after setup exhausted previously showed no setup signal at all,
 * because the reasons lived only in the console.
 */

export const SETUP_FAILURE_LOG_TAG = '[eco-setup-failure]';

export type SetupAttemptFailureDetail = {
  modelId: string;
  /** Runtime the model uses (litert | transformers | webllm) — narrows the cause. */
  runtime: string;
  phase: 'download' | 'load-or-smoke';
  /** Human-readable reason (the caught error's message, or a smoke reason). */
  reason: string;
  /** The raw thrown value, when one was caught (absent for a non-throwing smoke fail). */
  error?: unknown;
};

export type FormattedSetupFailure = {
  modelId: string;
  runtime: string;
  phase: 'download' | 'load-or-smoke';
  reason: string;
  errorName?: string;
  stack?: string;
};

/** Stack lines kept — enough to locate the throw without flooding the console. */
const STACK_LINES = 4;

export function formatSetupAttemptFailure(detail: SetupAttemptFailureDetail): FormattedSetupFailure {
  const out: FormattedSetupFailure = {
    modelId: detail.modelId,
    runtime: detail.runtime,
    phase: detail.phase,
    reason: detail.reason,
  };
  if (detail.error instanceof Error) {
    out.errorName = detail.error.name;
    if (detail.error.stack) {
      out.stack = detail.error.stack.split('\n').slice(0, STACK_LINES).join('\n');
    }
  }
  return out;
}

/** A recorded setup failure — the formatted detail plus when it was captured. */
export type RecordedSetupFailure = FormattedSetupFailure & {
  /** ISO-8601 capture time. */
  at: string;
};

/**
 * How many recent failures to retain. A first-run cascade tries at most a
 * handful of models across two phases each, so ~20 comfortably covers a full
 * exhaustion run while bounding memory; oldest are evicted first.
 */
const MAX_RECENT_FAILURES = 20;

const recentFailures: RecordedSetupFailure[] = [];

/**
 * The recent setup-attempt failures, oldest first — folded into the diagnostics
 * dump so a support export taken after setup exhausted carries the real reasons.
 * Returns a copy so callers can't mutate the buffer.
 */
export function getRecentSetupFailures(): RecordedSetupFailure[] {
  return [...recentFailures];
}

/** Test-only: clear the ring buffer between cases. */
export function _resetSetupFailuresForTesting(): void {
  recentFailures.length = 0;
}

export function logSetupAttemptFailure(detail: SetupAttemptFailureDetail): void {
  // Format once and reuse for both the console line and the ring buffer.
  const formatted = formatSetupAttemptFailure(detail);
  // Record into the ring buffer first (best-effort) so the reason survives into
  // the diagnostics dump even if the console write is somehow unavailable.
  try {
    recentFailures.push({ ...formatted, at: new Date().toISOString() });
    if (recentFailures.length > MAX_RECENT_FAILURES) {
      recentFailures.splice(0, recentFailures.length - MAX_RECENT_FAILURES);
    }
  } catch {
    // Recording must never break setup.
  }
  // Direct console.error on purpose — see module doc. Best-effort; never throw
  // from a diagnostic.
  try {
    // eslint-disable-next-line no-console
    console.error(SETUP_FAILURE_LOG_TAG, formatted);
  } catch {
    // Diagnostics must never break setup.
  }
}
