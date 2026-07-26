// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import {
  BaselineFormatError,
  DEFAULT_METRIC_CONFIG,
  METRIC_KEYS,
  getProfileBaseline,
  parseBaselineFile,
  serializeBaselineFile,
  updateProfileBaseline,
  type PerfBaselineFile,
} from "../baseline";
import committedBaseline from "../../baseline.json";

function makeFile(): PerfBaselineFile {
  return {
    schemaVersion: 1,
    profiles: {
      "desktop-chromium-webgpu": {
        label: "desktop",
        machine: "test machine",
        modelId: "candidate/lfm2.5-350m-onnx",
        capturedAt: "2026-07-25T00:00:00.000Z",
        samples: 3,
        metrics: {
          ttftTurn1Ms: {
            value: 1_000,
            unit: "ms",
            direction: "lower-is-better",
            tolerancePct: 50,
            noiseFloor: 300,
            hardLimit: 20_000,
          },
        },
      },
    },
  };
}

describe("parseBaselineFile", () => {
  it("round-trips a serialized file", () => {
    const file = makeFile();
    expect(parseBaselineFile(serializeBaselineFile(file))).toEqual(file);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseBaselineFile("{oops")).toThrow(BaselineFormatError);
  });

  it("rejects an unexpected schema version", () => {
    expect(() => parseBaselineFile('{"schemaVersion":99,"profiles":{}}')).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects a metric with a non-numeric value", () => {
    const broken = serializeBaselineFile(makeFile()).replace('"value": 1000', '"value": "fast"');
    expect(() => parseBaselineFile(broken)).toThrow(/finite number/);
  });

  it("rejects an unknown direction", () => {
    const broken = serializeBaselineFile(makeFile()).replace(
      '"lower-is-better"',
      '"sideways"',
    );
    expect(() => parseBaselineFile(broken)).toThrow(/direction/);
  });
});

describe("getProfileBaseline", () => {
  it("returns null for a profile that has never been recorded", () => {
    expect(getProfileBaseline(makeFile(), "mobile-safari")).toBeNull();
  });
});

describe("updateProfileBaseline", () => {
  it("replaces values while preserving the committed guard configuration", () => {
    const updated = updateProfileBaseline(makeFile(), {
      profileKey: "desktop-chromium-webgpu",
      measurements: { ttftTurn1Ms: 1_800 },
      label: "desktop",
      machine: "new machine",
      modelId: "candidate/lfm2.5-350m-onnx",
      samples: 3,
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    const metric = updated.profiles["desktop-chromium-webgpu"]!.metrics.ttftTurn1Ms!;
    expect(metric.value).toBe(1_800);
    // A refresh records numbers; it must never quietly widen a guard.
    expect(metric.tolerancePct).toBe(50);
    expect(metric.noiseFloor).toBe(300);
    expect(metric.hardLimit).toBe(20_000);
    expect(updated.profiles["desktop-chromium-webgpu"]!.machine).toBe("new machine");
    expect(updated.profiles["desktop-chromium-webgpu"]!.capturedAt).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  it("rounds recorded values so a deliberate re-record has a readable diff", () => {
    const updated = updateProfileBaseline(makeFile(), {
      profileKey: "desktop-chromium-webgpu",
      measurements: { ttftTurn1Ms: 1490.4900000095367 },
      label: "desktop",
      machine: "m",
      modelId: "candidate/lfm2.5-350m-onnx",
      samples: 3,
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(updated.profiles["desktop-chromium-webgpu"]!.metrics.ttftTurn1Ms!.value).toBe(
      1490.49,
    );
  });

  it("does not mutate the input file", () => {
    const file = makeFile();
    updateProfileBaseline(file, {
      profileKey: "desktop-chromium-webgpu",
      measurements: { ttftTurn1Ms: 9_999 },
      label: "desktop",
      machine: "m",
      modelId: "candidate/lfm2.5-350m-onnx",
      samples: 3,
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(file.profiles["desktop-chromium-webgpu"]!.metrics.ttftTurn1Ms!.value).toBe(1_000);
  });

  it("bootstraps a brand-new profile from the default guard config", () => {
    const updated = updateProfileBaseline(makeFile(), {
      profileKey: "mobile-safari",
      measurements: { decodeTokensPerSec: 12 },
      label: "phone",
      machine: "iPhone",
      modelId: "candidate/qwen2.5-0.5b-mlc",
      samples: 3,
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    const metric = updated.profiles["mobile-safari"]!.metrics.decodeTokensPerSec!;
    expect(metric).toEqual({ ...DEFAULT_METRIC_CONFIG.decodeTokensPerSec, value: 12 });
    // Existing profiles survive an update to a sibling profile.
    expect(updated.profiles["desktop-chromium-webgpu"]).toBeDefined();
  });

  it("keeps baselined metrics the run did not measure", () => {
    const updated = updateProfileBaseline(makeFile(), {
      profileKey: "desktop-chromium-webgpu",
      measurements: { warmReadinessMs: 800 },
      label: "desktop",
      machine: "m",
      modelId: "candidate/lfm2.5-350m-onnx",
      samples: 3,
      capturedAt: "2026-08-01T00:00:00.000Z",
    });
    const metrics = updated.profiles["desktop-chromium-webgpu"]!.metrics;
    expect(metrics.ttftTurn1Ms!.value).toBe(1_000);
    expect(metrics.warmReadinessMs!.value).toBe(800);
  });

  it("refuses to record a metric key with no known configuration", () => {
    expect(() =>
      updateProfileBaseline(makeFile(), {
        profileKey: "desktop-chromium-webgpu",
        measurements: { madeUpMetric: 1 },
        label: "desktop",
        machine: "m",
        modelId: "candidate/lfm2.5-350m-onnx",
        samples: 3,
        capturedAt: "2026-08-01T00:00:00.000Z",
      }),
    ).toThrow(/unknown metric/);
  });
});

describe("committed baseline.json", () => {
  it("parses and covers every metric the gate measures", () => {
    const file = parseBaselineFile(JSON.stringify(committedBaseline));
    const profiles = Object.values(file.profiles);
    expect(profiles.length).toBeGreaterThan(0);
    for (const profile of profiles) {
      for (const key of METRIC_KEYS) {
        expect(profile.metrics[key], `${key} missing from ${profile.label}`).toBeDefined();
      }
    }
  });

  it("never carries a noise floor big enough to disable the percentage band", () => {
    // The floor wins whenever it exceeds value x tolerancePct, so an oversized
    // floor silently turns the relative band off — a 300ms floor on a 177ms TTFT
    // baseline let a measured 2.7x regression report PASS.
    const file = parseBaselineFile(JSON.stringify(committedBaseline));
    for (const [profileKey, profile] of Object.entries(file.profiles)) {
      for (const [key, metric] of Object.entries(profile.metrics)) {
        expect(
          metric.noiseFloor,
          `${profileKey}.${key}: noise floor ${metric.noiseFloor} exceeds the baseline ${metric.value}`,
        ).toBeLessThanOrEqual(metric.value);
      }
    }
  });
});
