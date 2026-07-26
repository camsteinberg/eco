// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC
// @vitest-environment node

/**
 * withTransientRetry — the inner recovery axis of the download transport.
 *
 * Fake timers throughout: the point of the backoff is that it is real time on a
 * device, and a suite that actually slept it would trade seconds for nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TRANSIENT_RETRY_BASE_DELAY_MS,
  TRANSIENT_RETRY_MAX,
  transientRetryDelayMs,
  withTransientRetry,
} from '../retry';

class TestAbortError extends Error {
  constructor() {
    super('aborted');
    this.name = 'TestAbortError';
  }
}

class Retryable extends Error {}
class Fatal extends Error {}

/** Options with the two injected policies fixed and jitter pinned to 1.0×. */
function opts(signal: AbortSignal, overrides?: Partial<Parameters<typeof withTransientRetry>[1]>) {
  return {
    signal,
    abortError: () => new TestAbortError(),
    isRetryable: (err: unknown) => err instanceof Retryable,
    random: () => 0.5,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Backoff schedule ──────────────────────────────────────────────────────

describe('transientRetryDelayMs', () => {
  it('grows 500ms → 1500ms across the two retries at zero jitter', () => {
    expect(transientRetryDelayMs(0, TRANSIENT_RETRY_BASE_DELAY_MS, () => 0.5)).toBe(500);
    expect(transientRetryDelayMs(1, TRANSIENT_RETRY_BASE_DELAY_MS, () => 0.5)).toBe(1500);
  });

  it('jitters within ±25% of the nominal delay', () => {
    const lowest = transientRetryDelayMs(0, TRANSIENT_RETRY_BASE_DELAY_MS, () => 0);
    const highest = transientRetryDelayMs(0, TRANSIENT_RETRY_BASE_DELAY_MS, () => 1);
    expect(lowest).toBe(375);
    expect(highest).toBe(625);

    for (const random of [() => 0, () => 0.25, () => 0.5, () => 0.75, () => 1]) {
      const delay = transientRetryDelayMs(1, TRANSIENT_RETRY_BASE_DELAY_MS, random);
      expect(delay).toBeGreaterThanOrEqual(1125);
      expect(delay).toBeLessThanOrEqual(1875);
    }
  });

  it('keeps the whole retry cycle far under the 30s early-stall window', () => {
    // The tracker calls 30s of no forward motion a stall and prepareModelForSlot
    // abandons the attempt at 60s: backoff must never be what kills a download.
    let worstCase = 0;
    for (let i = 0; i < TRANSIENT_RETRY_MAX; i++) {
      worstCase += transientRetryDelayMs(i, TRANSIENT_RETRY_BASE_DELAY_MS, () => 1);
    }
    expect(worstCase).toBeLessThan(5_000);
  });

  it('sleeps not at all when the base delay is zeroed', () => {
    expect(transientRetryDelayMs(0, 0, () => 1)).toBe(0);
    expect(transientRetryDelayMs(1, 0, () => 1)).toBe(0);
  });
});

// ─── Retry loop ────────────────────────────────────────────────────────────

describe('withTransientRetry', () => {
  it('returns the first attempt value without sleeping', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => Promise.resolve('ok'));
    await expect(withTransientRetry(attempt, opts(controller.signal))).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a retryable failure after the scheduled backoff and succeeds', async () => {
    const controller = new AbortController();
    let calls = 0;
    const attempt = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Retryable('blip'))
        : Promise.resolve('ok');
    });

    const promise = withTransientRetry(attempt, opts(controller.signal));
    await vi.advanceTimersByTimeAsync(499); // still sleeping
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last error once the attempts are spent', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => Promise.reject(new Retryable('still down')));

    const promise = withTransientRetry(attempt, opts(controller.signal));
    const settled = expect(promise).rejects.toThrow('still down');
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    // One attempt plus TRANSIENT_RETRY_MAX retries — no more.
    expect(attempt).toHaveBeenCalledTimes(TRANSIENT_RETRY_MAX + 1);
  });

  it('fails fast on a non-retryable error', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => Promise.reject(new Fatal('hard 4xx')));

    await expect(withTransientRetry(attempt, opts(controller.signal)))
      .rejects.toBeInstanceOf(Fatal);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a caller-supplied maxRetries', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => Promise.reject(new Retryable('down')));

    const promise = withTransientRetry(attempt, opts(controller.signal, { maxRetries: 1 }));
    const settled = expect(promise).rejects.toBeInstanceOf(Retryable);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

// ─── Abort ─────────────────────────────────────────────────────────────────

describe('withTransientRetry — abort', () => {
  it('throws the abort error DURING the backoff sleep, without waiting it out', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => Promise.reject(new Retryable('blip')));

    const promise = withTransientRetry(attempt, opts(controller.signal));
    const settled = expect(promise).rejects.toBeInstanceOf(TestAbortError);
    await vi.advanceTimersByTimeAsync(0); // first attempt fails; the sleep begins
    expect(attempt).toHaveBeenCalledTimes(1);

    controller.abort();
    await settled; // resolves without advancing the clock through the 500ms sleep
    expect(attempt).toHaveBeenCalledTimes(1); // no re-attempt after the abort
  });

  it('does not consume an attempt — an aborted failure is never retried', async () => {
    const controller = new AbortController();
    const attempt = vi.fn(() => {
      controller.abort();
      // A cancelled fetch surfaces as a retryable-looking error; the abort wins.
      return Promise.reject(new Retryable('Failed to fetch'));
    });

    await expect(withTransientRetry(attempt, opts(controller.signal)))
      .rejects.toBeInstanceOf(TestAbortError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = vi.fn(() => Promise.resolve('ok'));

    await expect(withTransientRetry(attempt, opts(controller.signal)))
      .rejects.toBeInstanceOf(TestAbortError);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('leaves no timer or abort listener behind after a completed backoff', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    let calls = 0;
    const attempt = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Retryable('blip'))
        : Promise.resolve('ok');
    });

    const promise = withTransientRetry(attempt, opts(controller.signal));
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toBe('ok');

    // A backoff that outlived its sleep would keep a cancelled download alive.
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
