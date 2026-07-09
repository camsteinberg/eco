// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearDiagnostics,
  exportDiagnostics,
  loadDiagnostics,
  recordDiagnostic,
  type LocalAiDiagnostic,
} from '../capture';

const STORAGE_KEY = 'eco-local-ai-diagnostics-v1';

function makeDiagnostic(overrides?: Partial<LocalAiDiagnostic>): LocalAiDiagnostic {
  return {
    schemaVersion: 2,
    recordedAt: new Date().toISOString(),
    modelId: 'local/phi3-mini-4k-q4f16',
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
});

afterEach(() => {
  localStorage.clear();
});

describe('recordDiagnostic + loadDiagnostics', () => {
  it('roundtrips a single entry', () => {
    const entry = makeDiagnostic();
    recordDiagnostic(entry);
    const loaded = loadDiagnostics();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.modelId).toBe('local/phi3-mini-4k-q4f16');
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
    expect(parsed.schemaVersion).toBe(2);
    expect(typeof parsed.dumpedAt).toBe('string');
    expect(parsed.env).toBeDefined();
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.modelId).toBe('test-export');
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
