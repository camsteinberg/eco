// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest';
import { runSetupCascade, SETUP_EXHAUSTED_REASON, SETUP_NETWORK_WAITS_MAX, type AttemptResult } from '../setup-cascade';
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
      expect(res.reasonCode).toBe('insufficient-storage');
    }
  });

  it('quotes the SMALLEST storage requirement it tried, not the last one', async () => {
    // Seen on a real first run: the ladder tried 0.8 GB → 0.3 GB → 1.4 GB and
    // told a person with 0.3 GB free that Eco "needs about 1.4 GB".
    const need = (gb: string) =>
      `Eco needs about ${gb} GB of free space for this model, but only about 0.3 GB is available on this device.`;
    const bytes: Record<string, number> = { a: 800_000_000, b: 300_000_000, c: 1_400_000_000 };
    const h = harness({
      runAttempt: async (m) => ({
        ok: false,
        phase: 'download',
        reason: need((bytes[m.id]! / 1e9).toFixed(1)),
        reasonCode: 'insufficient-storage',
        requiredBytes: bytes[m.id],
      }),
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reason).toBe(need('0.3'));
      expect(res.reasonCode).toBe('insufficient-storage');
    }
  });

  it('waits for the network to return and retries the SAME model, spending nothing', async () => {
    // Measured on a real first run: a 45 s Wi-Fi drop at 88% ran the whole
    // ladder in seconds and rebound the chosen slot to a smaller model.
    let aAttempts = 0;
    const waitForNetwork = vi.fn(async () => true);
    const h = harness({
      waitForNetwork,
      runAttempt: async (m) => {
        if (m.id === 'a' && aAttempts++ === 0) {
          return { ok: false, phase: 'download', reason: 'Failed to fetch', reasonCode: 'network-or-host' };
        }
        return { ok: true };
      },
    });
    const res = await runSetupCascade(h.opts);
    expect(res).toEqual({ kind: 'ready', model: h.A });
    expect(waitForNetwork).toHaveBeenCalledTimes(1);
    expect(aAttempts).toBe(2);
    expect(h.nextInCascade).not.toHaveBeenCalled();
    // The re-attempt is a retry of the same pick at the same ladder position.
    expect(h.onSelect).toHaveBeenLastCalledWith(h.A, { attemptIndex: 0, kind: 'retry' });
  });

  it('still grants the normal transient retry after an offline wait', async () => {
    let aAttempts = 0;
    let waited = false;
    const h = harness({
      waitForNetwork: async () => { if (waited) return false; waited = true; return true; },
      runAttempt: async (m) => {
        if (m.id === 'a') { aAttempts++; return { ok: false, phase: 'download', reason: 'Failed to fetch', reasonCode: 'network-or-host' }; }
        return { ok: true };
      },
    });
    const res = await runSetupCascade(h.opts);
    // offline wait → retry (free) → genuine failure → the one transient retry → demote
    expect(aAttempts).toBe(3);
    expect(res).toEqual({ kind: 'ready', model: h.B });
  });

  it('does not wait when the device was online (a real host failure demotes as before)', async () => {
    const waitForNetwork = vi.fn(async () => false);
    let aAttempts = 0;
    const h = harness({
      waitForNetwork,
      runAttempt: async (m) => {
        if (m.id === 'a') { aAttempts++; return { ok: false, phase: 'download', reason: 'HTTP 500', reasonCode: 'network-or-host' }; }
        return { ok: true };
      },
    });
    const res = await runSetupCascade(h.opts);
    expect(aAttempts).toBe(2); // first try + the one transient retry
    expect(res).toEqual({ kind: 'ready', model: h.B });
  });

  it('gives up waiting on a flapping link after SETUP_NETWORK_WAITS_MAX', async () => {
    const waitForNetwork = vi.fn(async () => true);
    const h = harness({
      waitForNetwork,
      runAttempt: async () => ({ ok: false, phase: 'download', reason: 'Failed to fetch', reasonCode: 'network-or-host' }),
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    expect(waitForNetwork).toHaveBeenCalledTimes(SETUP_NETWORK_WAITS_MAX);
  });

  it('carries a network/host code out of exhaustion, since the reason text is replaced', async () => {
    const h = harness({
      runAttempt: async () => ({
        ok: false, phase: 'download', reason: 'HTTP 500 fetching weights', reasonCode: 'network-or-host',
      }),
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      // The internal text is deliberately not shown...
      expect(res.reason).toBe(SETUP_EXHAUSTED_REASON);
      // ...so the code is the only thing left that knows a host, not this
      // device, is what failed.
      expect(res.reasonCode).toBe('network-or-host');
    }
  });

  it('leaves the code undefined when the last failure had no identifiable cause', async () => {
    const h = harness({
      runAttempt: async () => ({
        ok: false, phase: 'download', reason: "Couldn't write the model file to the browser cache.",
      }),
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reasonCode).toBeUndefined();
    }
  });

  it('reports the LAST failure code, not the first', async () => {
    const h = harness({
      runAttempt: async (m) => m.id === 'c'
        ? { ok: false, phase: 'download', reason: 'HTTP 503', reasonCode: 'network-or-host' }
        : { ok: false, phase: 'download', reason: 'no space', reasonCode: 'insufficient-storage' },
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reason).toBe(SETUP_EXHAUSTED_REASON);
      expect(res.reasonCode).toBe('network-or-host');
    }
  });

  // ── busy-other-tab: environment-level stop ─────────────────────────────

  it('stops the ladder immediately on busy-other-tab without recording or demoting (T1)', async () => {
    const h = harness({
      runAttempt: async () => ({
        ok: false, phase: 'load-or-smoke', reason: 'GPU held by another tab', reasonCode: 'busy-other-tab',
      }),
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reasonCode).toBe('busy-other-tab');
    }
    // No ledger row — the failure is environmental, not model×device.
    expect(h.recordFailure).not.toHaveBeenCalled();
    // No demotion — every model would hit the same gate.
    expect(h.nextInCascade).not.toHaveBeenCalled();
    // Only the initial selection, no demote selection.
    expect(h.onSelect).toHaveBeenCalledTimes(1);
    expect(h.onSelect).toHaveBeenCalledWith(h.A, { attemptIndex: 0, kind: 'initial' });
  });

  it('stops on busy-other-tab after a genuine demote, recording only the earlier failure (T2)', async () => {
    const h = harness({
      runAttempt: async (m) => m.id === 'a'
        ? { ok: false, phase: 'load-or-smoke', reason: 'OOM' }
        : { ok: false, phase: 'load-or-smoke', reason: 'GPU held by another tab', reasonCode: 'busy-other-tab' },
    });
    const res = await runSetupCascade(h.opts);
    expect(res.kind).toBe('exhausted');
    if (res.kind === 'exhausted') {
      expect(res.reasonCode).toBe('busy-other-tab');
    }
    // The genuine failure (A) was recorded; the environment failure (B) was not.
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.recordFailure).toHaveBeenCalledWith(h.A);
    // One demotion happened (A→B), then the ladder stopped.
    expect(h.nextInCascade).toHaveBeenCalledTimes(1);
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
