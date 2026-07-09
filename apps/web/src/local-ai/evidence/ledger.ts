// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runtime evidence ledger — what's actually been observed on this device.
 *
 * Append-only record of smoke + generation outcomes, keyed by
 * (modelId, profileKey). Consumed by the recommendation engine
 * (`selection/recommend.ts`) and lifecycle (`lifecycle/`).
 *
 * The ledger answers exactly one question: has this (model × profile)
 * succeeded recently on this device? v1.0 has no "default routing"
 * concept — local AI is the only path — so there are no manual-eligible
 * / default-eligible / review-status axes to track. Review status ships
 * via seed evidence; the ledger captures only what the user's device did.
 *
 * Storage:
 *
 *   - localStorage key `eco-local-ai-ledger-v1` holds a JSON array of
 *     entries. Self-heals on malformed data: a parse failure clears the
 *     key and starts fresh.
 *   - Capped at MAX_ENTRIES (most recent kept) to bound localStorage usage.
 *   - Tab-crash safety is implicit: localStorage writes are atomic per
 *     key, so a partial entry can't land.
 */

import type { DeviceProfile } from '../types';
import type { RuntimeBackend } from '../runtime/types';
import { classifyDeviceClass, type SeedDeviceClass } from './seed';
import { safeStorage } from '../../lib/local-storage';

const STORAGE_KEY = 'eco-local-ai-ledger-v1';
const MAX_ENTRIES = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_DAYS = 30;
/**
 * Download-failure window (slice 3). Deliberately shorter than the 30-day smoke
 * window: download failures are usually environmental (disk, network) and go
 * stale fast — a model that failed a fortnight ago deserves a fresh automatic
 * attempt.
 */
const DEFAULT_DOWNLOAD_FAIL_DAYS = 7;

/**
 * Coarse schema version stamped onto every new ledger entry.
 *
 * History:
 *   1 — Phase B.2: revision-mismatch fix + external-data flag.
 *       Pre-v1 entries recorded under the AbortSignal-era and missing-revision
 *       bugs hid working models. Invalidated all prior ledger data.
 *   2 — Slice 3 observability: profileKey gains an `|f16:<yes|no|unknown>`
 *       component and the outcome union gains download/load/swap failures.
 *       Unlike the v0→v1 bump, this bump does NOT discard old rows: a v1 row
 *       was recorded on THIS device and its success/failure history is exactly
 *       what makes the ledger useful. A one-time in-place migration
 *       (`migrateEntry`) stamps v1 rows with `|f16:unknown` + ledgerVersion 2;
 *       the matcher treats `f16:unknown` as compatible with any current device.
 */
export const CURRENT_LEDGER_VERSION = 2;

export type LedgerOutcome =
  | 'smoke-pass'
  | 'smoke-fail'
  | 'generate-pass'
  | 'generate-fail'
  | 'download-fail'
  | 'load-fail'
  | 'swap-pass'
  | 'swap-fail';

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set<LedgerOutcome>([
  'smoke-pass',
  'smoke-fail',
  'generate-pass',
  'generate-fail',
  'download-fail',
  'load-fail',
  'swap-pass',
  'swap-fail',
]);

/**
 * Failure taxonomy for `download-fail` rows — mirrors the download pipeline's
 * own error classes (`download/download.ts`). `aborted` is defined for
 * completeness but the origin writer never records it: a user-cancelled /
 * tab-closed download is resumable, not a failure, so it must not count toward
 * the recommender's download-fail demotion.
 */
export type LedgerErrorCode = 'insufficient-storage' | 'aborted' | 'failed' | 'integrity';

export type LedgerEntry = {
  modelId: string;
  profileKey: string;
  outcome: LedgerOutcome;
  firstTokenMs?: number;
  tokensPerSec?: number;
  /** Classified failure code (download-fail rows). */
  errorCode?: LedgerErrorCode;
  /** The execution provider the load actually resolved to (post-load rows). */
  backend?: RuntimeBackend;
  /** Wall-clock duration of the recorded operation, when measured. */
  durationMs?: number;
  recordedAt: string;
  /** Schema version. Old rows are migrated in place, never discarded. */
  ledgerVersion?: number;
};

export type LedgerRecordInput = Omit<LedgerEntry, 'recordedAt' | 'profileKey'> & {
  profile: DeviceProfile;
};

const F16_KEY_PREFIX = '|f16:';

function f16Component(profile: DeviceProfile): 'yes' | 'no' | 'unknown' {
  if (profile.webgpuShaderF16 === true) return 'yes';
  if (profile.webgpuShaderF16 === false) return 'no';
  // `undefined` = not probed (synchronous getDeviceProfile()); treat as unknown
  // so it matches any recorded row rather than fragmenting the key.
  return 'unknown';
}

export function profileKey(profile: DeviceProfile): string {
  const deviceClass: SeedDeviceClass = classifyDeviceClass(profile);
  return `${profile.browserClass}|${deviceClass}|${profile.webgpuSupport}${F16_KEY_PREFIX}${f16Component(profile)}`;
}

/** Split a profileKey into its device base and f16 component. */
function splitProfileKey(key: string): { base: string; f16: string } {
  const idx = key.indexOf(F16_KEY_PREFIX);
  if (idx === -1) return { base: key, f16: 'unknown' };
  return { base: key.slice(0, idx), f16: key.slice(idx + F16_KEY_PREFIX.length) };
}

/**
 * Two profileKeys match when their device base is identical and their f16
 * components are compatible. `unknown` (a migrated v1 row, or a device probed
 * synchronously) is compatible with anything — v1 rows were all recorded on
 * THIS device, so an unknown f16 must not strand them.
 */
function profileKeyMatches(stored: string, current: string): boolean {
  const s = splitProfileKey(stored);
  const c = splitProfileKey(current);
  if (s.base !== c.base) return false;
  if (s.f16 === 'unknown' || c.f16 === 'unknown') return true;
  return s.f16 === c.f16;
}

export function recordEvidence(input: LedgerRecordInput): void {
  if (typeof localStorage === 'undefined') return;
  const entry: LedgerEntry = {
    modelId: input.modelId,
    profileKey: profileKey(input.profile),
    outcome: input.outcome,
    firstTokenMs: input.firstTokenMs,
    tokensPerSec: input.tokensPerSec,
    errorCode: input.errorCode,
    backend: input.backend,
    durationMs: input.durationMs,
    recordedAt: new Date().toISOString(),
    ledgerVersion: CURRENT_LEDGER_VERSION,
  };
  const current = readAllEntries();
  current.push(entry);
  // Keep newest MAX_ENTRIES.
  const trimmed = current.slice(-MAX_ENTRIES);
  writeAllEntries(trimmed);
}

export function readEvidence(
  modelId: string,
  profile: DeviceProfile,
): LedgerEntry[] {
  const key = profileKey(profile);
  return readAllEntries().filter(
    (entry) => entry.modelId === modelId && profileKeyMatches(entry.profileKey, key),
  );
}

export function hasRecentSuccess(
  modelId: string,
  profile: DeviceProfile,
  maxAgeDays: number = DEFAULT_RECENT_DAYS,
  now: number = Date.now(),
): boolean {
  const cutoff = now - maxAgeDays * MS_PER_DAY;
  for (const entry of readEvidence(modelId, profile)) {
    if (entry.outcome !== 'smoke-pass' && entry.outcome !== 'generate-pass') continue;
    const recordedAtMs = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recordedAtMs)) continue;
    if (recordedAtMs >= cutoff) return true;
  }
  return false;
}

export function countRecentFailures(
  modelId: string,
  profile: DeviceProfile,
  maxAgeDays: number = DEFAULT_RECENT_DAYS,
  now: number = Date.now(),
): number {
  const cutoff = now - maxAgeDays * MS_PER_DAY;
  let n = 0;
  for (const entry of readEvidence(modelId, profile)) {
    if (entry.outcome !== 'smoke-fail' && entry.outcome !== 'generate-fail') continue;
    const recordedAtMs = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recordedAtMs)) continue;
    if (recordedAtMs >= cutoff) n++;
  }
  return n;
}

export function hasRecentFailure(
  modelId: string,
  profile: DeviceProfile,
  maxAgeDays: number = DEFAULT_RECENT_DAYS,
  now: number = Date.now(),
): boolean {
  const cutoff = now - maxAgeDays * MS_PER_DAY;
  for (const entry of readEvidence(modelId, profile)) {
    if (entry.outcome !== 'smoke-fail' && entry.outcome !== 'generate-fail') continue;
    const recordedAtMs = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recordedAtMs)) continue;
    if (recordedAtMs >= cutoff) return true;
  }
  return false;
}

/**
 * Count genuine `download-fail` rows for (model × profile) within the window.
 * `aborted` rows are excluded — a user-cancelled download is not evidence the
 * model can't be fetched. The recommender uses this to stop AUTO-offering a
 * model that has failed to download repeatedly (slice 3), without ever hiding
 * it from manual selection.
 */
export function countRecentDownloadFailures(
  modelId: string,
  profile: DeviceProfile,
  maxAgeDays: number = DEFAULT_DOWNLOAD_FAIL_DAYS,
  now: number = Date.now(),
): number {
  const cutoff = now - maxAgeDays * MS_PER_DAY;
  let n = 0;
  for (const entry of readEvidence(modelId, profile)) {
    if (entry.outcome !== 'download-fail') continue;
    if (entry.errorCode === 'aborted') continue;
    const recordedAtMs = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recordedAtMs)) continue;
    if (recordedAtMs >= cutoff) n++;
  }
  return n;
}

export function clearEvidence(modelId?: string): void {
  if (typeof localStorage === 'undefined') return;
  if (!modelId) {
    safeRemove();
    return;
  }
  const filtered = readAllEntries().filter((entry) => entry.modelId !== modelId);
  writeAllEntries(filtered);
}

export function readAllEntries(): LedgerEntry[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = safeStorage.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      safeRemove();
      return [];
    }
    const valid = parsed.filter(isValidEntry);
    const migrated = valid.map(migrateEntry);
    // One-time in-place migration: persist the v2-stamped rows once so the
    // rewrite happens on first load, not on every read. `migrateEntry` returns
    // the same reference when a row is already current, so this is idempotent —
    // a fully-migrated ledger never triggers a write.
    if (migrated.some((entry, i) => entry !== valid[i])) {
      writeAllEntries(migrated);
    }
    return migrated;
  } catch {
    safeRemove();
    return [];
  }
}

/**
 * Bring a v1 (or earlier) row up to the current schema in place: append the
 * `|f16:unknown` profileKey component and stamp ledgerVersion 2. Idempotent —
 * an already-current row is returned unchanged (same reference), so repeated
 * migration passes are no-ops.
 */
function migrateEntry(entry: LedgerEntry): LedgerEntry {
  const hasF16 = entry.profileKey.includes(F16_KEY_PREFIX);
  const isCurrent = hasF16 && (entry.ledgerVersion ?? 0) >= CURRENT_LEDGER_VERSION;
  if (isCurrent) return entry;
  return {
    ...entry,
    profileKey: hasF16 ? entry.profileKey : `${entry.profileKey}${F16_KEY_PREFIX}unknown`,
    ledgerVersion: CURRENT_LEDGER_VERSION,
  };
}

function writeAllEntries(entries: LedgerEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  // safeStorage drops the write on quota/serialization failure rather than throw.
  safeStorage.set(STORAGE_KEY, JSON.stringify(entries));
}

function safeRemove(): void {
  safeStorage.remove(STORAGE_KEY);
}

function isValidEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.modelId !== 'string') return false;
  if (typeof v.profileKey !== 'string') return false;
  if (typeof v.outcome !== 'string' || !KNOWN_OUTCOMES.has(v.outcome)) return false;
  if (typeof v.recordedAt !== 'string') return false;
  // NOTE: no version gate. A lower-version row is MIGRATED in place
  // (`migrateEntry`), not discarded — a v1 row was recorded on this same
  // device and its history is exactly what makes the ledger useful. Structural
  // validity is the only bar here; version reconciliation happens downstream.
  return true;
}
