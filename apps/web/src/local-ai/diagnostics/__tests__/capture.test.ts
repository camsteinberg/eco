// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDiagnostics,
  exportDiagnostics,
  loadDiagnostics,
  recordDiagnostic,
  type LocalAiDiagnostic,
} from '../capture';
import {
  _resetSetupFailuresForTesting,
  logSetupAttemptFailure,
} from '../../lifecycle/setup-diagnostics';
import { recordSustainedProbe } from '../sustained-probe';
import {
  clearGenerationReceipts,
  recordGenerationReceipt,
} from '../../lifecycle/generation-receipt';

const STORAGE_KEY = 'eco-local-ai-diagnostics-v1';

function makeDiagnostic(overrides?: Partial<LocalAiDiagnostic>): LocalAiDiagnostic {
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    modelId: 'local/qwen3-0.6b',
    profileKey: 'chromium|high-memory-laptop|webgpu',
    runtimeAdapter: 'transformers',
    resolvedBackend: 'webgpu',
    outcome: 'smoke-fail',
    durations: { loadMs: null, firstTokenMs: null, totalMs: 15000 },
    tokensReceived: 0,
    error: { message: 'Smoke timed out before any token' },
    webgpu: { available: true, adapterRequested: true },
    cache: null,
    env: {
      userAgent: 'test-agent',
      deviceMemoryGB: 16,
      hardwareConcurrency: 10,
    },
    events: [
      { at: 0, phase: 'load-start', note: 'test' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  _resetSetupFailuresForTesting();
  clearGenerationReceipts();
});

afterEach(() => {
  localStorage.clear();
  _resetSetupFailuresForTesting();
  clearGenerationReceipts();
  vi.restoreAllMocks();
});

describe('recordDiagnostic + loadDiagnostics', () => {
  it('roundtrips a single entry', () => {
    const entry = makeDiagnostic();
    recordDiagnostic(entry);
    const loaded = loadDiagnostics();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.modelId).toBe('local/qwen3-0.6b');
    expect(loaded[0]!.outcome).toBe('smoke-fail');
    expect(loaded[0]!.schemaVersion).toBe(2);
  });

  it('stores multiple entries', () => {
    recordDiagnostic(makeDiagnostic({ modelId: 'a' }));
    recordDiagnostic(makeDiagnostic({ modelId: 'b' }));
    recordDiagnostic(makeDiagnostic({ modelId: 'c' }));
    expect(loadDiagnostics()).toHaveLength(3);
  });

  it('preserves durations and error fields', () => {
    const entry = makeDiagnostic({
      durations: { loadMs: 500, firstTokenMs: 750, totalMs: 2000 },
      error: { message: 'oom', name: 'AdapterError', stack: 'at line 42' },
    });
    recordDiagnostic(entry);
    const loaded = loadDiagnostics();
    expect(loaded[0]!.durations).toEqual({ loadMs: 500, firstTokenMs: 750, totalMs: 2000 });
    expect(loaded[0]!.error).toEqual({ message: 'oom', name: 'AdapterError', stack: 'at line 42' });
  });
});

describe('FIFO eviction at 50', () => {
  it('evicts oldest entries when exceeding max', () => {
    for (let i = 0; i < 55; i++) {
      recordDiagnostic(makeDiagnostic({ modelId: `model-${i}` }));
    }
    const loaded = loadDiagnostics();
    expect(loaded).toHaveLength(50);
    // Oldest 5 should be evicted — first entry should be model-5
    expect(loaded[0]!.modelId).toBe('model-5');
    expect(loaded[49]!.modelId).toBe('model-54');
  });
});

describe('quota handling', () => {
  it('does not throw on quota exceeded', () => {
    // Simulate quota exceeded by filling localStorage
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let callCount = 0;
    localStorage.setItem = (key: string, value: string) => {
      callCount++;
      if (callCount > 1) {
        throw new DOMException('QuotaExceededError');
      }
      originalSetItem(key, value);
    };
    try {
      // First call succeeds, second would throw
      recordDiagnostic(makeDiagnostic());
      expect(() => recordDiagnostic(makeDiagnostic())).not.toThrow();
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});

describe('JSON parse error tolerance', () => {
  it('returns [] on malformed JSON and clears storage', () => {
    localStorage.setItem(STORAGE_KEY, '{not valid json');
    expect(loadDiagnostics()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('returns [] when storage contains a non-array', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    expect(loadDiagnostics()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('filters out entries that fail validation', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        makeDiagnostic({ modelId: 'valid' }),
        { schemaVersion: 2, modelId: 'missing-fields' }, // invalid — missing required fields
        { schemaVersion: 1, modelId: 'old-version' },    // invalid — pre-slice-3 schema
        makeDiagnostic({ modelId: 'also-valid' }),
      ]),
    );
    const loaded = loadDiagnostics();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.modelId).toBe('valid');
    expect(loaded[1]!.modelId).toBe('also-valid');
  });
});

describe('clearDiagnostics', () => {
  it('removes all entries', () => {
    recordDiagnostic(makeDiagnostic());
    recordDiagnostic(makeDiagnostic());
    expect(loadDiagnostics()).toHaveLength(2);
    clearDiagnostics();
    expect(loadDiagnostics()).toEqual([]);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('exportDiagnostics', () => {
  it('returns a JSON envelope with schemaVersion and entries', async () => {
    recordDiagnostic(makeDiagnostic({ modelId: 'test-export' }));
    const json = await exportDiagnostics();
    const parsed = JSON.parse(json) as {
      schemaVersion: number;
      dumpedAt: string;
      env: { userAgent: string };
      entries: LocalAiDiagnostic[];
    };
    // Dump-envelope version is 4 (adds generationReceipts); per-entry schema stays 2.
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.entries[0]!.schemaVersion).toBe(2);
    expect(typeof parsed.dumpedAt).toBe('string');
    expect(parsed.env).toBeDefined();
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.modelId).toBe('test-export');
  });

  it('carries recent setup-attempt failures in the dump', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    logSetupAttemptFailure({
      modelId: 'candidate/qwen2.5-0.5b-mlc',
      runtime: 'webllm',
      phase: 'download',
      reason: 'HTTP 404 fetching range of https://cdn.example/model.bin',
    });

    const parsed = JSON.parse(await exportDiagnostics()) as {
      setupFailures: { modelId: string; phase: string; reason: string; at: string }[];
    };
    expect(parsed.setupFailures).toHaveLength(1);
    expect(parsed.setupFailures[0]).toMatchObject({
      modelId: 'candidate/qwen2.5-0.5b-mlc',
      phase: 'download',
    });
    expect(parsed.setupFailures[0]!.reason).toContain('404');
  });

  it('reports an empty setupFailures array when none were recorded', async () => {
    const parsed = JSON.parse(await exportDiagnostics()) as { setupFailures: unknown[] };
    expect(parsed.setupFailures).toEqual([]);
  });

  it('carries recent generation receipts (timings/phases) in the dump', async () => {
    recordGenerationReceipt({
      generationId: 'gen-1',
      generationRole: 'primary',
      modelId: 'candidate/qwen3.5-2b-onnx',
      timestamp: Date.now(),
      templateName: 'chatml',
      systemPromptHash: 'deadbeef',
      samplingProfile: { temperature: 0.7, maxTokens: 512 },
      promptTokens: 12,
      completionTokens: 34,
      durationMs: 4200,
      status: 'complete',
      firstTokenMs: 1800,
      events: [
        { at: 0, phase: 'load-start' },
        { at: 1500, phase: 'load-finish' },
        { at: 1800, phase: 'first-token' },
        { at: 4200, phase: 'generation-complete' },
      ],
    });

    const parsed = JSON.parse(await exportDiagnostics()) as {
      generationReceipts: {
        generationId: string;
        firstTokenMs: number | null;
        events: { at: number; phase: string }[];
      }[];
    };
    expect(parsed.generationReceipts).toHaveLength(1);
    expect(parsed.generationReceipts[0]!.generationId).toBe('gen-1');
    expect(parsed.generationReceipts[0]!.firstTokenMs).toBe(1800);
    expect(parsed.generationReceipts[0]!.events.map((e) => e.phase)).toEqual([
      'load-start',
      'load-finish',
      'first-token',
      'generation-complete',
    ]);
  });

  it('reports an empty generationReceipts array when none were recorded', async () => {
    const parsed = JSON.parse(await exportDiagnostics()) as { generationReceipts: unknown[] };
    expect(parsed.generationReceipts).toEqual([]);
  });

  it('returns empty entries array when no diagnostics', async () => {
    const json = await exportDiagnostics();
    const parsed = JSON.parse(json) as { entries: LocalAiDiagnostic[] };
    expect(parsed.entries).toEqual([]);
  });

  it('produces valid JSON (pretty-printed)', async () => {
    recordDiagnostic(makeDiagnostic());
    const json = await exportDiagnostics();
    // Pretty-printed = has newlines
    expect(json).toContain('\n');
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

describe('exportDiagnostics — redaction', () => {
  it('strips raw URLs and secrets from error text, stacks, notes, and setup reasons', async () => {
    recordDiagnostic(
      makeDiagnostic({
        error: {
          message: 'fetch failed for https://cdn.example.com/models/q.onnx?token=abc123',
          stack: 'Error at https://econetwork.ai/_next/static/chunk.js:1:2',
        },
        webgpu: { available: false, adapterRequested: true, adapterError: 'see https://x.y/z' },
        events: [{ at: 0, phase: 'load-fail', note: 'api_key=sk-abcdefghijklmnop123' }],
      }),
    );
    logSetupAttemptFailure({
      modelId: 'local/qwen3-0.6b',
      runtime: 'transformers',
      phase: 'download',
      reason: 'HTTP 403 from https://r2.example.com/weights.bin',
    });
    const json = await exportDiagnostics();
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toContain('abc123');
    expect(json).not.toContain('sk-abcdefghijklmnop123');
    expect(json).toContain('[redacted-url]');
    const dump = JSON.parse(json);
    expect(dump.entries[0].error.message).toBe('fetch failed for [redacted-url]');
    expect(dump.entries[0].error.stack).toBe('Error at [redacted-url]');
    expect(dump.entries[0].webgpu.adapterError).toBe('see [redacted-url]');
    expect(dump.setupFailures[0].reason).toBe('HTTP 403 from [redacted-url]');
  });

  it('scrubs sustained-probe error fields (record and per-turn)', async () => {
    recordSustainedProbe({
      version: 1,
      recordedAt: '2026-08-27T00:00:00.000Z',
      modelId: 'm',
      backend: 'webgpu',
      outcome: 'error',
      turnsRequested: 1,
      turnsCompleted: 0,
      targetTokensPerTurn: 64,
      levers: { ortArtifact: null, numThreads: null, forceWasm: false },
      crossOriginIsolated: false,
      memoryApi: { performanceMemory: false, measureUserAgent: false },
      turns: [{ turn: 1, promptTokens: null, completionTokens: null, cumulativeContextTokens: null, ttftMs: null, tokensPerSecond: null, error: 'turn failed https://a.b/c' }],
      samples: [],
      peakUsedJSHeapMB: null,
      error: 'probe failed https://a.b/d?token=zzz',
    });
    const json = await exportDiagnostics();
    expect(json).not.toMatch(/https?:\/\//);
    expect(json).not.toContain('zzz');
  });

  it('leaves the on-device ledger untouched (redaction is export-only)', async () => {
    recordDiagnostic(makeDiagnostic({ error: { message: 'x https://a.b/c' } }));
    await exportDiagnostics();
    expect(loadDiagnostics()[0]!.error?.message).toBe('x https://a.b/c');
  });
});
