// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * acquireGenerationLease — the chat-side runtime-lease acquisition
 * (instant-start slice 2a).
 *
 * Chat generation must hold the 'generation' runtime lease so a model
 * switch can never unload the runtime mid-reply. But a fail-fast acquire
 * would regress the common cold path: mount-time warmup holds a
 * 'readiness' lease for up to ~90s, and users type immediately — today
 * that send queues behind the lifecycle lock and succeeds. So:
 *
 *   - free           → acquire immediately;
 *   - readiness/warmup holder → wait (abortable, bounded) and keep trying;
 *   - any other holder (switch-model, another tab's generation, …)
 *                    → fail fast with the honest busy message;
 *   - user stop while waiting → aborted result, no message shown.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireGenerationLease } from '../generation-lease';
import { acquireLocalHeavyWork } from '../../../lib/local-heavy-work-owner';

const RUNTIME_KEY = 'eco-local-heavy-work-owner-v1';
const DOWNLOAD_KEY = 'eco-local-download-owner-v1';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.removeItem(RUNTIME_KEY);
  localStorage.removeItem(DOWNLOAD_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.removeItem(RUNTIME_KEY);
  localStorage.removeItem(DOWNLOAD_KEY);
});

describe('free runtime', () => {
  it('acquires immediately and can release', async () => {
    const result = await acquireGenerationLease();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Held: a switch may not start.
      expect(acquireLocalHeavyWork('switch-model').ok).toBe(false);
      result.release();
      expect(acquireLocalHeavyWork('switch-model').ok).toBe(true);
    }
  });
});

describe('non-waitable holder', () => {
  it('fails fast with honest copy while a switch-model lease is held', async () => {
    const switching = acquireLocalHeavyWork('switch-model');
    expect(switching.ok).toBe(true);

    const result = await acquireGenerationLease();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.aborted).toBe(false);
      expect(result.message).toMatch(/preparing a local model/i);
    }
    if (switching.ok) switching.release();
  });

  it('fails fast while another generation holds the runtime (cross-tab)', async () => {
    const other = acquireLocalHeavyWork('generation');
    expect(other.ok).toBe(true);

    const result = await acquireGenerationLease();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/already active/i);
    }
    if (other.ok) other.release();
  });
});

describe('waitable holder (readiness/warmup)', () => {
  it('waits out a readiness lease and then acquires', async () => {
    const readiness = acquireLocalHeavyWork('readiness');
    expect(readiness.ok).toBe(true);
    setTimeout(() => {
      if (readiness.ok) readiness.release();
    }, 1_000);

    const pending = acquireGenerationLease();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (result.ok) result.release();
  });

  it('gives up with the busy message when the wait budget expires', async () => {
    const readiness = acquireLocalHeavyWork('readiness');
    expect(readiness.ok).toBe(true);

    const pending = acquireGenerationLease({ waitMs: 3_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.aborted).toBe(false);
      expect(result.message).toMatch(/readiness check/i);
    }
    if (readiness.ok) readiness.release();
  });

  it('fails fast when the holder changes to a non-waitable kind mid-wait', async () => {
    const readiness = acquireLocalHeavyWork('readiness');
    expect(readiness.ok).toBe(true);
    setTimeout(() => {
      if (readiness.ok) readiness.release();
      acquireLocalHeavyWork('switch-model');
    }, 1_000);

    const pending = acquireGenerationLease();
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/preparing a local model/i);
    }
  });

  it('returns aborted (no message shown) when the user stops mid-wait', async () => {
    const readiness = acquireLocalHeavyWork('readiness');
    expect(readiness.ok).toBe(true);

    const controller = new AbortController();
    const pending = acquireGenerationLease({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.aborted).toBe(true);
    if (readiness.ok) readiness.release();
  });
});

describe('same-tab abandoned generation (mid-stream navigation)', () => {
  // The shipped failure (observed live 3× on 2026-08-07, main db3c2bf):
  // navigating away mid-stream interrupts the generation — the UI flips to
  // idle synchronously — but the 'generation' lease is released only in the
  // send loop's `finally`, once the aborted stream actually unwinds. In that
  // window the composer is enabled, OUR OWN lease is still held, and because
  // 'generation' is not a waitable kind the next send bounces with
  // "Local inference is already active" (surfaced as "Something went
  // sideways") instead of waiting out a holder this tab already abandoned.
  //
  // The invariant pinned here is implementation-agnostic: whether the fix
  // releases the lease at interrupt time or makes an own-context 'generation'
  // holder waitable, a send must never fail off this tab's own unwinding
  // lease. The cross-tab fail-fast stays honest (companion test below).

  it("waits out this tab's own still-unwinding generation lease instead of bouncing the send", async () => {
    // Our own abandoned generation: acquired in THIS context, so the owner
    // registry knows it's ours. It releases 1.5s later, when the aborted
    // stream unwinds and the send loop's `finally` runs.
    const abandoned = acquireLocalHeavyWork('generation');
    expect(abandoned.ok).toBe(true);
    setTimeout(() => {
      if (abandoned.ok) abandoned.release();
    }, 1_500);

    const pending = acquireGenerationLease();
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result.ok).toBe(true);
    if (result.ok) result.release();
  });

  it("still fails fast when the generation holder belongs to ANOTHER tab", async () => {
    // A genuinely foreign holder: a raw lease row this context never acquired
    // (cross-tab via the shared localStorage key). Waiting out another tab's
    // generation is unbounded, so the honest busy message stays correct.
    localStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({
        ownerId: 'generation:foreign-tab',
        kind: 'generation',
        startedAt: Date.now(),
        expiresAt: Date.now() + 90_000,
      }),
    );

    const result = await acquireGenerationLease();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.aborted).toBe(false);
      expect(result.message).toMatch(/already active/i);
    }
  });
});
