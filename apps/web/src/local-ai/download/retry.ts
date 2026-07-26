// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Transient retry — the INNER recovery axis of the download transport.
 *
 * Two axes recover a failing download, and they compose:
 *
 *   - INNER (here): re-attempt the SAME source after a short backoff. A single
 *     network blip on one request must not fail a whole model download — the
 *     case that matters most is a 40 KB config file on the single-GET path,
 *     where there is no chunk boundary to resume from and (with no CDN
 *     configured) no second source to fall back to.
 *   - OUTER (`fetchFileToBlobWithFallback`): switch SOURCE (CDN → proxy) once
 *     the inner attempts for a source are spent.
 *
 * Bounded on purpose. `ProgressTracker` fires `early-stall` after 30 s without
 * forward motion and `prepareModelForSlot` abandons an attempt at 60 s, so the
 * whole backoff budget for one retry cycle (~2.5 s worst case) has to stay far
 * below those windows: backoff must never be the thing that kills a download.
 *
 * Abort-aware by construction. A bare `setTimeout` here would keep a cancelled
 * download alive for the length of the sleep — the cooperative-abort failure
 * mode that already cost this codebase a live chat lockup. Every sleep races
 * the signal and rejects the instant it aborts; an abort is never retried and
 * never consumes an attempt.
 *
 * This module is deliberately free of download-specific types: the caller
 * supplies the retryability predicate and the abort-error constructor, so the
 * error taxonomy stays in `download.ts` and there is no import cycle.
 */

/** Extra attempts per source attempt on a transient failure. */
export const TRANSIENT_RETRY_MAX = 2;

/** First backoff delay. Subsequent retries scale by TRANSIENT_RETRY_FACTOR. */
export const TRANSIENT_RETRY_BASE_DELAY_MS = 500;

/** Growth factor per retry: 500 ms → 1500 ms with the defaults above. */
const TRANSIENT_RETRY_FACTOR = 3;

/**
 * Jitter spread, ±25% of the nominal delay. Enough to de-correlate the many
 * parallel clients a shared outage produces, small enough that the worst-case
 * cumulative delay (~2.5 s) stays a rounding error against the 30 s stall window.
 */
const TRANSIENT_RETRY_JITTER = 0.25;

export type TransientRetryOptions = {
  /** Cancels both the attempt loop and any in-flight backoff sleep. */
  signal: AbortSignal;
  /** Builds the error thrown when `signal` aborts (during an attempt or a sleep). */
  abortError: () => Error;
  /** True when an identical re-attempt against the same source could succeed. */
  isRetryable: (err: unknown) => boolean;
  /** Extra attempts after the first. Defaults to TRANSIENT_RETRY_MAX. */
  maxRetries?: number;
  /** Base backoff. Defaults to TRANSIENT_RETRY_BASE_DELAY_MS; 0 disables sleeping. */
  baseDelayMs?: number;
  /** Jitter source in [0, 1). Defaults to `Math.random`; tests pin it. */
  random?: () => number;
};

/**
 * Nominal backoff for `retryIndex` (0-based), jittered by ±TRANSIENT_RETRY_JITTER.
 * Exported so the schedule is assertable without exercising the sleep.
 */
export function transientRetryDelayMs(
  retryIndex: number,
  baseDelayMs: number = TRANSIENT_RETRY_BASE_DELAY_MS,
  random: () => number = Math.random,
): number {
  if (baseDelayMs <= 0) return 0;
  const nominal = baseDelayMs * TRANSIENT_RETRY_FACTOR ** retryIndex;
  const jitter = 1 + (random() * 2 - 1) * TRANSIENT_RETRY_JITTER;
  return Math.max(0, Math.round(nominal * jitter));
}

/**
 * Run `attempt`, re-running it after a jittered backoff while the failure is
 * retryable and attempts remain. Rethrows the last error once they are spent.
 *
 * Aborts short-circuit everything: they are not retryable, they do not consume
 * an attempt, and they interrupt a backoff sleep immediately.
 */
export async function withTransientRetry<T>(
  attempt: () => Promise<T>,
  opts: TransientRetryOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? TRANSIENT_RETRY_MAX;
  const baseDelayMs = opts.baseDelayMs ?? TRANSIENT_RETRY_BASE_DELAY_MS;
  const random = opts.random ?? Math.random;

  // Read through a call so the compiler cannot narrow `aborted` to false for
  // the rest of an iteration — it flips underneath us, mid-attempt.
  const throwIfAborted = (): void => {
    if (opts.signal.aborted) throw opts.abortError();
  };

  for (let retryIndex = 0; ; retryIndex++) {
    throwIfAborted();
    try {
      return await attempt();
    } catch (err) {
      // An abort is a user/tab cancel, not a transport failure — surface it as
      // the caller's abort error rather than retrying whatever it looked like.
      throwIfAborted();
      if (retryIndex >= maxRetries || !opts.isRetryable(err)) throw err;
      await abortableSleep(
        transientRetryDelayMs(retryIndex, baseDelayMs, random),
        opts.signal,
        opts.abortError,
      );
    }
  }
}

/**
 * Sleep `ms`, rejecting the moment `signal` aborts. The timer and the abort
 * listener are both released on every exit path so a completed backoff leaves
 * nothing attached to a long-lived signal.
 */
async function abortableSleep(
  ms: number,
  signal: AbortSignal,
  abortError: () => Error,
): Promise<void> {
  if (signal.aborted) throw abortError();
  if (ms <= 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = (): void => { reject(abortError()); };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
