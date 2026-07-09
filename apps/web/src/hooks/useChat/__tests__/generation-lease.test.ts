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
