// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Seed evidence — pre-baked benchmark proof shipped with the app.
 *
 * Returns a slim profile-scoped view of the data in
 * `data/v1-launch-manual-evidence.json`:
 *
 *   - One record per (modelId, browserClass, deviceClass).
 *   - First-token / throughput / smoke-pass-rate are the only metrics
 *     downstream consumers actually need; the rich routing-evidence blob
 *     stays in the JSON.
 *   - Profile match uses device-class classification (≤4 GB → low,
 *     ≥16 GB → high-memory, else capable-laptop, with a WASM-only escape
 *     hatch and an unknown fallback).
 *
 * Freshness gate: 45-day TTL per evidence row. Rows use their own `generatedAt`
 * when present, otherwise their observed runtime timestamp, with the snapshot
 * timestamp only as a legacy fallback. Stale rows are treated as advisory/missing
 * — the recommender falls back to predicted-fit or proven-elsewhere admission
 * rather than hard-denying otherwise eligible shipping models.
 */

import type { DeviceProfile } from '../types';
import seedSnapshot from './data/v1-launch-manual-evidence.json';

export const SEED_EVIDENCE_TTL_DAYS = 45;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const HIGH_MEMORY_GB = 16;
const LOW_MEMORY_GB = 4;

export type SeedDeviceClass =
  | 'high-memory-laptop'
  | 'capable-laptop'
  | 'low-memory-laptop'
  | 'wasm-fallback-laptop'
  | 'unknown';

/**
 * 'benchmark' — measurement from a real run on real hardware (the original
 *   shipped path).
 * 'calculated' — confidence inferred from model size + runtime knowledge for
 *   a (browser × device class) we haven't physically tested. Used to give
 *   users a coherent set of options even on profiles we haven't yet seeded
 *   with empirical proof. Defaults to 'benchmark' when absent for back-compat.
 */
export type SeedEvidenceSource = 'benchmark' | 'calculated';

export type SeedEvidence = {
  modelId: string;
  browserClass: string;
  deviceClass: SeedDeviceClass;
  firstTokenMs: number | null;
  tokensPerSec: number | null;
  smokePassRate: number;
  observedAt: string;
  generatedAt: string;
  source: SeedEvidenceSource;
};

type SeedSnapshotShape = {
  schemaVersion?: number;
  generatedAt?: string;
  routingEvidenceReconciliation?: ReadonlyArray<RawReconciliationRecord>;
};

export type RawReconciliationRecord = {
  modelId?: string;
  browserClass?: string;
  deviceClass?: string;
  readiness?: string;
  source?: string;
  generatedAt?: string;
  compatibilityState?: string;
  failureCode?: string;
  recentFailures?: number;
  routingEvidence?: {
    benchmark?: {
      firstTokenMs?: number;
      tokensPerSecond?: number;
      reliability?: number;
    };
    observedAt?: number;
    readiness?: string;
    failureCode?: string;
    recentFailures?: number;
    lifecycleProof?: Record<string, { status?: string } | undefined>;
  };
};

const SNAPSHOT = seedSnapshot as SeedSnapshotShape;

export function classifyDeviceClass(profile: DeviceProfile): SeedDeviceClass {
  if (profile.webgpuSupport === 'none') return 'unknown';
  if (profile.webgpuSupport === 'wasm-only') return 'wasm-fallback-laptop';
  if (profile.deviceMemoryGB <= 0) return 'unknown';
  if (profile.deviceMemoryGB <= LOW_MEMORY_GB) return 'low-memory-laptop';
  if (profile.deviceMemoryGB >= HIGH_MEMORY_GB) return 'high-memory-laptop';
  return 'capable-laptop';
}

export function isSnapshotFresh(
  maxAgeDays: number = SEED_EVIDENCE_TTL_DAYS,
  now: number = Date.now(),
): boolean {
  if (!SNAPSHOT.generatedAt) return false;
  const generatedAtMs = Date.parse(SNAPSHOT.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  if (generatedAtMs > now + CLOCK_SKEW_MS) return false;
  return now - generatedAtMs <= maxAgeDays * MS_PER_DAY;
}

export function isFresh(
  evidence: SeedEvidence,
  maxAgeDays: number = SEED_EVIDENCE_TTL_DAYS,
  now: number = Date.now(),
): boolean {
  const generatedAtMs = Date.parse(evidence.generatedAt);
  if (!Number.isFinite(generatedAtMs)) return false;
  if (generatedAtMs > now + CLOCK_SKEW_MS) return false;
  return now - generatedAtMs <= maxAgeDays * MS_PER_DAY;
}

export function loadSeedEvidence(profile: DeviceProfile): SeedEvidence[] {
  const records = SNAPSHOT.routingEvidenceReconciliation ?? [];
  const targetBrowser = profile.browserClass;
  const targetDeviceClass = classifyDeviceClass(profile);
  const generatedAt = SNAPSHOT.generatedAt ?? '';

  const out: SeedEvidence[] = [];
  for (const record of records) {
    if (!record.modelId) continue;
    if (record.browserClass !== targetBrowser) continue;
    if (record.deviceClass !== targetDeviceClass) continue;
    if (!isUsableSeedRecord(record)) continue;

    const bench = record.routingEvidence?.benchmark;
    const observedAtMs = record.routingEvidence?.observedAt;
    const source: SeedEvidenceSource = record.source === 'calculated' ? 'calculated' : 'benchmark';
    const recordGeneratedAt = validRecordGeneratedAt(record) ?? generatedAt;
    const observedAt = observedAtMsToIso(observedAtMs) ?? recordGeneratedAt;
    const candidate: SeedEvidence = {
      modelId: record.modelId,
      browserClass: record.browserClass ?? 'unknown',
      deviceClass: (record.deviceClass as SeedDeviceClass) ?? 'unknown',
      firstTokenMs:
        typeof bench?.firstTokenMs === 'number' && Number.isFinite(bench.firstTokenMs)
          ? bench.firstTokenMs
          : null,
      tokensPerSec:
        typeof bench?.tokensPerSecond === 'number' && Number.isFinite(bench.tokensPerSecond)
          ? bench.tokensPerSecond
          : null,
      smokePassRate:
        typeof bench?.reliability === 'number' && Number.isFinite(bench.reliability)
          ? Math.max(0, Math.min(1, bench.reliability))
          : 0,
      observedAt,
      generatedAt: recordGeneratedAt,
      source,
    };
    if (isFresh(candidate)) out.push(candidate);
  }
  return out;
}

export function loadSeedEvidenceForModel(
  modelId: string,
  profile: DeviceProfile,
): SeedEvidence | null {
  for (const entry of loadSeedEvidence(profile)) {
    if (entry.modelId === modelId) return entry;
  }
  return null;
}

export function isUsableSeedRecord(record: RawReconciliationRecord): boolean {
  if (record.readiness !== 'ready') return false;
  if (record.compatibilityState === 'fail') return false;
  if (typeof record.failureCode === 'string') return false;

  const evidence = record.routingEvidence;
  if (!evidence) return !hasRecentFailures(record.recentFailures);
  if (evidence.readiness === 'fail' || evidence.readiness === 'blocked') return false;

  const lifecycleProof = evidence.lifecycleProof ?? {};
  const lifecyclePhases = Object.values(lifecycleProof);
  if (lifecyclePhases.some((phase) => phase?.status === 'fail')) return false;

  const hasHistoricalFailureSignal =
    hasRecentFailures(record.recentFailures)
    || hasRecentFailures(evidence.recentFailures)
    || typeof evidence.failureCode === 'string';

  if (!hasHistoricalFailureSignal) return true;

  return (
    record.compatibilityState === 'pass'
    && evidence.readiness === 'ready'
    && lifecyclePhases.length > 0
    && lifecyclePhases.every((phase) => phase?.status === 'pass')
  );
}

function hasRecentFailures(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validRecordGeneratedAt(record: RawReconciliationRecord): string | null {
  if (typeof record.generatedAt === 'string' && Number.isFinite(Date.parse(record.generatedAt))) {
    return record.generatedAt;
  }
  return observedAtMsToIso(record.routingEvidence?.observedAt);
}

function observedAtMsToIso(value: number | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}
