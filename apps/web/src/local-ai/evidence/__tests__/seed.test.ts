// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase E — evidence/seed.ts unit + behavioral tests.
 *
 * The shipped JSON snapshot keeps advisory seed evidence scoped to
 * shipping-catalog rows only. It includes Qwen3.5-2B and LFM2.5-1.2B
 * high-memory benchmark evidence (dated 2026-06-19) while continuing to exclude
 * eval-only Gemma LiteRT candidates from shipping seed/admission.
 *
 * Snapshot-level `generatedAt` was re-dated to 2026-07-03 (the TTL-gate
 * refresh). Per-row freshness is independent of that timestamp (rows carry
 * their own generatedAt / observedAt), so the benchmark rows above keep their
 * 2026-06-19 date and the pinned tests below stay anchored there.
 *
 * Tests below pin both the profile-classification and the freshness gate.
 * They use real Date.now() values inside the 45-day window when verifying
 * "fresh" behavior and a far-future fake `now` to verify staleness.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyDeviceClass,
  isFresh,
  isSnapshotFresh,
  isUsableSeedRecord,
  loadSeedEvidence,
  loadSeedEvidenceForModel,
  SEED_EVIDENCE_TTL_DAYS,
  type RawReconciliationRecord,
  type SeedEvidence,
} from '../seed';
import type { DeviceProfile } from '../../types';

// Tracks the JSON snapshot's top-level `generatedAt` (the TTL-gate anchor read
// by isSnapshotFresh). Bump this in lockstep whenever the snapshot is re-dated.
const SNAPSHOT_GENERATED_AT_MS = Date.parse('2026-07-03T00:00:00.000Z');
const NOW_INSIDE_WINDOW = SNAPSHOT_GENERATED_AT_MS + 3 * 24 * 60 * 60 * 1000;
const NOW_OUTSIDE_WINDOW = SNAPSHOT_GENERATED_AT_MS + 60 * 24 * 60 * 60 * 1000;

function profile(overrides: Partial<DeviceProfile>): DeviceProfile {
  return {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('classifyDeviceClass', () => {
  it('returns high-memory-laptop for ≥16 GB Chromium WebGPU', () => {
    expect(classifyDeviceClass(profile({ deviceMemoryGB: 16 }))).toBe('high-memory-laptop');
    expect(classifyDeviceClass(profile({ deviceMemoryGB: 24 }))).toBe('high-memory-laptop');
  });

  it('returns capable-laptop for 8 GB Chromium WebGPU', () => {
    expect(classifyDeviceClass(profile({ deviceMemoryGB: 8 }))).toBe('capable-laptop');
  });

  it('returns low-memory-laptop for ≤4 GB', () => {
    expect(classifyDeviceClass(profile({ deviceMemoryGB: 4 }))).toBe('low-memory-laptop');
    expect(classifyDeviceClass(profile({ deviceMemoryGB: 2 }))).toBe('low-memory-laptop');
  });

  it('returns wasm-fallback-laptop for wasm-only', () => {
    expect(classifyDeviceClass(profile({ webgpuSupport: 'wasm-only' }))).toBe(
      'wasm-fallback-laptop',
    );
  });

  it('returns unknown when webgpuSupport is none', () => {
    expect(classifyDeviceClass(profile({ webgpuSupport: 'none' }))).toBe('unknown');
  });
});

describe('isSnapshotFresh', () => {
  it('is true inside the 45-day window', () => {
    expect(isSnapshotFresh(SEED_EVIDENCE_TTL_DAYS, NOW_INSIDE_WINDOW)).toBe(true);
  });

  it('is false past the 45-day window', () => {
    expect(isSnapshotFresh(SEED_EVIDENCE_TTL_DAYS, NOW_OUTSIDE_WINDOW)).toBe(false);
  });

  it('is false when the snapshot is dated in the future (clock skew protection)', () => {
    const farPast = SNAPSHOT_GENERATED_AT_MS - 24 * 60 * 60 * 1000;
    expect(isSnapshotFresh(SEED_EVIDENCE_TTL_DAYS, farPast)).toBe(false);
  });
});

describe('isFresh', () => {
  const synthetic = (generatedAt: string): SeedEvidence => ({
    modelId: 'local/phi3-mini-4k-q4f16',
    browserClass: 'chromium',
    deviceClass: 'high-memory-laptop',
    firstTokenMs: 228,
    tokensPerSec: 12,
    smokePassRate: 1,
    observedAt: generatedAt,
    generatedAt,
    source: 'benchmark',
  });

  it('fresh inside the window', () => {
    expect(isFresh(synthetic('2026-06-19T00:00:00.000Z'), SEED_EVIDENCE_TTL_DAYS, NOW_INSIDE_WINDOW)).toBe(
      true,
    );
  });

  it('stale outside the window', () => {
    expect(
      isFresh(synthetic('2026-06-19T00:00:00.000Z'), SEED_EVIDENCE_TTL_DAYS, NOW_OUTSIDE_WINDOW),
    ).toBe(false);
  });
});

describe('isUsableSeedRecord', () => {
  const readyRecord = (overrides: Partial<RawReconciliationRecord> = {}): RawReconciliationRecord => ({
    modelId: 'candidate/qwen3.5-2b-onnx',
    browserClass: 'chromium',
    deviceClass: 'high-memory-laptop',
    readiness: 'ready',
    compatibilityState: 'pass',
    routingEvidence: {
      readiness: 'ready',
      lifecycleProof: {
        prepare: { status: 'pass' },
        smoke: { status: 'pass' },
      },
    },
    ...overrides,
  });

  it('rejects nested failure signals without explicit pass proof', () => {
    expect(
      isUsableSeedRecord(
        readyRecord({
          compatibilityState: undefined,
          routingEvidence: {
            readiness: 'ready',
            failureCode: 'smoke-readiness-failed',
            recentFailures: 1,
          },
        }),
      ),
    ).toBe(false);
  });

  it('allows historical failure counters only when current proof is explicitly passing', () => {
    expect(
      isUsableSeedRecord(
        readyRecord({
          routingEvidence: {
            readiness: 'ready',
            failureCode: 'quota-insufficient',
            recentFailures: 1,
            lifecycleProof: {
              prepare: { status: 'pass' },
              smoke: { status: 'pass' },
            },
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('loadSeedEvidence — profile-scoped query', () => {
  it('returns Qwen3.5, LFM2.5, and phi-3 on Chromium WebGPU 24 GB (high-memory-laptop)', () => {
    // The preserved phi3 + lfm2.5-350m rows (2026-05-13) must be inside their
    // 45-day TTL; pin to the snapshot date so this set is evaluated as fresh.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const evidence = loadSeedEvidence(profile({ deviceMemoryGB: 24 }));
    const ids = evidence.map((e) => e.modelId).sort();
    // After the 2026-06-19 refresh: Qwen3.5 + LFM2.5-1.2B (benchmark) join the prior high-memory rows.
    expect(ids).toEqual([
      'candidate/lfm2.5-1.2b-instruct-onnx',
      'candidate/lfm2.5-350m-onnx',
      'candidate/qwen3.5-2b-onnx',
      'local/phi3-mini-4k-q4f16',
    ]);
  });

  it('does not surface a reconciliation row that is blocked / compatibility-failed even with a benchmark', () => {
    // Mirrors the shape of the retired lab-blocked SmolLM2 row (readiness
    // blocked + compatibilityState fail + a failing lifecycle phase):
    // isUsableSeedRecord filters it out before it can be surfaced as proof,
    // regardless of any embedded benchmark numbers. Kept as a synthetic record
    // so the behavior coverage outlives the retired model's seed data.
    expect(
      isUsableSeedRecord({
        modelId: 'candidate/blocked-shaped-model',
        browserClass: 'chromium',
        deviceClass: 'high-memory-laptop',
        readiness: 'blocked',
        compatibilityState: 'fail',
        routingEvidence: {
          readiness: 'blocked',
          failureCode: 'smoke-readiness-failed',
          recentFailures: 3,
          benchmark: { firstTokenMs: 711, tokensPerSecond: 31.3, reliability: 0.83 },
          lifecycleProof: { prepare: { status: 'fail' } },
        },
      }),
    ).toBe(false);
  });

  it('returns qwen3 + lfm2.5 on Chromium WebGPU 8 GB (capable-laptop)', () => {
    // Capable-laptop preserved seed rows (2026-05-13) must be inside their
    // 45-day TTL; pin to the snapshot date so this set is evaluated as fresh.
    // (Bonsai's capable-laptop row was removed when Bonsai retired 2026-07-11.)
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const evidence = loadSeedEvidence(profile({ deviceMemoryGB: 8 }));
    expect(evidence.map((e) => e.modelId).sort()).toEqual([
      'candidate/lfm2.5-350m-onnx',
      'local/qwen3-0.6b',
    ]);
  });

  it('does not renew preserved rows from the newer snapshot timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T00:00:00.000Z'));

    const capable = loadSeedEvidence(profile({ deviceMemoryGB: 8 }));
    const highMemory = loadSeedEvidence(profile({ deviceMemoryGB: 24 }));

    expect(capable.map((e) => e.modelId)).toEqual([]);
    expect(highMemory.map((e) => e.modelId).sort()).toEqual([
      'candidate/lfm2.5-1.2b-instruct-onnx',
      'candidate/qwen3.5-2b-onnx',
    ]);
  });

  it('returns qwen3 + lfm2.5 on Chromium WebGPU 4 GB (low-memory-laptop, calculated)', () => {
    // The calculated backfill rows crossed their 45-day TTL on wall-clock
    // 2026-07-01; pin to the snapshot date like the sibling benchmark-row
    // tests. Refreshing the shipped seed data itself is tracked separately.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const evidence = loadSeedEvidence(profile({ deviceMemoryGB: 4 }));
    expect(evidence.map((e) => e.modelId).sort()).toEqual([
      'candidate/lfm2.5-350m-onnx',
      'local/qwen3-0.6b',
    ]);
    // Both are calculated (no real benchmark on 4 GB hardware yet).
    expect(evidence.every((e) => e.source === 'calculated')).toBe(true);
  });

  it('returns qwen3 + lfm2.5 on Safari WASM (calculated backfill)', () => {
    // Backfill rows must be inside their 45-day TTL; pin like the siblings.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const evidence = loadSeedEvidence(profile({ browserClass: 'safari', webgpuSupport: 'wasm-only' }));
    expect(evidence.map((e) => e.modelId).sort()).toEqual([
      'candidate/lfm2.5-350m-onnx',
      'local/qwen3-0.6b',
    ]);
    expect(evidence.every((e) => e.source === 'calculated')).toBe(true);
  });

  it('returns qwen3 + lfm2.5 on Firefox WASM (calculated backfill)', () => {
    // Backfill rows must be inside their 45-day TTL; pin like the siblings.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const evidence = loadSeedEvidence(profile({ browserClass: 'firefox', webgpuSupport: 'wasm-only' }));
    expect(evidence.map((e) => e.modelId).sort()).toEqual([
      'candidate/lfm2.5-350m-onnx',
      'local/qwen3-0.6b',
    ]);
    expect(evidence.every((e) => e.source === 'calculated')).toBe(true);
  });

  it('populates benchmark fields when present on the record', () => {
    // phi3's preserved seed row (2026-05-13) must be inside its 45-day TTL.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const phi3 = loadSeedEvidenceForModel(
      'local/phi3-mini-4k-q4f16',
      profile({ deviceMemoryGB: 24 }),
    );
    expect(phi3).not.toBeNull();
    expect(phi3!.firstTokenMs).toBeTypeOf('number');
    expect(phi3!.tokensPerSec).toBeTypeOf('number');
    expect(phi3!.smokePassRate).toBeGreaterThanOrEqual(0);
    expect(phi3!.smokePassRate).toBeLessThanOrEqual(1);
    expect(phi3!.generatedAt).toBe('2026-05-13T19:30:06.982Z');
  });
});
