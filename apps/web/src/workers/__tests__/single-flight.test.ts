// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationSlot, singleFlightRejection } from '../single-flight';

describe('singleFlightRejection (RT-2 worker single-flight guard)', () => {
  it('lets a generate proceed when the worker is free (no generation in flight)', () => {
    expect(singleFlightRejection(null, 'gen-1')).toBeNull();
  });

  it('rejects an incoming generate while one is already in flight', () => {
    const rejection = singleFlightRejection({ generationId: 'gen-1' }, 'gen-2');
    expect(rejection).not.toBeNull();
    // Tagged with the INCOMING id (gen-2), so the adapter routes the error to
    // the newcomer — NOT to the in-flight gen-1, which must keep running.
    expect(rejection?.generationId).toBe('gen-2');
    expect(rejection?.type).toBe('error');
    expect(rejection?.code).toBe('generation-failed');
    expect(rejection?.message).toMatch(/in progress/i);
  });
});

describe('GenerationSlot (one generation at a time, and the next waits out a stopping one)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts a generation on a free worker', async () => {
    const slot = new GenerationSlot();
    const acquired = await slot.acquire('gen-1', 1_000);
    expect(acquired.ok).toBe(true);
    expect(slot.current).toEqual({ generationId: 'gen-1', aborted: false });
  });

  it('still rejects a second generation while the first is running', async () => {
    const slot = new GenerationSlot();
    await slot.acquire('gen-1', 1_000);
    const second = await slot.acquire('gen-2', 1_000);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.rejection?.generationId).toBe('gen-2');
    expect(slot.current?.generationId).toBe('gen-1');
  });

  it('lets the next generation wait for a stopped one to finish unwinding, then start', async () => {
    // A stopped generation only ends at its next decoded token and then drops
    // its cache, so the next message can arrive while it is still unwinding.
    const slot = new GenerationSlot();
    await slot.acquire('gen-1', 1_000);
    slot.abort('gen-1');
    expect(slot.current?.aborted).toBe(true);

    let settled = false;
    const second = slot.acquire('gen-2', 1_000).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    slot.release();
    const result = await second;
    expect(result.ok).toBe(true);
    expect(slot.current).toEqual({ generationId: 'gen-2', aborted: false });
  });

  it('rejects the next generation if a stopped one never finishes unwinding', async () => {
    vi.useFakeTimers();
    const slot = new GenerationSlot();
    await slot.acquire('gen-1', 1_000);
    slot.abort('gen-1');

    const second = slot.acquire('gen-2', 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await second;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection?.message).toMatch(/in progress/i);
    expect(slot.current?.generationId).toBe('gen-1');
  });

  it('drops a waiting generation that is itself stopped before it starts', async () => {
    const slot = new GenerationSlot();
    await slot.acquire('gen-1', 1_000);
    slot.abort('gen-1');
    const second = slot.acquire('gen-2', 1_000);
    slot.abort('gen-2');
    slot.release();

    const result = await second;
    // Nobody is reading it any more: no generation, and no error to post.
    expect(result).toEqual({ ok: false, rejection: null });
    expect(slot.current).toBeNull();
  });

  it('lets only one of two waiting generations start', async () => {
    const slot = new GenerationSlot();
    await slot.acquire('gen-1', 1_000);
    slot.abort('gen-1');
    const second = slot.acquire('gen-2', 1_000);
    const third = slot.acquire('gen-3', 1_000);
    slot.release();

    const [a, b] = await Promise.all([second, third]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(slot.current?.generationId).toBe('gen-2');
  });

  it('ignores an abort for a generation that already finished', async () => {
    const slot = new GenerationSlot();
    await slot.acquire('gen-1', 1_000);
    slot.release();
    slot.abort('gen-1');
    expect(slot.current).toBeNull();
    expect((await slot.acquire('gen-2', 1_000)).ok).toBe(true);
    // A late abort for gen-1 must not touch gen-2.
    slot.abort('gen-1');
    expect(slot.current?.aborted).toBe(false);
  });
});
