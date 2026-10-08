// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Load breaker — the mark a load leaves behind, how a later landing reads it,
 * and the per-model kill record it turns into.
 *
 * Contract pinned here:
 *   - the liveness decision is a pure function of (marks, this tab, held lock
 *     names): a mark whose lock is gone belonged to a tab that died mid-load;
 *   - a mark is written only once its lock is held, and `clear()` drops both;
 *   - `pagehide` (close / reload / navigation) clears this tab's marks, so a
 *     person leaving mid-load is never read as a crash;
 *   - one dead mark counts once, even when two landings settle it;
 *   - kills accumulate until a pass clears them, and the record says what the
 *     breaker saw (`reason`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOAD_KILLS_STORAGE_KEY,
  LOAD_MARK_STORAGE_KEY,
  _resetLoadBreakerForTesting,
  answerLoadKills,
  beginLoadMark,
  configureLoadBreaker,
  findDeadLoadMarks,
  getLoadKills,
  isLoadRefused,
  loadMarkLockName,
  recordLoadPass,
  settleLoadMarks,
  type LoadKillRecord,
  type LoadMark,
  type LockManagerLike,
} from '../load-breaker';

class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

/** Web Locks stand-in: grants on demand, reports what is held. */
class FakeLocks implements LockManagerLike {
  held = new Set<string>();
  autoGrant = true;
  private pending: Array<() => void> = [];

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

  async query(): Promise<{ held: Array<{ name: string }> }> {
    return { held: [...this.held].map((name) => ({ name })) };
  }

  grantPending(): void {
    const grants = this.pending;
    this.pending = [];
    for (const grant of grants) grant();
  }
}

const mark = (over: Partial<LoadMark> = {}): LoadMark => ({
  tabId: 'other-tab',
  loadId: 'load-1',
  modelId: 'local/x',
  startedAt: 1_000,
  ...over,
});

function seedMarks(storage: FakeStorage, marks: LoadMark[]): void {
  storage.setItem(
    LOAD_MARK_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(marks.map((m) => [m.loadId, m]))),
  );
}

function readMarks(storage: FakeStorage): LoadMark[] {
  const raw = storage.getItem(LOAD_MARK_STORAGE_KEY);
  return raw ? Object.values(JSON.parse(raw) as Record<string, LoadMark>) : [];
}

function readKills(storage: FakeStorage): Record<string, LoadKillRecord> {
  const raw = storage.getItem(LOAD_KILLS_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, LoadKillRecord>) : {};
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

let storage: FakeStorage;
let locks: FakeLocks;

beforeEach(() => {
  storage = new FakeStorage();
  locks = new FakeLocks();
  configureLoadBreaker({ storage, locks, tabId: 'this-tab', now: () => 5_000 });
});

afterEach(() => {
  _resetLoadBreakerForTesting();
});

describe('findDeadLoadMarks (pure liveness decision)', () => {
  it('reads a mark whose lock is no longer held as a dead tab', () => {
    const dead = findDeadLoadMarks([mark()], 'this-tab', new Set());
    expect(dead).toEqual([{ mark: mark(), reason: 'no-lock' }]);
  });

  it('leaves a mark alone while its tab still holds the lock', () => {
    const held = new Set([loadMarkLockName('load-1')]);
    expect(findDeadLoadMarks([mark()], 'this-tab', held)).toEqual([]);
  });

  it('never reads this tab’s own mark as dead', () => {
    expect(findDeadLoadMarks([mark({ tabId: 'this-tab' })], 'this-tab', new Set())).toEqual([]);
  });

  it('without Web Locks, reads another tab’s mark as dead and says so', () => {
    expect(findDeadLoadMarks([mark()], 'this-tab', null)).toEqual([
      { mark: mark(), reason: 'locks-unavailable' },
    ]);
  });
});

describe('beginLoadMark', () => {
  it('writes the mark only once its lock is held, and clear() drops both', async () => {
    locks.autoGrant = false;
    const pending = beginLoadMark('local/x');
    await flush();
    expect(readMarks(storage)).toEqual([]);

    locks.grantPending();
    const handle = await pending;
    expect(readMarks(storage)).toEqual([
      expect.objectContaining({ tabId: 'this-tab', modelId: 'local/x', loadId: handle.loadId }),
    ]);
    expect(locks.held.has(loadMarkLockName(handle.loadId))).toBe(true);

    handle.clear();
    await flush();
    expect(readMarks(storage)).toEqual([]);
    expect(locks.held.size).toBe(0);
  });

  it('carries the rollback model into the mark', async () => {
    await beginLoadMark('local/x', { rollbackModelId: 'local/prev' });
    expect(readMarks(storage)[0]?.rollbackModelId).toBe('local/prev');
  });

  it('pagehide clears this tab’s marks (a close or reload is not a crash)', async () => {
    seedMarks(storage, [mark()]);
    await beginLoadMark('local/x');
    window.dispatchEvent(new Event('pagehide'));
    expect(readMarks(storage)).toEqual([mark()]);
  });

  it('a page restored from the back-forward cache writes its in-flight mark again', async () => {
    const handle = await beginLoadMark('local/x');
    window.dispatchEvent(new Event('pagehide'));
    expect(readMarks(storage)).toEqual([]);
    const pageshow = new Event('pageshow') as Event & { persisted: boolean };
    Object.defineProperty(pageshow, 'persisted', { value: true });
    window.dispatchEvent(pageshow);
    expect(readMarks(storage).map((m) => m.loadId)).toEqual([handle.loadId]);
  });
});

describe('settleLoadMarks', () => {
  it('turns a dead mark into a kill record that asks, and removes the mark', async () => {
    seedMarks(storage, [mark({ rollbackModelId: 'local/prev' })]);
    await settleLoadMarks();

    expect(readMarks(storage)).toEqual([]);
    expect(readKills(storage)['local/x']).toEqual({
      modelId: 'local/x',
      kills: 1,
      lastLoadId: 'load-1',
      lastKilledAt: 5_000,
      reason: 'no-lock',
      decision: 'ask',
      rollbackModelId: 'local/prev',
    });
    expect(isLoadRefused('local/x')).toBe(true);
    expect(isLoadRefused('local/other')).toBe(false);
  });

  it('leaves a live tab’s mark in place and records nothing', async () => {
    seedMarks(storage, [mark()]);
    locks.held.add(loadMarkLockName('load-1'));
    await settleLoadMarks();
    expect(readMarks(storage)).toEqual([mark()]);
    expect(readKills(storage)).toEqual({});
  });

  it('counts one dead mark once, even when two landings settle it', async () => {
    seedMarks(storage, [mark()]);
    await settleLoadMarks();
    // A second tab read the same mark before the first removed it.
    seedMarks(storage, [mark()]);
    await settleLoadMarks();
    expect(readKills(storage)['local/x']?.kills).toBe(1);
  });

  it('a second kill in a row raises the count and asks again', async () => {
    seedMarks(storage, [mark()]);
    await settleLoadMarks();
    answerLoadKills('retry');
    expect(isLoadRefused('local/x')).toBe(false);

    seedMarks(storage, [mark({ loadId: 'load-2' })]);
    await settleLoadMarks();
    expect(readKills(storage)['local/x']).toMatchObject({ kills: 2, decision: 'ask', lastLoadId: 'load-2' });
    expect(getLoadKills().map((k) => k.modelId)).toEqual(['local/x']);
  });

  it('a pass clears the record', async () => {
    seedMarks(storage, [mark()]);
    await settleLoadMarks();
    recordLoadPass('local/x');
    expect(readKills(storage)).toEqual({});
  });
});
