// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Heavy-work lease — domain-split behavior (instant-start slice 2a).
 *
 * The lease used to be one global slot: any heavy kind excluded every other.
 * That made "background model download while chatting" impossible, which
 * slice 2b's consent-driven upgrade requires. The split:
 *
 *   - runtime domain (GPU/RAM): benchmark, readiness, generation, warmup,
 *     switch-model, unload — mutually exclusive with each other.
 *   - download domain (network/storage): download — mutually exclusive with
 *     other downloads only.
 *
 * A download must coexist with any runtime kind, in both acquisition orders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireLocalHeavyWork,
  clearActiveLocalHeavyWorkLease,
  getActiveLocalHeavyWorkLease,
  describeLocalHeavyWorkBusy,
  leaseLockName,
} from '../local-heavy-work-owner';

const RUNTIME_KEY = 'eco-local-heavy-work-owner-v1';
const DOWNLOAD_KEY = 'eco-local-download-owner-v1';

function releaseAll(): void {
  localStorage.removeItem(RUNTIME_KEY);
  localStorage.removeItem(DOWNLOAD_KEY);
}

afterEach(() => {
  releaseAll();
});

describe('runtime domain exclusion (existing behavior preserved)', () => {
  it('a second runtime kind is refused while one is held', () => {
    const readiness = acquireLocalHeavyWork('readiness');
    expect(readiness.ok).toBe(true);

    const generation = acquireLocalHeavyWork('generation');
    expect(generation.ok).toBe(false);
    if (!generation.ok) {
      expect(generation.active?.kind).toBe('readiness');
    }

    if (readiness.ok) readiness.release();
    const retry = acquireLocalHeavyWork('generation');
    expect(retry.ok).toBe(true);
    if (retry.ok) retry.release();
  });

  it('switch-model excludes generation and vice versa', () => {
    const switching = acquireLocalHeavyWork('switch-model');
    expect(switching.ok).toBe(true);
    expect(acquireLocalHeavyWork('generation').ok).toBe(false);
    if (switching.ok) switching.release();

    const generating = acquireLocalHeavyWork('generation');
    expect(generating.ok).toBe(true);
    expect(acquireLocalHeavyWork('switch-model').ok).toBe(false);
    if (generating.ok) generating.release();
  });
});

describe('download domain independence', () => {
  it('download coexists with an active generation', () => {
    const generation = acquireLocalHeavyWork('generation');
    expect(generation.ok).toBe(true);

    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);

    if (download.ok) download.release();
    if (generation.ok) generation.release();
  });

  it('generation coexists with an active download (reverse order)', () => {
    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);

    const generation = acquireLocalHeavyWork('generation');
    expect(generation.ok).toBe(true);

    if (generation.ok) generation.release();
    if (download.ok) download.release();
  });

  it('a second download is refused while one is held', () => {
    const first = acquireLocalHeavyWork('download');
    expect(first.ok).toBe(true);

    const second = acquireLocalHeavyWork('download');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.active?.kind).toBe('download');
    }

    if (first.ok) first.release();
    const retry = acquireLocalHeavyWork('download');
    expect(retry.ok).toBe(true);
    if (retry.ok) retry.release();
  });

  it('releasing a download does not disturb an active runtime lease', () => {
    const switching = acquireLocalHeavyWork('switch-model');
    const download = acquireLocalHeavyWork('download');
    expect(switching.ok).toBe(true);
    expect(download.ok).toBe(true);

    if (download.ok) download.release();

    // The runtime lease must still be held.
    expect(acquireLocalHeavyWork('generation').ok).toBe(false);
    if (switching.ok) switching.release();
  });

  it('download leases live under their own storage key', () => {
    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);
    expect(localStorage.getItem(DOWNLOAD_KEY)).not.toBeNull();
    expect(localStorage.getItem(RUNTIME_KEY)).toBeNull();
    if (download.ok) download.release();
    expect(localStorage.getItem(DOWNLOAD_KEY)).toBeNull();
  });
});

describe('getActiveLocalHeavyWorkLease after the split', () => {
  it('returns the runtime lease (not a concurrent download)', () => {
    const download = acquireLocalHeavyWork('download');
    const generation = acquireLocalHeavyWork('generation');
    expect(download.ok && generation.ok).toBe(true);

    const active = getActiveLocalHeavyWorkLease();
    expect(active?.kind).toBe('generation');

    if (generation.ok) generation.release();
    if (download.ok) download.release();
  });

  it('sweeps expired leases in both domains', () => {
    const past = Date.now() - 1_000;
    localStorage.setItem(
      RUNTIME_KEY,
      JSON.stringify({ ownerId: 'generation:x', kind: 'generation', startedAt: past - 1, expiresAt: past }),
    );
    localStorage.setItem(
      DOWNLOAD_KEY,
      JSON.stringify({ ownerId: 'download:x', kind: 'download', startedAt: past - 1, expiresAt: past }),
    );

    expect(getActiveLocalHeavyWorkLease()).toBeNull();
    expect(localStorage.getItem(RUNTIME_KEY)).toBeNull();
    expect(localStorage.getItem(DOWNLOAD_KEY)).toBeNull();
  });

  it('leaves a still-live lease untouched (a live other tab must survive the boot sweep)', () => {
    const future = Date.now() + 60_000;
    localStorage.setItem(
      DOWNLOAD_KEY,
      JSON.stringify({ ownerId: 'download:other-tab', kind: 'download', startedAt: Date.now(), expiresAt: future }),
    );
    // The boot sweep is a read; a live lease must not be cleared.
    getActiveLocalHeavyWorkLease();
    expect(localStorage.getItem(DOWNLOAD_KEY)).not.toBeNull();
  });
});

describe('clearActiveLocalHeavyWorkLease', () => {
  it('clears a download lease by identity', () => {
    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);
    if (download.ok) {
      clearActiveLocalHeavyWorkLease(download.lease);
    }
    expect(localStorage.getItem(DOWNLOAD_KEY)).toBeNull();
  });
});

describe('describeLocalHeavyWorkBusy', () => {
  it('keeps honest per-kind copy', () => {
    expect(describeLocalHeavyWorkBusy({
      ownerId: 'download:x', kind: 'download', startedAt: 0, expiresAt: 1,
    })).toMatch(/download/i);
    expect(describeLocalHeavyWorkBusy({
      ownerId: 'switch-model:x', kind: 'switch-model', startedAt: 0, expiresAt: 1,
    })).toMatch(/preparing a local model/i);
  });
});

describe('a lease does not outlive its page', () => {
  it('pagehide releases the held lease so the next page load is not told "already active"', () => {
    const generation = acquireLocalHeavyWork('generation');
    expect(generation.ok).toBe(true);
    expect(localStorage.getItem(RUNTIME_KEY)).not.toBeNull();

    // A reload/navigation: the heartbeat dies with the page, but the row would
    // otherwise sit in localStorage for the rest of its TTL.
    window.dispatchEvent(new Event('pagehide'));

    expect(localStorage.getItem(RUNTIME_KEY)).toBeNull();
    expect(getActiveLocalHeavyWorkLease()).toBeNull();
    expect(acquireLocalHeavyWork('generation').ok).toBe(true);
  });

  it('pagehide leaves a lease held by another owner alone', () => {
    const first = acquireLocalHeavyWork('generation');
    expect(first.ok).toBe(true);
    // While this context still believes it holds the lease, another tab's
    // row has replaced it (ours expired and was swept). Not ours to clear.
    localStorage.setItem(RUNTIME_KEY, JSON.stringify({
      ownerId: 'generation:other-tab',
      kind: 'generation',
      startedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));

    window.dispatchEvent(new Event('pagehide'));

    expect(getActiveLocalHeavyWorkLease()?.ownerId).toBe('generation:other-tab');
  });
});

describe('a download lease holds a Web Lock for as long as it lives', () => {
  /** Web Locks stand-in: grants on demand, reports what is held. */
  class FakeLocks {
    held = new Set<string>();
    autoGrant = true;
    private pending: (() => void)[] = [];

    request(name: string, callback: () => Promise<void>): Promise<void> {
      return new Promise<void>((resolve) => {
        const grant = (): void => {
          this.held.add(name);
          void callback().then(() => {
            this.held.delete(name);
            resolve();
          });
        };
        if (this.autoGrant) grant();
        else this.pending.push(grant);
      });
    }

    query(): Promise<{ held: { name: string }[] }> {
      return Promise.resolve({ held: [...this.held].map((name) => ({ name })) });
    }

    grantPending(): void {
      const grants = this.pending;
      this.pending = [];
      for (const grant of grants) grant();
    }
  }

  let locks: FakeLocks;

  beforeEach(() => {
    locks = new FakeLocks();
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('holds the lock named after its owner, and release() frees it', async () => {
    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);
    if (!download.ok) return;
    expect(locks.held.has(leaseLockName(download.lease.ownerId))).toBe(true);

    download.release();
    await Promise.resolve();
    expect(locks.held.size).toBe(0);
  });

  it('pagehide frees the lock along with the row', async () => {
    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);

    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();

    expect(localStorage.getItem(DOWNLOAD_KEY)).toBeNull();
    expect(locks.held.size).toBe(0);
    if (download.ok) download.release();
  });

  it('a runtime lease takes no lock', () => {
    const generation = acquireLocalHeavyWork('generation');
    expect(generation.ok).toBe(true);
    expect(locks.held.size).toBe(0);
    if (generation.ok) generation.release();
  });

  it('a release before the lock is granted does not leave the lock held', async () => {
    locks.autoGrant = false;
    const download = acquireLocalHeavyWork('download');
    expect(download.ok).toBe(true);
    if (download.ok) download.release();

    locks.grantPending();
    await Promise.resolve();

    expect(locks.held.size).toBe(0);
  });
});
