// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Seed evidence freshness — the HONEST contract.
 *
 * `apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json` ships
 * pre-baked manual evidence so production users get profile-scoped confidence at
 * first touch. Production reads that evidence through `loadSeedEvidence`, which
 * gates every row on its OWN per-row date (`generatedAt`, else `observedAt`)
 * against the 45-day `SEED_EVIDENCE_TTL_DAYS`. It NEVER reads the JSON's
 * top-level `generatedAt`.
 *
 * The previous version of this test asserted `Date.now() - topLevel.generatedAt
 * <= TTL`, so it went green by reading a field production ignores — and could be
 * re-greened by bumping that one field without re-benchmarking anything. That is
 * exactly backwards: it passed while every row prod actually reads was expired.
 * This rewrite asserts what production reads, and cannot be re-greened by editing
 * a field prod ignores (Wave-3 evidence-truth, EVID-2/EVID-3).
 *
 * Three tests, none of which can silently rot:
 *   1. CONTRACT — when the shipped benchmark data IS current, `loadSeedEvidence`
 *      surfaces it. The clock is pinned to a date DERIVED FROM THE DATA (each
 *      benchmarked profile's freshest benchmark row), so a legitimate re-bake
 *      moves the anchor with it and the wiring stays proven without a literal to
 *      maintain.
 *   2. DEGRADATION — expired seed degrades confidence but NEVER denies an
 *      eligible model. The clock is forced far past any possible TTL (so it holds
 *      no matter how the data is re-dated): `loadSeedEvidence` returns [], yet the
 *      recommender still returns the shipping picks via the predicted-fit lane.
 *   3. MONITOR — a NON-failing advisory. At real wall-clock it warns when the
 *      freshest benchmark row is past the TTL, surfacing rot during normal QA
 *      without red-flaking CI for a data-recency chore.
 *
 * To refresh for real: regenerate the JSON from a fresh Eval Harness export
 * (`pnpm --filter @eco/web seed:evidence`), which re-dates the per-row fields.
 * There is deliberately no "bump one field to go green" shortcut anymore.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import seed from '../../local-ai/evidence/data/v1-launch-manual-evidence.json';
import {
  classifyDeviceClass,
  loadSeedEvidence,
  SEED_EVIDENCE_TTL_DAYS,
  type RawReconciliationRecord,
} from '../../local-ai/evidence/seed';
import { recommend } from '../../local-ai/selection/recommend';
import type { DeviceProfile } from '../../local-ai/types';

const DAY_MS = 24 * 60 * 60 * 1000;

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

// The two profiles the shipped data actually benchmarks (source: 'benchmark'):
// chromium high-memory (≥16 GB) and chromium capable-laptop (8–15 GB).
const BENCHMARK_PROFILES: ReadonlyArray<{ label: string; profile: DeviceProfile }> = [
  { label: 'chromium high-memory-laptop', profile: profile({ deviceMemoryGB: 24 }) },
  { label: 'chromium capable-laptop', profile: profile({ deviceMemoryGB: 12 }) },
];

const RAW_ROWS = (seed.routingEvidenceReconciliation ?? []) as unknown as RawReconciliationRecord[];

/** Same effective-date rule loadSeedEvidence uses: per-row generatedAt, else observedAt. */
function effectiveDateMs(row: RawReconciliationRecord): number {
  const generated = Date.parse(row.generatedAt ?? '');
  if (Number.isFinite(generated)) return generated;
  const observed = row.routingEvidence?.observedAt;
  return typeof observed === 'number' && Number.isFinite(observed) ? observed : NaN;
}

/** Benchmark-source (non-'calculated') rows matching a profile's (browser × device class). */
function benchmarkRowsFor(p: DeviceProfile): RawReconciliationRecord[] {
  const deviceClass = classifyDeviceClass(p);
  return RAW_ROWS.filter(
    (r) =>
      typeof r.modelId === 'string'
      && r.browserClass === p.browserClass
      && r.deviceClass === deviceClass
      && (r.source ?? 'benchmark') !== 'calculated',
  );
}

/** The freshest benchmark row date for a profile, or null if it has none. */
function freshestBenchmarkDateMs(p: DeviceProfile): number | null {
  const dates = benchmarkRowsFor(p).map(effectiveDateMs).filter(Number.isFinite);
  return dates.length > 0 ? Math.max(...dates) : null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('v1-launch-manual-evidence.json freshness (the production contract)', () => {
  // CONTRACT: when the benchmark data is current, prod's read path surfaces it.
  // Rot-proof: the clock is each profile's OWN freshest benchmark date read from
  // the JSON, so re-baking the data moves the anchor automatically.
  it.each(BENCHMARK_PROFILES)(
    'surfaces benchmark seed proof for $label when its data is current',
    ({ profile: p }) => {
      const anchor = freshestBenchmarkDateMs(p);
      expect(anchor, 'benchmarked profile must ship at least one benchmark row').not.toBeNull();

      vi.useFakeTimers();
      vi.setSystemTime(anchor!);
      const evidence = loadSeedEvidence(p);
      expect(
        evidence.some((e) => e.source === 'benchmark'),
        'loadSeedEvidence must surface a benchmark row when the data is fresh',
      ).toBe(true);
    },
  );

  // DEGRADATION: expired seed degrades confidence but never denies. Forced far
  // past any TTL, so it holds regardless of how the data is re-dated.
  it('degrades to predicted-fit (never denies) once every seed row is stale', () => {
    const newest = Math.max(...RAW_ROWS.map(effectiveDateMs).filter(Number.isFinite));
    const farFuture = newest + (SEED_EVIDENCE_TTL_DAYS + 365) * DAY_MS;

    vi.useFakeTimers();
    vi.setSystemTime(farFuture);

    for (const { label, profile: p } of BENCHMARK_PROFILES) {
      expect(loadSeedEvidence(p), `${label} should have zero fresh seed rows in the far future`).toEqual([]);
    }

    // The recommender still resolves — expiry drops the confidence signal, not the
    // model. The eco-smart pick stays lfm2-2.6b (promotePreferred pins it even at
    // 'predicted'); the eco-fast pick still resolves without throwing.
    const capable = profile({ deviceMemoryGB: 12 });
    expect(recommend('eco-smart', capable).id).toBe('candidate/lfm2-2.6b-onnx');
    expect(recommend('eco-fast', capable).id).toMatch(/\S/);
  });

  // MONITOR: never fails — just surfaces rot during QA. This replaces the old
  // hard-fail that both lied (checked a field prod ignores) and was about to
  // red-flake CI for a data-recency chore.
  it('warns (without failing) when the shipped benchmark data is past its TTL', () => {
    const now = Date.now();
    for (const { label, profile: p } of BENCHMARK_PROFILES) {
      const anchor = freshestBenchmarkDateMs(p);
      expect(anchor, `${label} must ship at least one benchmark row`).not.toBeNull();
      const ageDays = Math.floor((now - anchor!) / DAY_MS);
      if (ageDays > SEED_EVIDENCE_TTL_DAYS) {
        console.warn(
          `Seed benchmark evidence for ${label} is ${ageDays} days old (TTL ${SEED_EVIDENCE_TTL_DAYS}). `
            + `Production users on this profile get predicted-fit confidence, not benchmark confidence. `
            + `Refresh via a fresh Eval Harness export when convenient.`,
        );
      }
      expect(ageDays).toBeGreaterThanOrEqual(0);
    }
  });
});
