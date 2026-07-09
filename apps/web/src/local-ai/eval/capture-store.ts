// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * localStorage persistence for captured failures (the failure-capture loop).
 *
 * Mirrors `eval/storage.ts`: a versioned key holding a JSON array, FIFO-capped,
 * self-healing on malformed data, with pretty `exportCaptures()` and a merging
 * `importCaptures()`. Import/export matter because localStorage is per-origin:
 * failures flagged on econetwork.ai must travel as JSON to a localhost harness
 * session (and into the repo when they graduate to `felt-probes.ts`).
 *
 * Privacy: captures contain conversation excerpts and a generation-receipt
 * snapshot, persisted ONLY when the user explicitly flags a conversation via
 * the dev-gated affordance. This is a deliberate, documented carve-out from
 * the receipts never-persisted rule (lifecycle/generation-receipt.ts) — the
 * user creates the record, it stays in their browser's localStorage, and it
 * leaves the device only if they export the JSON themselves.
 */

import { safeStorage } from '../../lib/local-storage';
import { CAPTURE_SCHEMA_VERSION, FAILURE_TAGS } from './capture';
import type { CapturedFailure, FailureTag } from './capture';

const STORAGE_KEY = 'eco-local-ai-captures-v1';
/** FIFO cap. Captures are bounded (~2–25KB each); 50 keeps localStorage sane. */
export const MAX_CAPTURES = 50;

// ─── I/O ────────────────────────────────────────────────────────────────

/** Persist a capture. Pushes, trims to `MAX_CAPTURES` (FIFO), and writes. */
export function saveCapture(capture: CapturedFailure): void {
  if (typeof localStorage === 'undefined') return;
  const current = loadCaptures();
  current.push(capture);
  writeCaptures(current.slice(-MAX_CAPTURES));
}

/**
 * Load all persisted captures. Self-heals: a malformed/non-array payload
 * clears the key and returns []. Individual invalid entries are filtered out
 * so one bad capture can't poison the rest.
 */
export function loadCaptures(): CapturedFailure[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = safeStorage.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      safeStorage.remove(STORAGE_KEY);
      return [];
    }
    return parsed.filter(isValidCapture);
  } catch {
    safeStorage.remove(STORAGE_KEY);
    return [];
  }
}

/** Remove one capture by id. Returns whether it existed. */
export function removeCapture(captureId: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  const current = loadCaptures();
  const next = current.filter((c) => c.captureId !== captureId);
  if (next.length === current.length) return false;
  writeCaptures(next);
  return true;
}

/** Remove all persisted captures. */
export function clearCaptures(): void {
  if (typeof localStorage === 'undefined') return;
  safeStorage.remove(STORAGE_KEY);
}

// ─── Transfer ─────────────────────────────────────────────────────────────

/** Pretty-printed JSON dump of every capture (for cross-origin transfer / graduation PRs). */
export function exportCaptures(): string {
  return JSON.stringify(
    {
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      dumpedAt: new Date().toISOString(),
      captures: loadCaptures(),
    },
    null,
    2,
  );
}

/**
 * Merge captures from a JSON string — either an `exportCaptures()` envelope or
 * a bare array. Dedupes by `captureId` against what's already stored; invalid
 * entries count as skipped. Returns `null` when the payload isn't parseable as
 * either shape.
 */
export function importCaptures(json: string): { imported: number; skipped: number } | null {
  if (typeof localStorage === 'undefined') return null;

  let candidates: unknown[];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).captures)
    ) {
      candidates = (parsed as Record<string, unknown>).captures as unknown[];
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const current = loadCaptures();
  const knownIds = new Set(current.map((c) => c.captureId));
  let imported = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (!isValidCapture(candidate) || knownIds.has(candidate.captureId)) {
      skipped++;
      continue;
    }
    current.push(candidate);
    knownIds.add(candidate.captureId);
    imported++;
  }

  writeCaptures(current.slice(-MAX_CAPTURES));
  return { imported, skipped };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function writeCaptures(captures: CapturedFailure[]): void {
  if (typeof localStorage === 'undefined') return;
  // safeStorage drops the write on quota/serialization failure rather than throw.
  safeStorage.set(STORAGE_KEY, JSON.stringify(captures));
}

function isValidHistoryTurn(value: unknown): value is { role: 'user' | 'assistant'; content: string } {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string';
}

/**
 * Structural guard for a stored/imported entry. Unknown tags are dropped in
 * place (the entry survives — this runs only on freshly-parsed JSON, never on
 * a live object), mirroring how `storage.ts` filters bad results.
 */
function isValidCapture(value: unknown): value is CapturedFailure {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== CAPTURE_SCHEMA_VERSION) return false;
  if (typeof v.captureId !== 'string' || v.captureId.length === 0) return false;
  if (typeof v.capturedAt !== 'string') return false;
  if (typeof v.note !== 'string') return false;
  if (typeof v.prompt !== 'string' || v.prompt.length === 0) return false;
  if (typeof v.failingOutput !== 'string') return false;
  if (typeof v.historyTruncated !== 'boolean') return false;
  if (!Array.isArray(v.tags)) return false;
  if (!Array.isArray(v.history) || !v.history.every(isValidHistoryTurn)) return false;
  if (!Array.isArray(v.citations)) return false;
  v.tags = v.tags.filter(
    (tag): tag is FailureTag =>
      typeof tag === 'string' && (FAILURE_TAGS as readonly string[]).includes(tag),
  );
  return true;
}
