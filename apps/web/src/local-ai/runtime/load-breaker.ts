// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Load breaker — notice that a model's load killed the tab, and stop loading it
 * again on its own.
 *
 * A tab the OS kills (iOS jetsam, Safari's memory kill, Android's low-memory
 * killer, Chrome's "Aw, Snap") runs no JavaScript, so every crash record that
 * lives in a catch/finally (cooldowns, fault strikes, smoke diagnostics) is
 * never written. Without this, the next landing loaded the same model again
 * with no click: a crash loop, which iOS Safari ends with "A problem repeatedly
 * occurred". Same idea as Firefox's startup marker / Safe Mode.
 *
 *   1. Before a load, `loadModel` takes a Web Lock named after the load and, the
 *      moment it is held, writes a mark: "this tab is loading model X". The mark
 *      stays until the first token of the first generation after that load
 *      (memory can still peak on that first run), or until the load rejects.
 *   2. `pagehide` clears this tab's marks. It fires on close, reload and
 *      navigation, and never on an OS kill, so a person leaving mid-load is not
 *      read as a crash.
 *   3. A later landing (or any later load) settles the marks. A mark whose lock
 *      is no longer held belonged to a tab that died mid-load: the browser
 *      releases a document's locks when it goes away, crash included. That
 *      becomes a kill against the model and the mark is removed.
 *   4. A model with an unanswered kill is refused by `loadModel`. Setup asks the
 *      person (Try again, a lighter model, or the previous model after a killed
 *      switch); two kills in a row step down on their own. A real token after a
 *      load clears the record.
 *
 * Nothing here leaves the device. Both keys live in localStorage:
 *
 *   `eco-local-ai-load-mark-v1` — `Record<loadId, LoadMark>`: loads in flight
 *     (or left behind by a tab that died). One entry per load, not per tab: an
 *     orphaned forced-timeout load can still be running beside a new one.
 *   `eco-local-ai-load-kills-v1` — `Record<modelId, LoadKillRecord>`: kills not
 *     yet cleared by a pass. `reason` records what the breaker saw.
 *
 * Both are read-modify-write without a cross-tab lock. GPU ownership already
 * allows one loading tab at a time, so the only race is a landing settling the
 * mark map while another tab writes its own mark — that can lose one mark
 * (fail open: one kill unseen), never invent one.
 */

// ─── Storage shapes ────────────────────────────────────────────────────────

export const LOAD_MARK_STORAGE_KEY = 'eco-local-ai-load-mark-v1';
export const LOAD_KILLS_STORAGE_KEY = 'eco-local-ai-load-kills-v1';

export type LoadMark = {
  tabId: string;
  loadId: string;
  modelId: string;
  startedAt: number;
  /** The model a killed switch replaced — offered back on the next landing. */
  rollbackModelId?: string;
};

/**
 * Why a mark was read as dead:
 *   - 'no-lock'           — Web Locks available and the load's lock is gone.
 *   - 'locks-unavailable' — no Web Locks in this browser, so any other tab's
 *                           mark is taken as dead (gpu-ownership makes the
 *                           same single-tab assumption there).
 */
export type LoadKillReason = 'no-lock' | 'locks-unavailable';

/**
 *   - 'ask'       — unanswered; `loadModel` refuses the model.
 *   - 'retry'     — the person chose Try again: load it once more.
 *   - 'step-down' — the person chose a lighter model.
 *   - 'roll-back' — the person chose the model a killed switch replaced.
 */
export type LoadKillDecision = 'ask' | 'retry' | 'step-down' | 'roll-back';

export type LoadKillRecord = {
  modelId: string;
  /** Kills in a row: raised by each dead mark, reset only by a pass. */
  kills: number;
  /** The mark that last counted — so two landings never count one kill twice. */
  lastLoadId: string;
  lastKilledAt: number;
  reason: LoadKillReason;
  decision: LoadKillDecision;
  rollbackModelId?: string;
};

// ─── DI seams ──────────────────────────────────────────────────────────────

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** The slice of the Web Locks API the breaker uses. */
export type LockManagerLike = {
  request(name: string, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: readonly { name?: string }[] }>;
};

export type LoadBreakerOptions = {
  storage?: KeyValueStorage | null;
  now?: () => number;
  tabId?: string;
  /** `null` = no Web Locks. Omitted = `navigator.locks` when present. */
  locks?: LockManagerLike | null;
};

type ResolvedOptions = {
  storage: KeyValueStorage | null;
  now: () => number;
  tabId: string;
  locks: LockManagerLike | null;
};

function createId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function defaultStorage(): KeyValueStorage | null {
  const g = globalThis as { localStorage?: KeyValueStorage };
  return g.localStorage ?? null;
}

function defaultLocks(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null;
  // Typed as always present, but absent in older engines and in jsdom.
  const locks = (navigator as unknown as { locks?: LockManagerLike }).locks;
  return locks ?? null;
}

/** Each page load is its own tab: a reload gets a new id, like a new tab. */
const PAGE_TAB_ID = createId();

let configured: LoadBreakerOptions | null = null;

function opts(): ResolvedOptions {
  return {
    storage: configured?.storage !== undefined ? configured.storage : defaultStorage(),
    now: configured?.now ?? (() => Date.now()),
    tabId: configured?.tabId ?? PAGE_TAB_ID,
    locks: configured?.locks !== undefined ? configured.locks : defaultLocks(),
  };
}

/** Replace storage / clock / tab id / locks. Test-only seam. */
export function configureLoadBreaker(options?: LoadBreakerOptions): void {
  configured = options ?? null;
}

// ─── Pure liveness decision ────────────────────────────────────────────────

export function loadMarkLockName(loadId: string): string {
  return `eco-load-mark:${loadId}`;
}

/**
 * Which marks belonged to a tab that died mid-load. Pure: `heldLockNames` is a
 * Web Locks snapshot, or `null` when the browser has no Web Locks. This tab's
 * own marks are never dead. Time plays no part: a dead tab's mark has no
 * expiry, and a live tab's load may legitimately run for minutes.
 */
export function findDeadLoadMarks(
  marks: readonly LoadMark[],
  selfTabId: string,
  heldLockNames: ReadonlySet<string> | null,
): { mark: LoadMark; reason: LoadKillReason }[] {
  const dead: { mark: LoadMark; reason: LoadKillReason }[] = [];
  for (const mark of marks) {
    if (mark.tabId === selfTabId) continue;
    if (heldLockNames === null) {
      dead.push({ mark, reason: 'locks-unavailable' });
    } else if (!heldLockNames.has(loadMarkLockName(mark.loadId))) {
      dead.push({ mark, reason: 'no-lock' });
    }
  }
  return dead;
}

// ─── Marks ─────────────────────────────────────────────────────────────────

export type LoadMarkHandle = {
  loadId: string;
  modelId: string;
  /** Remove the mark and release its lock. Idempotent. */
  clear(): void;
};

/** This tab's loads in flight — kept so a back-forward-cache restore can re-mark them. */
const ownMarks = new Map<string, LoadMark>();
let pageListenersInstalled = false;

function onPageHide(): void {
  for (const loadId of ownMarks.keys()) removeMark(loadId);
}

function onPageShow(event: Event): void {
  if (!(event as PageTransitionEvent).persisted) return;
  for (const mark of ownMarks.values()) writeMark(mark);
}

function installPageListeners(): void {
  if (pageListenersInstalled || typeof window === 'undefined') return;
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  pageListenersInstalled = true;
}

/**
 * Mark a load of `modelId` as in flight. Resolves once the mark is written,
 * which happens synchronously the moment its lock is held — so no other tab can
 * see the mark without the lock behind it. If the lock request fails, no mark
 * is written (fail open: this one load goes unguarded rather than risk reading
 * a live tab as dead).
 */
export async function beginLoadMark(
  modelId: string,
  options: { rollbackModelId?: string } = {},
): Promise<LoadMarkHandle> {
  const { tabId, now, locks } = opts();
  installPageListeners();
  const loadId = createId();
  const mark: LoadMark = {
    tabId,
    loadId,
    modelId,
    startedAt: now(),
    ...(options.rollbackModelId ? { rollbackModelId: options.rollbackModelId } : {}),
  };
  const write = (): void => {
    ownMarks.set(loadId, mark);
    writeMark(mark);
  };

  let releaseLock: () => void = () => {};
  if (locks) {
    await new Promise<void>((settled) => {
      locks
        .request(loadMarkLockName(loadId), () => {
          write();
          settled();
          return new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
        })
        .catch(() => {
          settled();
        });
    });
  } else {
    write();
  }

  let cleared = false;
  return {
    loadId,
    modelId,
    clear: () => {
      if (cleared) return;
      cleared = true;
      ownMarks.delete(loadId);
      removeMark(loadId);
      releaseLock();
    },
  };
}

/**
 * Turn every mark left by a dead tab into a kill, and remove it. Called by
 * `loadModel` before each cold load and by setup before it decides anything.
 * A Web Locks query that fails decides nothing this time.
 */
export async function settleLoadMarks(): Promise<void> {
  const { tabId, locks } = opts();
  const marks = Object.values(readMarks());
  if (marks.length === 0) return;

  let held: Set<string> | null = null;
  if (locks) {
    try {
      const snapshot = await locks.query();
      held = new Set(
        (snapshot.held ?? []).flatMap((lock) => (typeof lock.name === 'string' ? [lock.name] : [])),
      );
    } catch {
      return;
    }
  }

  for (const { mark, reason } of findDeadLoadMarks(marks, tabId, held)) {
    removeMark(mark.loadId);
    recordKill(mark, reason);
  }
}

// ─── Kill records ──────────────────────────────────────────────────────────

function recordKill(mark: LoadMark, reason: LoadKillReason): void {
  const records = readKills();
  const previous = records[mark.modelId];
  if (previous?.lastLoadId === mark.loadId) return;
  records[mark.modelId] = {
    modelId: mark.modelId,
    kills: (previous?.kills ?? 0) + 1,
    lastLoadId: mark.loadId,
    lastKilledAt: opts().now(),
    reason,
    decision: 'ask',
    ...(mark.rollbackModelId ? { rollbackModelId: mark.rollbackModelId } : {}),
  };
  saveJson(LOAD_KILLS_STORAGE_KEY, records);
}

export function getLoadKills(): LoadKillRecord[] {
  return Object.values(readKills());
}

/** True while `modelId` has a kill the person has not answered. */
export function isLoadRefused(modelId: string): boolean {
  return readKills()[modelId]?.decision === 'ask';
}

/**
 * Record the person's answer to the setup screen's question. Applies to every
 * record, answered or not: the screen asks about the kill setup found, and an
 * answer that no longer had a target (a catalog change) must be re-answerable.
 * A second bound kill (both slots at once) takes the same answer.
 */
export function answerLoadKills(decision: Exclude<LoadKillDecision, 'ask'>): void {
  const records = readKills();
  for (const record of Object.values(records)) record.decision = decision;
  saveJson(LOAD_KILLS_STORAGE_KEY, records);
}

/** A real token after a load: the model runs here, so its kills are cleared. */
export function recordLoadPass(modelId: string): void {
  forgetLoadKill(modelId);
}

/** Drop a record that no longer steers anything (unbound, or already acted on). */
export function forgetLoadKill(modelId: string): void {
  const records = readKills();
  if (!(modelId in records)) return;
  delete records[modelId];
  saveJson(LOAD_KILLS_STORAGE_KEY, records);
}

// ─── Storage helpers ───────────────────────────────────────────────────────

function readMarks(): Record<string, LoadMark> {
  return loadJson<LoadMark>(LOAD_MARK_STORAGE_KEY);
}

function writeMark(mark: LoadMark): void {
  const marks = readMarks();
  marks[mark.loadId] = mark;
  saveJson(LOAD_MARK_STORAGE_KEY, marks);
}

function removeMark(loadId: string): void {
  const marks = readMarks();
  if (!(loadId in marks)) return;
  delete marks[loadId];
  saveJson(LOAD_MARK_STORAGE_KEY, marks);
}

function readKills(): Record<string, LoadKillRecord> {
  return loadJson<LoadKillRecord>(LOAD_KILLS_STORAGE_KEY);
}

function loadJson<T>(key: string): Record<string, T> {
  const storage = opts().storage;
  if (!storage) return {};
  try {
    const raw = storage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, T>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveJson<T>(key: string, records: Record<string, T>): void {
  const storage = opts().storage;
  if (!storage) return;
  try {
    if (Object.keys(records).length === 0) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(records));
  } catch {
    // A failed write degrades the breaker to "no record", never to a throw on
    // the load path.
  }
}

// ─── Test seam ─────────────────────────────────────────────────────────────

export function _resetLoadBreakerForTesting(): void {
  configured = null;
  ownMarks.clear();
  if (pageListenersInstalled && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }
  pageListenersInstalled = false;
}
