// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import type { MetricBaseline, ProfileBaseline } from "../baseline";
import {
  compareMetric,
  evaluateRun,
  formatReport,
  median,
  regressionBand,
} from "../compare";

const LOWER: MetricBaseline = {
  value: 1_000,
  unit: "ms",
  direction: "lower-is-better",
  tolerancePct: 50,
  noiseFloor: 300,
  hardLimit: 20_000,
};

const HIGHER: MetricBaseline = {
  value: 40,
  unit: "tok/s",
  direction: "higher-is-better",
  tolerancePct: 50,
  noiseFloor: 2,
  hardLimit: 5,
};

describe("median", () => {
  it("returns the middle sample for odd counts", () => {
    expect(median([300, 100, 200])).toBe(200);
  });

  it("averages the two middle samples for even counts", () => {
    expect(median([100, 200, 300, 500])).toBe(250);
  });

  it("does not mutate its input", () => {
    const samples = [3, 1, 2];
    median(samples);
    expect(samples).toEqual([3, 1, 2]);
  });

  it("throws on an empty list", () => {
    expect(() => median([])).toThrow(/empty/);
  });
});

describe("regressionBand", () => {
  it("uses the percentage band when it is wider than the noise floor", () => {
    expect(regressionBand(LOWER)).toBe(1_500);
  });

  it("uses the noise floor when the baseline is small enough that the band collapses", () => {
    // 50% of 40ms is 20ms — narrower than the 300ms floor, so the floor wins.
    expect(regressionBand({ ...LOWER, value: 40 })).toBe(340);
  });

  it("mirrors both terms for higher-is-better metrics", () => {
    // 50% of 40 tok/s = 20; 40 - noiseFloor(2) = 38. The stricter (lower) wins.
    expect(regressionBand(HIGHER)).toBe(20);
  });
});

describe("compareMetric — lower is better", () => {
  it("passes inside the band", () => {
    const verdict = compareMetric("ttftTurn1Ms", [1_100, 1_200, 1_400], LOWER);
    expect(verdict.status).toBe("pass");
    expect(verdict.measured).toBe(1_200);
    expect(verdict.samples).toEqual([1_100, 1_200, 1_400]);
  });

  it("flags a regression past the band", () => {
    const verdict = compareMetric("ttftTurn1Ms", [1_600, 1_700, 1_900], LOWER);
    expect(verdict.status).toBe("regression");
    expect(verdict.detail).toContain("outside the ±50% band");
    expect(Math.round(verdict.deltaPct)).toBe(70);
  });

  it("treats the band edge itself as a pass", () => {
    expect(compareMetric("ttftTurn1Ms", [1_500], LOWER).status).toBe("pass");
  });

  it("reports a clear win as an improvement, never a failure", () => {
    const verdict = compareMetric("ttftTurn1Ms", [400, 420, 450], LOWER);
    expect(verdict.status).toBe("improved");
    expect(verdict.detail).toContain("re-record the baseline");
  });

  it("fails on the hard ceiling even when the band would allow it", () => {
    // A generous baseline can drift the band above the ceiling; the ceiling wins.
    const generous: MetricBaseline = { ...LOWER, value: 19_000, hardLimit: 20_000 };
    const verdict = compareMetric("ttftTurn1Ms", [21_000], generous);
    expect(regressionBand(generous)).toBeGreaterThan(generous.hardLimit);
    expect(verdict.status).toBe("hard-limit");
    expect(verdict.detail).toContain("absolute ceiling");
  });

  it("keeps a tiny metric inside the band under pure jitter", () => {
    const tiny: MetricBaseline = { ...LOWER, value: 40, noiseFloor: 20 };
    expect(compareMetric("ttftTurn2Ms", [55, 50, 58], tiny).status).toBe("pass");
  });

  it("shows why an oversized noise floor disables the percentage band", () => {
    // Regression guard for a real miss: with a 300ms floor on a 177ms baseline
    // the band becomes 477ms, so a 2.7x regression reads as PASS. The committed
    // baselines are checked against this in baseline.test.ts; this documents the
    // mechanism so nobody "fixes flakiness" by raising a floor again.
    const oversized: MetricBaseline = { ...LOWER, value: 177, noiseFloor: 300 };
    expect(compareMetric("ttftTurn1Ms", [477], oversized).status).toBe("pass");

    const sized: MetricBaseline = { ...LOWER, value: 177, noiseFloor: 50 };
    expect(compareMetric("ttftTurn1Ms", [477], sized).status).toBe("regression");
  });
});

describe("compareMetric — higher is better", () => {
  it("passes inside the band", () => {
    expect(compareMetric("decodeTokensPerSec", [38, 36, 41], HIGHER).status).toBe("pass");
  });

  it("flags a regression when the rate drops below the band", () => {
    const verdict = compareMetric("decodeTokensPerSec", [18, 17, 19], HIGHER);
    expect(verdict.status).toBe("regression");
    expect(verdict.deltaPct).toBeLessThan(0);
  });

  it("fails on the absolute floor", () => {
    const verdict = compareMetric("decodeTokensPerSec", [4, 3, 4], HIGHER);
    expect(verdict.status).toBe("hard-limit");
    expect(verdict.detail).toContain("absolute floor");
  });

  it("reports a faster decode rate as an improvement", () => {
    expect(compareMetric("decodeTokensPerSec", [70, 72, 75], HIGHER).status).toBe("improved");
  });

  it("throws when no samples were recorded", () => {
    expect(() => compareMetric("decodeTokensPerSec", [], HIGHER)).toThrow(/no samples/);
  });
});

const PROFILE: ProfileBaseline = {
  label: "test profile",
  machine: "test machine",
  modelId: "candidate/lfm2.5-350m-onnx",
  capturedAt: "2026-07-25T00:00:00.000Z",
  samples: 3,
  metrics: { ttftTurn1Ms: LOWER, decodeTokensPerSec: HIGHER },
};

describe("evaluateRun", () => {
  it("passes when every metric is inside its band", () => {
    const report = evaluateRun(
      "desktop",
      { ttftTurn1Ms: [1_100, 1_200], decodeTokensPerSec: [39, 41] },
      PROFILE,
    );
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.verdicts).toHaveLength(2);
  });

  it("collects every failing metric, not just the first", () => {
    const report = evaluateRun(
      "desktop",
      { ttftTurn1Ms: [25_000], decodeTokensPerSec: [10] },
      PROFILE,
    );
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(2);
  });

  it("fails when a baselined metric recorded no samples", () => {
    const report = evaluateRun("desktop", { decodeTokensPerSec: [40] }, PROFILE);
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain("recorded no samples");
  });

  it("fails loudly on a metric that has no baseline yet", () => {
    const report = evaluateRun(
      "desktop",
      { ttftTurn1Ms: [1_200], decodeTokensPerSec: [40], warmReadinessMs: [900] },
      PROFILE,
    );
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain("ECO_PERF_UPDATE_BASELINE=1");
  });
});

describe("formatReport", () => {
  it("renders every sample and every failure", () => {
    const report = evaluateRun(
      "desktop",
      { ttftTurn1Ms: [1_100, 9_000], decodeTokensPerSec: [40] },
      PROFILE,
    );
    const text = formatReport(report);
    expect(text).toContain('profile "desktop"');
    expect(text).toContain("samples: 1100, 9000");
    expect(text).toContain("failures:");
  });
});
