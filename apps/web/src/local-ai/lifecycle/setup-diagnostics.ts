// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Setup-failure visibility.
 *
 * Each first-run model attempt that fails is demoted by the cascade and its
 * real reason is folded into the generic SETUP_EXHAUSTED_REASON screen — and
 * `logger.error` routes to Sentry (not the console) in production. The net
 * effect: a real-hardware setup failure (e.g. a WebGPU/iGPU wall the catalog
 * can't predict, like an adapter that downloads a model then can't run it) is
 * undiagnosable from the field — the user's devtools show only fetch logs, and
 * the rich smoke diagnostic isn't always written.
 *
 * This logs each failed attempt to `console.error` DIRECTLY (deliberately not
 * via `logger`, whose prod path writes only to Sentry), so the exact error,
 * phase, and model are always visible in the user's own console. It is a
 * diagnostic signal, not chatty logging — it fires only on a setup failure.
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

export function logSetupAttemptFailure(detail: SetupAttemptFailureDetail): void {
  // Direct console.error on purpose — see module doc. Best-effort; never throw
  // from a diagnostic.
  try {
    // eslint-disable-next-line no-console
    console.error(SETUP_FAILURE_LOG_TAG, formatSetupAttemptFailure(detail));
  } catch {
    // Diagnostics must never break setup.
  }
}
