// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Performance-gate comparison — the pure decision layer.
 *
 * Two independent guards per metric, both derived from the committed baseline
 * (`baseline.ts`), never from a bare absolute assertion:
 *
 *   1. RELATIVE BAND. For a lower-is-better metric the worst tolerated value is
 *      `max(baseline * (1 + tolerancePct/100), baseline + noiseFloor)`. The
 *      noise-floor term is what keeps a 40ms metric from failing on a 30ms
 *      scheduler hiccup; the percentage term is what keeps a 40s metric from
 *      being allowed to drift by minutes. Exceeding the band is a REGRESSION.
 *
 *   2. HARD LIMIT. An absolute ceiling (lower-is-better) or floor
 *      (higher-is-better) that fails on its own, however wide the band is. This
 *      is the "the product is broken" line, and it is the guard that survives a
 *      sloppy baseline update.
 *
 * `higher-is-better` metrics (decode rate) are the exact mirror of the above.
 * Beating the band is reported as an IMPROVEMENT — never a failure — with a
 * nudge to re-record the baseline.
 *
 * No IO, no Playwright: everything here is unit-tested.
 */

import type { MetricBaseline, ProfileBaseline } from "./baseline";

export type MetricStatus = "pass" | "improved" | "regression" | "hard-limit";

export type MetricVerdict = {
  key: string;
  unit: string;
  direction: MetricBaseline["direction"];
  /** Every sample from this session, in run order. */
  samples: number[];
  /** Median of `samples` — the value the guards are applied to. */
  measured: number;
  baseline: number;
  /** Worst value the relative band tolerates. */
  band: number;
  hardLimit: number;
  /** Signed change vs baseline, in percent (positive = the number went up). */
  deltaPct: number;
  status: MetricStatus;
  detail: string;
};

export type RunReport = {
  profileKey: string;
  ok: boolean;
  verdicts: MetricVerdict[];
  /** Human-readable reasons the gate failed; empty when `ok`. */
  failures: string[];
};

export class EmptySampleSetError extends Error {
  constructor(key: string) {
    super(`no samples recorded for metric "${key}"`);
    this.name = "EmptySampleSetError";
  }
}

/** Median of a non-empty list. Even counts average the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The worst value the relative band tolerates, in the metric's own direction. */
export function regressionBand(baseline: MetricBaseline): number {
  const relative = baseline.value * (1 + baseline.tolerancePct / 100);
  const absolute = baseline.value + baseline.noiseFloor;
  if (baseline.direction === "lower-is-better") {
    return Math.max(relative, absolute);
  }
  return Math.min(
    baseline.value * (1 - baseline.tolerancePct / 100),
    baseline.value - baseline.noiseFloor,
  );
}

/** The value beyond which a result is good enough to be worth re-baselining. */
function improvementBand(baseline: MetricBaseline): number {
  if (baseline.direction === "lower-is-better") {
    return Math.min(
      baseline.value * (1 - baseline.tolerancePct / 100),
      baseline.value - baseline.noiseFloor,
    );
  }
  return Math.max(
    baseline.value * (1 + baseline.tolerancePct / 100),
    baseline.value + baseline.noiseFloor,
  );
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function compareMetric(
  key: string,
  samples: readonly number[],
  baseline: MetricBaseline,
): MetricVerdict {
  if (samples.length === 0) throw new EmptySampleSetError(key);

  const measured = median(samples);
  const band = regressionBand(baseline);
  const deltaPct =
    baseline.value === 0 ? 0 : ((measured - baseline.value) / baseline.value) * 100;
  const lower = baseline.direction === "lower-is-better";

  const breachesHardLimit = lower
    ? measured > baseline.hardLimit
    : measured < baseline.hardLimit;
  const outsideBand = lower ? measured > band : measured < band;
  const beatsBand = lower
    ? measured < improvementBand(baseline)
    : measured > improvementBand(baseline);

  const shape = `${round(measured)}${baseline.unit} (baseline ${round(baseline.value)}${baseline.unit}, ${deltaPct >= 0 ? "+" : ""}${round(deltaPct)}%)`;

  let status: MetricStatus;
  let detail: string;
  if (breachesHardLimit) {
    status = "hard-limit";
    detail = `${shape} — past the absolute ${lower ? "ceiling" : "floor"} of ${round(baseline.hardLimit)}${baseline.unit}`;
  } else if (outsideBand) {
    status = "regression";
    detail = `${shape} — outside the ±${baseline.tolerancePct}% band (worst tolerated ${round(band)}${baseline.unit})`;
  } else if (beatsBand) {
    status = "improved";
    detail = `${shape} — better than the band; re-record the baseline to lock the win in`;
  } else {
    status = "pass";
    detail = `${shape} — within the ±${baseline.tolerancePct}% band`;
  }

  return {
    key,
    unit: baseline.unit,
    direction: baseline.direction,
    samples: [...samples],
    measured,
    baseline: baseline.value,
    band,
    hardLimit: baseline.hardLimit,
    deltaPct,
    status,
    detail,
  };
}

/**
 * Compare a whole run against a profile baseline.
 *
 * A metric present in the baseline but missing from the run is a failure — a
 * silently-dropped measurement must not read as a pass. A metric measured but
 * absent from the baseline is reported and ignored (it needs a deliberate
 * baseline update to become enforceable).
 */
export function evaluateRun(
  profileKey: string,
  samplesByMetric: Readonly<Record<string, readonly number[]>>,
  profile: ProfileBaseline,
): RunReport {
  const verdicts: MetricVerdict[] = [];
  const failures: string[] = [];

  for (const [key, baseline] of Object.entries(profile.metrics)) {
    const samples = samplesByMetric[key];
    if (samples === undefined || samples.length === 0) {
      failures.push(`${key}: baseline exists but the run recorded no samples`);
      continue;
    }
    const verdict = compareMetric(key, samples, baseline);
    verdicts.push(verdict);
    if (verdict.status === "regression" || verdict.status === "hard-limit") {
      failures.push(`${key}: ${verdict.detail}`);
    }
  }

  for (const key of Object.keys(samplesByMetric)) {
    if (!(key in profile.metrics)) {
      failures.push(
        `${key}: measured but not in the baseline — run with ECO_PERF_UPDATE_BASELINE=1 to record it`,
      );
    }
  }

  return { profileKey, ok: failures.length === 0, verdicts, failures };
}

const STATUS_MARK: Record<MetricStatus, string> = {
  pass: "PASS",
  improved: "GAIN",
  regression: "SLOW",
  "hard-limit": "FAIL",
};

/** Render a run report as a fixed-width block for the Playwright reporter. */
export function formatReport(report: RunReport): string {
  const lines: string[] = [`perf gate — profile "${report.profileKey}"`];
  for (const verdict of report.verdicts) {
    lines.push(`  [${STATUS_MARK[verdict.status]}] ${verdict.key}: ${verdict.detail}`);
    lines.push(`         samples: ${verdict.samples.map(round).join(", ")}`);
  }
  if (report.failures.length > 0) {
    lines.push("  failures:");
    for (const failure of report.failures) lines.push(`    - ${failure}`);
  }
  return lines.join("\n");
}
