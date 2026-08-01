// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Scorecard aggregation, diffing, and A/B comparison for eval runs.
 *
 * Pure logic — no browser/model/DOM. An `EvalRun` (produced by the harness
 * runner) is rolled up into per-model `ModelScorecard`s; two scorecards can be
 * diffed (before→after, e.g. baseline vs after-a-fix), and two models within a
 * single run can be compared head-to-head on the same device.
 *
 * Null-handling is deliberate and documented at each site, because Cam reads
 * these numbers to make a model decision — a misleading average is worse than
 * an absent one:
 *
 *   - A rubric dim is `null` when it does not apply to a prompt (e.g. there's
 *     no `formatAdherence` check for a free-form chat prompt). Such dims are
 *     EXCLUDED from every mean — never coerced to 0 — so an inapplicable check
 *     can't drag a score down.
 *   - `compositeScore` averages only the AUTOMATED dims (judge dims are
 *     subjective 1..5 and live separately in `judgeAverages`).
 */

import type {
  DimensionAverages,
  DimensionDelta,
  EvalResult,
  EvalRun,
  ModelScorecard,
  ModelScorecardDelta,
  RubricScores,
  Scorecard,
  ScorecardDiff,
} from './types';

/**
 * The 14 automated rubric dims (0..1). These — and only these — feed
 * `compositeScore`. `coherence` and `taskFit` are JUDGE dims (1..5) and are
 * intentionally excluded; they're surfaced via `judgeAverages` instead.
 * (Runs persisted before a dim existed — e.g. `answerDepth`, `noCjkLeak`,
 * `depthMatch`, `deliversFirst`, `preservesUserText`, `preservesFacts` — simply
 * lack the key; the `isFiniteNumber` guard drops it from their means.)
 *
 * `deliversFirst`, `preservesUserText` and `preservesFacts` are spec-gated
 * (`expectDeliverable` / `expectUserTextReuse` / `expectFactPreservation`), so
 * they are null for every probe set that predates them and existing composites
 * are unchanged by their arrival.
 */
export const AUTOMATED_DIMENSIONS: readonly (keyof RubricScores)[] = [
  'correctStop',
  'noRepetition',
  'noCannedLeakage',
  'noThinkLeakage',
  'noCjkLeak',
  'formatAdherence',
  'exactness',
  'instructionFollowing',
  'appropriateUncertainty',
  'answerDepth',
  'depthMatch',
  'deliversFirst',
  'preservesUserText',
  'preservesFacts',
] as const;

/** All rubric dims, automated + judge — the universe for `dimensionAverages`. */
const ALL_DIMENSIONS: readonly (keyof RubricScores)[] = [
  ...AUTOMATED_DIMENSIONS,
  'coherence',
  'taskFit',
] as const;

/** Median of a numeric list. `null` on empty (so callers can skip it). */
export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  // Even length: mean of the two middle elements.
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Mean of a numeric list. `null` on empty. */
function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

/** Population standard deviation. `null` until at least two samples exist. */
function stdDev(nums: number[]): number | null {
  if (nums.length < 2) return null;
  const avg = mean(nums);
  if (avg === null) return null;
  const variance = nums.reduce((sum, n) => sum + (n - avg) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

/**
 * A real, usable score value. Defense-in-depth alongside the storage guard: a
 * plain `v !== null` filter still lets `undefined` (a missing dim that survived
 * `JSON.parse`) through into a mean, producing a silent `NaN` — which on a
 * scorecard is worse than a crash. This excludes anything non-finite, so a bad
 * dim is dropped rather than poisoning the aggregate.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * The composite score of ONE result: the mean of its non-null automated dims.
 * Returns `null` when the result has zero applicable automated dims — the
 * caller then skips it from the model-level composite mean rather than treating
 * it as a 0.
 *
 * ★★ THE COMPOSITE CANNOT ADJUDICATE A LENGTH OR POSTURE CHANGE. READ THE DIMS.
 *
 * An unweighted mean is dominated by the guard dims, which sit at 1.0 on any
 * reply that is merely well-formed — `correctStop`, `noRepetition`,
 * `noCannedLeakage`, `noThinkLeakage`, `noCjkLeak`, `deliversFirst`. Measured on
 * an open, curiosity-shaped ask ("what is france like", richness floor 60):
 *
 *            words   answerDepth   composite
 *   thin       16       0.267        0.895
 *   developed  110      1.000        1.000
 *
 * A reply that fails the user by four to one on the only dim that can see the
 * failure shows up as a ten-point composite gap — which reads as noise, gets
 * called noise, and ships terseness. That is the exact outcome this instrument
 * was built to prevent.
 *
 * So: when adjudicating a system-prompt posture, a hint, or any length-affecting
 * change, read `answerDepth` and `depthMatch` DIRECTLY. The composite is for
 * "did this model get broadly worse", nothing finer.
 *
 * This was deliberately NOT fixed by reweighting the dims. Weights chosen to
 * make a number come out right are an unfounded counterweight: they would encode
 * a claim about relative importance that nothing here measures, and they would
 * fire on every future run. Naming the limit is honest; hiding it behind
 * invented constants is not. `rubric.test.ts` pins the dilution as a test so
 * this comment cannot quietly stop being true.
 */
function resultComposite(scores: RubricScores): number | null {
  const applicable: number[] = [];
  for (const dim of AUTOMATED_DIMENSIONS) {
    const v = scores[dim];
    if (isFiniteNumber(v)) applicable.push(v);
  }
  return mean(applicable);
}

/** Roll up one model's results into a `ModelScorecard`. */
function buildModelScorecard(modelId: string, results: EvalResult[]): ModelScorecard {
  // dimensionAverages: for each dim, average only the results where it's
  // non-null; if no result had it, the dim is null (never applicable here).
  const dimensionAverages: DimensionAverages = {};
  const dimensionStdDev: DimensionAverages = {};
  for (const dim of ALL_DIMENSIONS) {
    const values: number[] = [];
    for (const r of results) {
      const v = r.scores[dim];
      if (isFiniteNumber(v)) values.push(v);
    }
    dimensionAverages[dim] = mean(values); // mean([]) === null
    dimensionStdDev[dim] = stdDev(values);
  }

  // compositeScore: mean of the per-result composites, skipping results with no
  // applicable automated dims. If NO result has any applicable dim, default 0
  // (an empty/degenerate model can't claim a positive score).
  const perResult: number[] = [];
  for (const r of results) {
    const c = resultComposite(r.scores);
    if (c !== null) perResult.push(c);
  }
  const compositeScore = mean(perResult) ?? 0;
  const compositeStdDev = stdDev(perResult);

  // perf: medians over the results that actually reported a value (null skipped,
  // not zeroed — a missing TTFT isn't a fast TTFT). smokePassRate is the simple
  // fraction of results that produced >=1 token.
  const ttfts = results.map((r) => r.perf.ttftMs).filter(isFiniteNumber);
  const tps = results.map((r) => r.perf.tokensPerSec).filter(isFiniteNumber);
  const smokePasses = results.filter((r) => r.perf.smokePass).length;

  // judgeAverages: 1..5 means over finite values only; null until a judge fills them.
  const coherence = mean(results.map((r) => r.scores.coherence).filter(isFiniteNumber));
  const taskFit = mean(results.map((r) => r.scores.taskFit).filter(isFiniteNumber));

  return {
    modelId,
    // A model is generated by one runtime within a run; take the first result's.
    runtimeAdapter: results[0]?.runtimeAdapter ?? 'unknown',
    promptCount: results.length,
    dimensionAverages,
    dimensionStdDev,
    perf: {
      medianTtftMs: median(ttfts),
      medianTokensPerSec: median(tps),
      smokePassRate: results.length === 0 ? 0 : smokePasses / results.length,
    },
    compositeScore,
    compositeStdDev,
    judgeAverages: { coherence, taskFit },
  };
}

/** Group a run's results by modelId and roll each model up into a scorecard. */
export function buildScorecard(run: EvalRun): Scorecard {
  const byModel = new Map<string, EvalResult[]>();
  for (const r of run.results) {
    const bucket = byModel.get(r.modelId);
    if (bucket) bucket.push(r);
    else byModel.set(r.modelId, [r]);
  }

  const models: ModelScorecard[] = [];
  for (const [modelId, results] of byModel) {
    models.push(buildModelScorecard(modelId, results));
  }

  return {
    runId: run.runId,
    label: run.label,
    device: run.device,
    ...(run.config ? { config: run.config } : {}),
    models,
  };
}

/** after - before; `null` when either side is null (delta is undefined). */
function deltaOrNull(before: number | null | undefined, after: number | null | undefined): number | null {
  if (before === null || before === undefined) return null;
  if (after === null || after === undefined) return null;
  return after - before;
}

/** Per-dim delta map (after - before) across all rubric dims. */
function diffDimensions(
  before: DimensionAverages,
  after: DimensionAverages,
): DimensionDelta {
  const out: DimensionDelta = {};
  for (const dim of ALL_DIMENSIONS) {
    out[dim] = deltaOrNull(before[dim], after[dim]);
  }
  return out;
}

/** One model's before→after delta. */
function diffModel(before: ModelScorecard, after: ModelScorecard): ModelScorecardDelta {
  return {
    modelId: after.modelId,
    compositeDelta: after.compositeScore - before.compositeScore,
    dimensionDeltas: diffDimensions(before.dimensionAverages, after.dimensionAverages),
    perfDelta: {
      medianTtftMs: deltaOrNull(before.perf.medianTtftMs, after.perf.medianTtftMs),
      medianTokensPerSec: deltaOrNull(
        before.perf.medianTokensPerSec,
        after.perf.medianTokensPerSec,
      ),
      smokePassRate: after.perf.smokePassRate - before.perf.smokePassRate,
    },
  };
}

/**
 * Human-readable warnings for scorecard comparisons that are still technically
 * computable, but not decision-grade apples-to-apples evidence. This keeps the
 * table usable for exploratory reads while making the caveat impossible to miss.
 */
const DEVICE_FIELDS = [
  ['profileKey', 'Device profile'],
  ['browserClass', 'Browser class'],
  ['webgpuSupport', 'WebGPU support'],
  ['deviceClass', 'Device class'],
] as const;

type DeviceField = (typeof DEVICE_FIELDS)[number][0];

function deviceField(device: unknown, key: DeviceField): string | null {
  if (typeof device !== 'object' || device === null || Array.isArray(device)) return null;
  const value = (device as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function hasCompleteDeviceFingerprint(device: unknown): boolean {
  return DEVICE_FIELDS.every(([key]) => deviceField(device, key) !== null);
}

export function getScorecardConfigWarnings(before: Scorecard, after: Scorecard): string[] {
  const warnings: string[] = [];
  const beforeDevice = before.device as unknown;
  const afterDevice = after.device as unknown;

  if (!hasCompleteDeviceFingerprint(beforeDevice) || !hasCompleteDeviceFingerprint(afterDevice)) {
    warnings.push('One or both runs are missing or malformed device fingerprints; treat deltas as exploratory.');
  }

  for (const [key, label] of DEVICE_FIELDS) {
    const beforeValue = deviceField(beforeDevice, key);
    const afterValue = deviceField(afterDevice, key);
    if (beforeValue !== null && afterValue !== null && beforeValue !== afterValue) {
      warnings.push(`${label} changed (${beforeValue} → ${afterValue}).`);
    }
  }

  const beforeConfig = before.config;
  const afterConfig = after.config;
  if (!beforeConfig || !afterConfig) {
    warnings.push('One or both runs are missing config fingerprints; treat deltas as exploratory.');
    return warnings;
  }

  const checks: Array<[keyof typeof beforeConfig, string]> = [
    ['messageTopology', 'Message topology'],
    ['samplingMode', 'Sampling mode'],
    ['samplesPerProbe', 'Samples per probe'],
    ['maxTokensCap', 'Max token cap'],
    ['perGenerationTimeoutMs', 'Per-generation timeout'],
    ['includeResearchArms', 'Research-arm inclusion'],
    ['promptCount', 'Prompt count'],
    ['promptSetHash', 'Prompt set hash'],
    ['compositionEra', 'Composition era'],
    ['harnessVersion', 'Harness version'],
  ];

  for (const [key, label] of checks) {
    const beforeValue = beforeConfig[key];
    const afterValue = afterConfig[key];
    if (beforeValue !== afterValue) {
      warnings.push(`${label} changed (${String(beforeValue)} → ${String(afterValue)}).`);
    }
  }

  return warnings;
}

/**
 * Diff two scorecards (e.g. baseline vs after-a-fix). Models are matched by id;
 * only models present in BOTH appear in the diff — a model that exists on just
 * one side has no meaningful delta.
 */
export function diffScorecards(before: Scorecard, after: Scorecard): ScorecardDiff {
  const beforeById = new Map(before.models.map((m) => [m.modelId, m]));
  const models: ModelScorecardDelta[] = [];
  for (const afterModel of after.models) {
    const beforeModel = beforeById.get(afterModel.modelId);
    if (!beforeModel) continue; // only models in both sides
    models.push(diffModel(beforeModel, afterModel));
  }
  return {
    beforeLabel: before.label,
    afterLabel: after.label,
    configWarnings: getScorecardConfigWarnings(before, after),
    models,
  };
}

/**
 * Compare two models within ONE run (same device, same prompt set). Deltas are
 * b - a. Throws if either model id is absent from the run.
 */
export function compareModels(
  run: EvalRun,
  modelIdA: string,
  modelIdB: string,
): { a: ModelScorecard; b: ModelScorecard; dimensionDeltas: DimensionDelta; compositeDelta: number } {
  const card = buildScorecard(run);
  const a = card.models.find((m) => m.modelId === modelIdA);
  const b = card.models.find((m) => m.modelId === modelIdB);
  if (!a) throw new Error(`compareModels: model "${modelIdA}" not present in run "${run.runId}"`);
  if (!b) throw new Error(`compareModels: model "${modelIdB}" not present in run "${run.runId}"`);
  return {
    a,
    b,
    dimensionDeltas: diffDimensions(a.dimensionAverages, b.dimensionAverages),
    compositeDelta: b.compositeScore - a.compositeScore,
  };
}
