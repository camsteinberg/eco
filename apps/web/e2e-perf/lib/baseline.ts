// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Performance-gate baseline: schema, IO, and the update path.
 *
 * The gate never asserts a bare absolute millisecond number — machine and CI
 * variance would make that flaky within a week. It compares the median of N
 * samples against a COMMITTED baseline, per device profile, with two
 * independent guards per metric (see `compare.ts`):
 *
 *   - a relative band  (baseline ± tolerancePct, widened by a noise floor), and
 *   - a hard limit     (an absolute ceiling / floor that always fails).
 *
 * The `profiles` map is keyed so a second device class (a CI runner, a
 * BrowserStack phone) can be added later without touching the schema or the
 * comparison logic — each profile carries its own machine note, model id and
 * per-metric configuration.
 */

import { readFileSync, writeFileSync } from "node:fs";

export type MetricDirection = "lower-is-better" | "higher-is-better";

export type MetricBaseline = {
  /** The committed reference value (median of `samples` runs). */
  value: number;
  unit: string;
  direction: MetricDirection;
  /** Relative band half-width, in percent of `value`. */
  tolerancePct: number;
  /**
   * Absolute noise floor in `unit`. Widens the band so a small metric can't
   * fail on scheduler jitter.
   *
   * Size it to the metric's OBSERVED jitter, never larger than the baseline
   * itself: the floor wins whenever it exceeds `value × tolerancePct`, so an
   * oversized floor silently disables the percentage band. A 300ms floor on a
   * 177ms TTFT baseline lets a 2.7× regression through — measured, not
   * hypothetical.
   */
  noiseFloor: number;
  /**
   * The absolute guard that always fails, independent of the band. For
   * `lower-is-better` this is a ceiling; for `higher-is-better` it is a floor.
   * Set it where the user experience genuinely breaks, not near the baseline.
   */
  hardLimit: number;
};

export type ProfileBaseline = {
  /** Human-readable profile description. */
  label: string;
  /** Machine class the numbers were captured on — baselines are not portable. */
  machine: string;
  /** Catalog id of the model measured. A different model invalidates the numbers. */
  modelId: string;
  capturedAt: string;
  /** Number of samples the medians were taken over. */
  samples: number;
  metrics: Record<string, MetricBaseline>;
};

export type PerfBaselineFile = {
  schemaVersion: 1;
  profiles: Record<string, ProfileBaseline>;
};

export const BASELINE_SCHEMA_VERSION = 1;

/** The metrics the gate measures, in report order. */
export const METRIC_KEYS = [
  "warmReadinessMs",
  "ttftTurn1Ms",
  "ttftTurn2Ms",
  "decodeTokensPerSec",
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * Config used when a metric has no committed entry yet (bootstrapping a new
 * profile with the baseline-update mode). Only `value` comes from the run —
 * tolerance, noise floor and hard limits are deliberate product judgements and
 * are never derived from a measurement.
 *
 * Starting tolerance is 50% everywhere: wide enough that a warm laptop, a busy
 * laptop and a cold one all pass, narrow enough to catch a doubling. See
 * `../README.md` for the tightening path.
 */
export const DEFAULT_METRIC_CONFIG: Record<MetricKey, Omit<MetricBaseline, "value">> = {
  warmReadinessMs: {
    unit: "ms",
    direction: "lower-is-better",
    tolerancePct: 50,
    noiseFloor: 500,
    // A cached, already-proven model that takes half a minute to become usable
    // is a broken experience regardless of what the baseline says.
    hardLimit: 30_000,
  },
  ttftTurn1Ms: {
    unit: "ms",
    direction: "lower-is-better",
    tolerancePct: 50,
    // Sized to observed run-to-run jitter of the median (single-digit ms) with
    // headroom, NOT to the raw per-sample spread — see the `noiseFloor` doc.
    noiseFloor: 50,
    // Ten seconds of silence after pressing send reads as "nothing happened".
    hardLimit: 10_000,
  },
  ttftTurn2Ms: {
    unit: "ms",
    direction: "lower-is-better",
    tolerancePct: 50,
    noiseFloor: 50,
    hardLimit: 10_000,
  },
  decodeTokensPerSec: {
    unit: "tok/s",
    direction: "higher-is-better",
    tolerancePct: 50,
    noiseFloor: 2,
    // Below this, streaming reads as stalled rather than slow.
    hardLimit: 5,
  },
};

/**
 * Committed baselines are rounded to 2dp. A measurement carries meaningless
 * float tails (`1490.4900000095367`); keeping them only makes the diff of a
 * deliberate re-record harder to read.
 */
export function roundMeasurement(value: number): number {
  return Math.round(value * 100) / 100;
}

export class BaselineFormatError extends Error {
  constructor(message: string) {
    super(`perf baseline is malformed: ${message}`);
    this.name = "BaselineFormatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetric(key: string, raw: unknown): MetricBaseline {
  if (!isRecord(raw)) throw new BaselineFormatError(`metric "${key}" is not an object`);
  const numeric = (field: string): number => {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new BaselineFormatError(`metric "${key}" field "${field}" must be a finite number`);
    }
    return value;
  };
  const direction = raw.direction;
  if (direction !== "lower-is-better" && direction !== "higher-is-better") {
    throw new BaselineFormatError(`metric "${key}" has an unknown direction`);
  }
  if (typeof raw.unit !== "string" || raw.unit.length === 0) {
    throw new BaselineFormatError(`metric "${key}" is missing a unit`);
  }
  return {
    value: numeric("value"),
    unit: raw.unit,
    direction,
    tolerancePct: numeric("tolerancePct"),
    noiseFloor: numeric("noiseFloor"),
    hardLimit: numeric("hardLimit"),
  };
}

function parseProfile(key: string, raw: unknown): ProfileBaseline {
  if (!isRecord(raw)) throw new BaselineFormatError(`profile "${key}" is not an object`);
  const text = (field: string): string => {
    const value = raw[field];
    if (typeof value !== "string") {
      throw new BaselineFormatError(`profile "${key}" field "${field}" must be a string`);
    }
    return value;
  };
  if (!isRecord(raw.metrics)) {
    throw new BaselineFormatError(`profile "${key}" has no metrics object`);
  }
  const metrics: Record<string, MetricBaseline> = {};
  for (const [metricKey, metricRaw] of Object.entries(raw.metrics)) {
    metrics[metricKey] = parseMetric(`${key}.${metricKey}`, metricRaw);
  }
  return {
    label: text("label"),
    machine: text("machine"),
    modelId: text("modelId"),
    capturedAt: text("capturedAt"),
    samples: typeof raw.samples === "number" ? raw.samples : 0,
    metrics,
  };
}

export function parseBaselineFile(raw: string): PerfBaselineFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new BaselineFormatError(err instanceof Error ? err.message : "invalid JSON");
  }
  if (!isRecord(parsed)) throw new BaselineFormatError("root is not an object");
  if (parsed.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    throw new BaselineFormatError(
      `expected schemaVersion ${BASELINE_SCHEMA_VERSION}, got ${String(parsed.schemaVersion)}`,
    );
  }
  if (!isRecord(parsed.profiles)) throw new BaselineFormatError("profiles is not an object");

  const profiles: Record<string, ProfileBaseline> = {};
  for (const [profileKey, profileRaw] of Object.entries(parsed.profiles)) {
    profiles[profileKey] = parseProfile(profileKey, profileRaw);
  }
  return { schemaVersion: BASELINE_SCHEMA_VERSION, profiles };
}

export function serializeBaselineFile(file: PerfBaselineFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function readBaselineFile(path: string): PerfBaselineFile {
  return parseBaselineFile(readFileSync(path, "utf8"));
}

export function writeBaselineFile(path: string, file: PerfBaselineFile): void {
  writeFileSync(path, serializeBaselineFile(file), "utf8");
}

export function getProfileBaseline(
  file: PerfBaselineFile,
  profileKey: string,
): ProfileBaseline | null {
  return file.profiles[profileKey] ?? null;
}

export type BaselineUpdateInput = {
  profileKey: string;
  /** Median measurement per metric key. */
  measurements: Record<string, number>;
  label: string;
  machine: string;
  modelId: string;
  samples: number;
  capturedAt: string;
};

/**
 * Return a NEW baseline file with `profileKey`'s metric values replaced by the
 * given measurements.
 *
 * Per-metric TUNING (tolerance, noise floor, hard limit, unit, direction) is
 * preserved from the committed entry when it exists and taken from
 * `DEFAULT_METRIC_CONFIG` when bootstrapping — a baseline refresh must never
 * silently relax a guard. Metrics present in the file but absent from the run
 * are kept untouched; unknown metric keys with no default are rejected.
 */
export function updateProfileBaseline(
  file: PerfBaselineFile,
  input: BaselineUpdateInput,
): PerfBaselineFile {
  const existing = file.profiles[input.profileKey];
  const metrics: Record<string, MetricBaseline> = { ...(existing?.metrics ?? {}) };

  for (const [key, value] of Object.entries(input.measurements)) {
    const config =
      existing?.metrics[key] ?? DEFAULT_METRIC_CONFIG[key as MetricKey] ?? null;
    if (config === null) {
      throw new BaselineFormatError(
        `cannot record unknown metric "${key}" — add it to DEFAULT_METRIC_CONFIG first`,
      );
    }
    metrics[key] = { ...config, value: roundMeasurement(value) };
  }

  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    profiles: {
      ...file.profiles,
      [input.profileKey]: {
        label: input.label,
        machine: input.machine,
        modelId: input.modelId,
        capturedAt: input.capturedAt,
        samples: input.samples,
        metrics,
      },
    },
  };
}
