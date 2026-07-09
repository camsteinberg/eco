// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { runSetupCascade, SETUP_EXHAUSTED_REASON, type AttemptResult } from '../setup-cascade';
import type { ModelConfig, DeviceProfile } from '../../types';

const PROFILE = { browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto' } as DeviceProfile;
const model = (id: string) => ({ id } as ModelConfig);

function harness(over: Partial<Parameters<typeof runSetupCascade>[0]> = {}) {
  const A = model('a'); const B = model('b'); const C = model('c');
  const recordFailure = vi.fn();
  const recordSuccess = vi.fn();
  const onSelect = vi.fn();
  const cascade = [B, C];
  const nextInCascade = vi.fn((_f: ModelConfig, _s, _p, _i, o: { excludeIds: string[] }) =>
    cascade.find((m) => !o.excludeIds.includes(m.id)) ?? null);
  return {
    A, B, C, recordFailure, recordSuccess, onSelect, nextInCascade,
    opts: {
      slot: 'eco-fast' as const,
      profile: PROFILE,
      recommend: () => A,
      nextInCascade,
      runAttempt: async (_m: ModelConfig): Promise<AttemptResult> => ({ ok: true }),
      recordFailure, recordSuccess, onSelect,
      ...over,
    },
  };
}

describe('runSetupCascade', () => {
  it('returns ready and records success when the first pick passes', async () => {
    const h = harness();
    const res = await runSetupCascade(h.opts);
    expect(res).toEqual({ kind: 'ready', model: h.A });
    expect(h.recordSuccess).toHaveBeenCalledWith(h.A);
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it('demotes immediately on load/smoke failure, recording the failure', async () => {
    const h = harness({
      runAttempt: async (m) => m.id === 'a'
        ? { ok: false, phase: 'load-or-smoke', reason: 'OOM' }
        : { ok: true },
    });
    const res = await runSetupCascade(h.opts);
    expect(res).toEqual({ kind: 'ready', model: h.B });
    expect(h.recordFailure).toHaveBeenCalledWith(h.A);
    expect(h.recordSuccess).toHaveBeenCalledWith(h.B);
  });

  it('retries the SAME model once on download failure before demoting, without recording', async () => {
    let aAttempts = 0;
    const h = harness({
      runAttempt: async (m) => {
        if (m.id === 'a') { aAttempts++; return { ok: false, phase: 'download', reason: 'net' }; }
        return { ok: true };
      },
    });
    const res = await runSetupCascade(h.opts);
    expect(aAttempts).toBe(2);                 // initial + one retry
    expect(res).toEqual({ kind: 'ready', model: h.B });
    expect(h.recordFailure).not.toHaveBeenCalled(); // download failures don't poison the ledger
  });

  it('exhausts honestly when every candidate fails', async () => {
    const h = harness({ runAttempt: async () => ({ ok: false, phase: 'load-or-smoke', reason: 'x' }) });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reason).toBe(SETUP_EXHAUSTED_REASON);
      expect(res.triedModelIds).toEqual(['a', 'b', 'c']);
    }
  });

  it('accumulates excludeIds so a model is never re-offered within a run', async () => {
    const h = harness({ runAttempt: async () => ({ ok: false, phase: 'load-or-smoke', reason: 'x' }) });
    await runSetupCascade(h.opts);
    const lastCall = h.nextInCascade.mock.calls.at(-1)!;
    expect(lastCall[4].excludeIds).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('marks demote selections so the UI can show "finding fit"', async () => {
    const h = harness({
      runAttempt: async (m) => m.id === 'a' ? { ok: false, phase: 'load-or-smoke', reason: 'x' } : { ok: true },
    });
    await runSetupCascade(h.opts);
    expect(h.onSelect).toHaveBeenCalledWith(h.A, { attemptIndex: 0, kind: 'initial' });
    expect(h.onSelect).toHaveBeenCalledWith(h.B, { attemptIndex: 1, kind: 'demote' });
  });

  it('does NOT retry a storage shortage — demotes straight to a model that might fit', async () => {
    let aAttempts = 0;
    const h = harness({
      runAttempt: async (m) => {
        if (m.id === 'a') {
          aAttempts++;
          return { ok: false, phase: 'download', reason: 'no space', reasonCode: 'insufficient-storage' };
        }
        return { ok: true };
      },
    });
    const res = await runSetupCascade(h.opts);
    expect(aAttempts).toBe(1); // storage is deterministic — no transient retry
    expect(res).toEqual({ kind: 'ready', model: h.B });
  });

  it('surfaces the honest storage reason at exhaustion when nothing fit', async () => {
    const storageReason =
      'Eco needs about 2.0 GB of free space for this model, but only about 0.3 GB is available on this device.';
    const h = harness({
      runAttempt: async () => ({
        ok: false, phase: 'download', reason: storageReason, reasonCode: 'insufficient-storage',
      }),
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reason).toBe(storageReason); // not the generic SETUP_EXHAUSTED_REASON
    }
  });

  it('still shows the generic reason when the last blocker was not storage', async () => {
    const h = harness({
      runAttempt: async (m) => m.id === 'c'
        ? { ok: false, phase: 'load-or-smoke', reason: 'smoke timed out' }
        : { ok: false, phase: 'download', reason: 'no space', reasonCode: 'insufficient-storage' },
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reason).toBe(SETUP_EXHAUSTED_REASON);
    }
  });
});
