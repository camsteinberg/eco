// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from 'vitest';
import {
  buildBenchmarkRecordsFromRuns,
  buildSnapshotFromEvalExport,
  mergeBenchmarkRecords,
  parseEvalExport,
  parseCliArgs,
} from '../build-seed-evidence.mjs';

const GENERATED_AT = '2026-06-16T12:00:00.000Z';

function result(overrides = {}) {
  return {
    promptId: 'p1',
    category: 'factual-known',
    modelId: 'candidate/qwen3.5-2b-onnx',
    runtimeAdapter: 'transformers',
    output: 'hello',
    generationOptions: { maxTokens: 128 },
    scores: {},
    perf: {
      ttftMs: 300,
      tokensPerSec: 20,
      totalMs: 1000,
      completionTokens: 20,
      smokePass: true,
    },
    error: null,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    label: 'seed-refresh',
    startedAt: '2026-06-16T11:00:00.000Z',
    finishedAt: '2026-06-16T11:05:00.000Z',
    device: {
      profileKey: 'chromium|high-memory-laptop|webgpu',
      browserClass: 'chromium',
      webgpuSupport: 'webgpu',
      deviceClass: 'high-memory-laptop',
    },
    config: {
      messageTopology: 'production-user-turn-hints',
    },
    results: [result()],
    ...overrides,
  };
}

describe('parseEvalExport', () => {
  it('accepts an Eval Harness export envelope', () => {
    const runs = [run({ runId: 'enveloped' })];
    expect(parseEvalExport({ schemaVersion: 1, dumpedAt: GENERATED_AT, runs })).toEqual(runs);
  });

  it('accepts a bare run array', () => {
    const runs = [run({ runId: 'bare' })];
    expect(parseEvalExport(runs)).toEqual(runs);
  });

  it('rejects payloads without runs', () => {
    expect(() => parseEvalExport({ schemaVersion: 1, runs: 'nope' })).toThrow(
      /expected an Eval Harness export/,
    );
  });
});

describe('parseCliArgs', () => {
  it('ignores the standalone pnpm argument separator', () => {
    expect(parseCliArgs(['--', '--eval-export', 'runs.json', '--help'])).toMatchObject({
      evalExport: 'runs.json',
      help: true,
    });
  });
});

describe('buildBenchmarkRecordsFromRuns', () => {
  it('ignores eval-only Gemma LiteRT rows even when their smoke passes', () => {
    const records = buildBenchmarkRecordsFromRuns(
      [
        run({
          results: [
            // gemma-4-e2b-litert GRADUATED to the catalog (2026-06-29); e4b stays
            // eval-only, so it's the eval-only-exclusion fixture now.
            result({ modelId: 'candidate/gemma-4-e4b-litert', runtimeAdapter: 'litert' }),
            result({ modelId: 'candidate/qwen3.5-2b-onnx' }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    expect(records.map((record) => record.modelId)).toEqual(['candidate/qwen3.5-2b-onnx']);
  });

  it('builds one benchmark record per model/profile using medians and smoke-pass rate', () => {
    const records = buildBenchmarkRecordsFromRuns(
      [
        run({
          finishedAt: '2026-06-16T11:05:00.000Z',
          results: [
            result({ promptId: 'a', perf: { ttftMs: 500, tokensPerSec: 12, totalMs: 1000, completionTokens: 12, smokePass: true } }),
            result({ promptId: 'b', perf: { ttftMs: 100, tokensPerSec: 28, totalMs: 1000, completionTokens: 28, smokePass: true } }),
            result({ promptId: 'c', perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false } }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      modelId: 'candidate/qwen3.5-2b-onnx',
      browserClass: 'chromium',
      deviceClass: 'high-memory-laptop',
      readiness: 'ready',
      source: 'benchmark',
      routingEvidence: {
        runtimeAdapter: 'transformers',
        observedAt: Date.parse('2026-06-16T11:05:00.000Z'),
        benchmark: {
          firstTokenMs: 300,
          tokensPerSecond: 20,
          reliability: 2 / 3,
        },
      },
    });
  });

  it('skips incomplete runs, exploratory topology runs, and groups with no successful smoke pass', () => {
    const records = buildBenchmarkRecordsFromRuns(
      [
        run({ finishedAt: null, results: [result()] }),
        run({
          runId: 'system-front-counterfactual',
          config: { messageTopology: 'system-front-hints' },
          results: [result()],
        }),
        run({
          runId: 'gemma-native-counterfactual',
          config: { messageTopology: 'gemma-native-user-contract' },
          results: [result({ modelId: 'candidate/qwen3.5-2b-onnx' })],
        }),
        run({
          runId: 'all-failed',
          results: [
            result({
              perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false },
              error: 'load failed',
            }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    expect(records).toEqual([]);
  });

  it('skips wasm-fallback profile records unless the export proves a wasm backend', () => {
    const withoutBackendProof = buildBenchmarkRecordsFromRuns(
      [
        run({
          device: {
            profileKey: 'chromium|wasm-fallback-laptop|wasm-only',
            browserClass: 'chromium',
            webgpuSupport: 'wasm-only',
            deviceClass: 'wasm-fallback-laptop',
          },
          results: [
            result({
              modelId: 'local/qwen3-0.6b',
              perf: { ttftMs: 100, tokensPerSec: 12, totalMs: 1000, completionTokens: 12, smokePass: true },
            }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    const wrongBackend = buildBenchmarkRecordsFromRuns(
      [
        run({
          device: {
            profileKey: 'chromium|wasm-fallback-laptop|wasm-only',
            browserClass: 'chromium',
            webgpuSupport: 'wasm-only',
            deviceClass: 'wasm-fallback-laptop',
          },
          results: [
            result({
              modelId: 'local/qwen3-0.6b',
              runtimeBackend: 'webgpu',
              perf: { ttftMs: 100, tokensPerSec: 12, totalMs: 1000, completionTokens: 12, smokePass: true },
            }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    expect(withoutBackendProof).toEqual([]);
    expect(wrongBackend).toEqual([]);
  });

  it('records runtimeBackend when wasm-fallback proof uses the wasm backend', () => {
    const records = buildBenchmarkRecordsFromRuns(
      [
        run({
          device: {
            profileKey: 'chromium|wasm-fallback-laptop|wasm-only',
            browserClass: 'chromium',
            webgpuSupport: 'wasm-only',
            deviceClass: 'wasm-fallback-laptop',
          },
          results: [
            result({
              modelId: 'local/qwen3-0.6b',
              runtimeBackend: 'wasm',
              perf: { ttftMs: 100, tokensPerSec: 12, totalMs: 1000, completionTokens: 12, smokePass: true },
            }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    expect(records).toHaveLength(1);
    expect(records[0].routingEvidence.runtimeBackend).toBe('wasm');
  });

  it('keeps accepted wasm records from inheriting failed WebGPU backend metadata', () => {
    const records = buildBenchmarkRecordsFromRuns(
      [
        run({
          device: {
            profileKey: 'chromium|wasm-fallback-laptop|wasm-only',
            browserClass: 'chromium',
            webgpuSupport: 'wasm-only',
            deviceClass: 'wasm-fallback-laptop',
          },
          results: [
            result({
              modelId: 'local/qwen3-0.6b',
              runtimeBackend: 'wasm',
              perf: { ttftMs: 100, tokensPerSec: 12, totalMs: 1000, completionTokens: 12, smokePass: true },
            }),
            result({
              modelId: 'local/qwen3-0.6b',
              runtimeBackend: 'webgpu',
              error: 'failed earlier',
              perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false },
            }),
            result({
              modelId: 'local/qwen3-0.6b',
              runtimeBackend: 'webgpu',
              error: 'failed again',
              perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false },
            }),
          ],
        }),
      ],
      GENERATED_AT,
    );

    expect(records).toHaveLength(1);
    expect(records[0].routingEvidence.runtimeBackend).toBe('wasm');
  });
});

describe('mergeBenchmarkRecords', () => {
  it('preserves calculated records and replaces a matching calculated key with benchmark proof', () => {
    const existing = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T23:05:00.000Z',
      routingEvidenceReconciliation: [
        {
          modelId: 'candidate/qwen3.5-2b-onnx',
          name: 'Eco Qwen calculated',
          browserClass: 'chromium',
          deviceClass: 'high-memory-laptop',
          readiness: 'ready',
          source: 'calculated',
          routingEvidence: {
            runtimeAdapter: 'transformers-ort',
            observedAt: Date.parse('2026-05-13T23:05:00.000Z'),
            benchmark: { firstTokenMs: 900, tokensPerSecond: 10, reliability: 0.6 },
          },
        },
        {
          modelId: 'candidate/lfm2.5-350m-onnx',
          browserClass: 'safari',
          deviceClass: 'wasm-fallback-laptop',
          readiness: 'ready',
          source: 'calculated',
          routingEvidence: {
            observedAt: Date.parse('2026-05-14T10:05:00.000Z'),
            benchmark: { firstTokenMs: 1200, tokensPerSecond: 8, reliability: 0.6 },
          },
        },
      ],
    };

    const benchmark = buildBenchmarkRecordsFromRuns(
      [
        run({
          results: [
            result({ perf: { ttftMs: 100, tokensPerSec: 30, totalMs: 1000, completionTokens: 30, smokePass: true } }),
          ],
        }),
      ],
      GENERATED_AT,
    );
    const merged = mergeBenchmarkRecords(existing, benchmark, GENERATED_AT);

    expect(merged.generatedAt).toBe(GENERATED_AT);
    expect(merged.routingEvidenceReconciliation).toHaveLength(2);
    expect(merged.routingEvidenceReconciliation[0]).toMatchObject({
      modelId: 'candidate/lfm2.5-350m-onnx',
      source: 'calculated',
    });
    expect(merged.routingEvidenceReconciliation[0].generatedAt).toBeUndefined();
    expect(merged.routingEvidenceReconciliation[1]).toMatchObject({
      modelId: 'candidate/qwen3.5-2b-onnx',
      name: 'Eco Qwen calculated',
      source: 'benchmark',
      routingEvidence: {
        benchmark: { firstTokenMs: 100, tokensPerSecond: 30, reliability: 1 },
      },
    });
  });

  it('uses snapshot generatedAt only for preserved legacy rows with no row timestamp', () => {
    const existing = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T23:05:00.000Z',
      routingEvidenceReconciliation: [
        {
          modelId: 'candidate/lfm2.5-350m-onnx',
          browserClass: 'safari',
          deviceClass: 'wasm-fallback-laptop',
          readiness: 'ready',
          source: 'calculated',
          routingEvidence: {
            benchmark: { firstTokenMs: 1200, tokensPerSecond: 8, reliability: 0.6 },
          },
        },
      ],
    };

    const merged = mergeBenchmarkRecords(existing, [], GENERATED_AT);

    expect(merged.routingEvidenceReconciliation[0]).toMatchObject({
      modelId: 'candidate/lfm2.5-350m-onnx',
      generatedAt: '2026-05-13T23:05:00.000Z',
    });
  });

  it('does not preserve stale existing runtimeBackend when the incoming benchmark has none', () => {
    const existing = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T23:05:00.000Z',
      routingEvidenceReconciliation: [
        {
          modelId: 'candidate/qwen3.5-2b-onnx',
          browserClass: 'chromium',
          deviceClass: 'high-memory-laptop',
          readiness: 'ready',
          source: 'benchmark',
          routingEvidence: {
            runtimeAdapter: 'transformers',
            runtimeBackend: 'wasm',
            recentFailures: 1,
            failureCode: 'quota-insufficient',
            benchmark: { firstTokenMs: 900, tokensPerSecond: 10, reliability: 0.6 },
          },
        },
      ],
    };

    const benchmark = buildBenchmarkRecordsFromRuns(
      [
        run({
          results: [
            result({
              perf: { ttftMs: 100, tokensPerSec: 30, totalMs: 1000, completionTokens: 30, smokePass: true },
            }),
          ],
        }),
      ],
      GENERATED_AT,
    );
    const merged = mergeBenchmarkRecords(existing, benchmark, GENERATED_AT);

    expect(merged.routingEvidenceReconciliation[0].routingEvidence.runtimeBackend).toBeUndefined();
    expect(merged.routingEvidenceReconciliation[0].routingEvidence.recentFailures).toBeUndefined();
    expect(merged.routingEvidenceReconciliation[0].routingEvidence.failureCode).toBeUndefined();
  });
});

describe('buildSnapshotFromEvalExport', () => {
  it('does not add or preserve eval-only Gemma LiteRT rows in the merged shipping seed snapshot', () => {
    const existing = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T23:05:00.000Z',
      routingEvidenceReconciliation: [
        {
          // Stale eval-only row (e4b stays eval-only after e2b graduated) — must be dropped.
          modelId: 'candidate/gemma-4-e4b-litert',
          browserClass: 'chromium',
          deviceClass: 'high-memory-laptop',
          readiness: 'ready',
          source: 'benchmark',
          routingEvidence: {
            runtimeAdapter: 'litert',
            observedAt: Date.parse('2026-05-13T23:05:00.000Z'),
            benchmark: { firstTokenMs: 800, tokensPerSecond: 30, reliability: 1 },
          },
        },
      ],
    };
    const snapshot = buildSnapshotFromEvalExport(
      existing,
      {
        schemaVersion: 1,
        dumpedAt: GENERATED_AT,
        runs: [
          run({
            results: [
              // e4b is the eval-only Gemma LiteRT row (e2b graduated to catalog).
              result({ modelId: 'candidate/gemma-4-e4b-litert', runtimeAdapter: 'litert' }),
              result({ modelId: 'candidate/qwen3.5-2b-onnx' }),
              result({ modelId: 'candidate/lfm2.5-1.2b-instruct-onnx' }),
            ],
          }),
        ],
      },
      GENERATED_AT,
    );

    expect(snapshot.routingEvidenceReconciliation.map((record) => record.modelId)).toEqual([
      'candidate/lfm2.5-1.2b-instruct-onnx',
      'candidate/qwen3.5-2b-onnx',
    ]);
  });

  it('builds a merged snapshot from a raw export payload', () => {
    const existing = { schemaVersion: 1, generatedAt: '2026-05-13T23:05:00.000Z', routingEvidenceReconciliation: [] };
    const snapshot = buildSnapshotFromEvalExport(
      existing,
      { schemaVersion: 1, dumpedAt: GENERATED_AT, runs: [run()] },
      GENERATED_AT,
    );

    expect(snapshot.generatedAt).toBe(GENERATED_AT);
    expect(snapshot.routingEvidenceReconciliation).toHaveLength(1);
    expect(snapshot.routingEvidenceReconciliation[0].modelId).toBe('candidate/qwen3.5-2b-onnx');
  });

  it('does not refresh the snapshot from exploratory topology exports', () => {
    const existing = { schemaVersion: 1, generatedAt: '2026-05-13T23:05:00.000Z', routingEvidenceReconciliation: [] };
    const snapshot = buildSnapshotFromEvalExport(
      existing,
      {
        schemaVersion: 1,
        dumpedAt: GENERATED_AT,
        runs: [run({ config: { messageTopology: 'system-front-hints' } })],
      },
      GENERATED_AT,
    );

    expect(snapshot.generatedAt).toBe(existing.generatedAt);
    expect(snapshot.routingEvidenceReconciliation).toEqual([]);
  });

  it('does not refresh the snapshot timestamp when an export has no accepted benchmark proof', () => {
    const existing = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T23:05:00.000Z',
      routingEvidenceReconciliation: [
        {
          modelId: 'local/qwen3-0.6b',
          browserClass: 'chromium',
          deviceClass: 'high-memory-laptop',
          readiness: 'ready',
          source: 'benchmark',
          routingEvidence: {
            runtimeAdapter: 'transformers',
            observedAt: Date.parse('2026-05-13T23:05:00.000Z'),
            benchmark: { firstTokenMs: 269, tokensPerSecond: 17, reliability: 1 },
          },
        },
      ],
    };

    const failedRun = run({
      results: [
        result({
          modelId: 'local/qwen3-0.6b',
          error: 'load failed: Load aborted',
          perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false },
        }),
      ],
    });

    const snapshot = buildSnapshotFromEvalExport(
      existing,
      { schemaVersion: 1, dumpedAt: GENERATED_AT, runs: [failedRun] },
      GENERATED_AT,
    );

    expect(snapshot.generatedAt).toBe(existing.generatedAt);
    expect(snapshot.routingEvidenceReconciliation).toHaveLength(1);
    expect(snapshot.routingEvidenceReconciliation[0].modelId).toBe('local/qwen3-0.6b');
  });

  it('drops unsafe preserved benchmark-like records when a fresh attempted group has no proof', () => {
    const existing = {
      schemaVersion: 1,
      generatedAt: '2026-05-13T23:05:00.000Z',
      routingEvidenceReconciliation: [
        {
          modelId: 'local/qwen3-0.6b',
          browserClass: 'chromium',
          deviceClass: 'high-memory-laptop',
          readiness: 'ready',
          compatibilityState: 'fail',
          routingEvidence: {
            runtimeAdapter: 'transformers',
            lifecycleProof: {
              prepare: { status: 'fail', reason: 'download-status:not-downloaded' },
            },
            benchmark: { firstTokenMs: 700, tokensPerSecond: 30, reliability: 0.8 },
          },
        },
        {
          modelId: 'candidate/lfm2.5-350m-onnx',
          browserClass: 'chromium',
          deviceClass: 'wasm-fallback-laptop',
          readiness: 'ready',
          source: 'calculated',
          routingEvidence: {
            benchmark: { firstTokenMs: 2200, tokensPerSecond: 7, reliability: 0.85 },
          },
        },
      ],
    };

    const failedBonsai = run({
      device: {
        profileKey: 'chromium|high-memory-laptop|webgpu',
        browserClass: 'chromium',
        webgpuSupport: 'webgpu',
        deviceClass: 'high-memory-laptop',
      },
      results: [
        result({
          modelId: 'local/qwen3-0.6b',
          error: 'load failed: network error',
          perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false },
        }),
      ],
    });
    const failedCalculatedWasm = run({
      device: {
        profileKey: 'chromium|wasm-fallback-laptop|wasm-only',
        browserClass: 'chromium',
        webgpuSupport: 'wasm-only',
        deviceClass: 'wasm-fallback-laptop',
      },
      results: [
        result({
          modelId: 'candidate/lfm2.5-350m-onnx',
          error: 'load failed: wasm kernel missing',
          perf: { ttftMs: null, tokensPerSec: null, totalMs: 1000, completionTokens: 0, smokePass: false },
        }),
      ],
    });

    const snapshot = buildSnapshotFromEvalExport(
      existing,
      { schemaVersion: 1, dumpedAt: GENERATED_AT, runs: [failedBonsai, failedCalculatedWasm] },
      GENERATED_AT,
    );

    expect(snapshot.routingEvidenceReconciliation).toHaveLength(1);
    expect(snapshot.routingEvidenceReconciliation[0]).toMatchObject({
      modelId: 'candidate/lfm2.5-350m-onnx',
      source: 'calculated',
    });
  });
});
