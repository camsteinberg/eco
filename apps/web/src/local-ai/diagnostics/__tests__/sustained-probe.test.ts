// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bytesToMB,
  clearMarker,
  clearSustainedProbes,
  detectMemoryApis,
  loadSustainedProbes,
  measureUserAgentMemoryMB,
  peakUsedJSHeap,
  readMarker,
  readMemorySample,
  reconstructKilledRecord,
  recordSustainedProbe,
  recoverOrphanedMarker,
  updateMarkerProgress,
  writeMarker,
  type MemorySample,
  type SustainedProbeMarker,
  type SustainedProbeRecord,
} from '../sustained-probe';

const MARKER: SustainedProbeMarker = {
  startedAt: '2026-07-15T00:00:00.000Z',
  modelId: 'candidate/qwen3.5-2b-onnx',
  turnsRequested: 6,
  targetTokensPerTurn: 200,
  levers: { ortArtifact: 'jspi', numThreads: 4, forceWasm: true },
  turnsCompleted: 3,
};

beforeEach(() => {
  clearMarker();
  clearSustainedProbes();
});

afterEach(() => {
  clearMarker();
  clearSustainedProbes();
});

describe('readActiveLevers — echoes the s32 ORT session-option levers', () => {
  const originalSearch = window.location.search;

  afterEach(() => {
    window.history.replaceState({}, '', `/${originalSearch}`);
  });

  it('carries arena / mem-pattern / graph-opt from the URL into the levers snapshot', async () => {
    window.history.replaceState(
      {},
      '',
      '/?eco-force-wasm=true&eco-force-ort-arena=off&eco-force-ort-mem-pattern=off&eco-force-ort-graph-opt=basic',
    );
    const { readActiveLevers } = await import('../sustained-probe');
    expect(readActiveLevers()).toEqual({
      ortArtifact: null,
      numThreads: null,
      forceWasm: true,
      ortArena: false,
      ortMemPattern: false,
      ortGraphOpt: 'basic',
    });
  });

  it('reads null for every session-option lever when the params are absent', async () => {
    window.history.replaceState({}, '', '/?');
    const { readActiveLevers } = await import('../sustained-probe');
    const levers = readActiveLevers();
    expect(levers.ortArena).toBeNull();
    expect(levers.ortMemPattern).toBeNull();
    expect(levers.ortGraphOpt).toBeNull();
  });
});

describe('bytesToMB', () => {
  it('converts bytes to MB rounded to 1 dp', () => {
    expect(bytesToMB(1_048_576)).toBe(1);
    expect(bytesToMB(1_572_864)).toBe(1.5);
  });

  it('returns null for non-finite / missing input', () => {
    expect(bytesToMB(null)).toBeNull();
    expect(bytesToMB(undefined)).toBeNull();
    expect(bytesToMB(Number.NaN)).toBeNull();
  });
});

describe('detectMemoryApis + readMemorySample', () => {
  it('reads performance.memory when present', () => {
    const perf = {
      memory: { usedJSHeapSize: 2_097_152, totalJSHeapSize: 4_194_304, jsHeapSizeLimit: 8_388_608 },
    };
    expect(detectMemoryApis(perf)).toEqual({ performanceMemory: true, measureUserAgent: false });
    const sample = readMemorySample(1234, 2, perf);
    expect(sample).toEqual({
      atMs: 1234,
      turn: 2,
      usedJSHeapMB: 2,
      totalJSHeapMB: 4,
      jsHeapLimitMB: 8,
      measuredUAMB: null,
    });
  });

  it('is null-safe when no memory API exists (WebKit / Firefox)', () => {
    expect(detectMemoryApis({})).toEqual({ performanceMemory: false, measureUserAgent: false });
    const sample = readMemorySample(0, 0, {});
    expect(sample.usedJSHeapMB).toBeNull();
    expect(sample.totalJSHeapMB).toBeNull();
    expect(sample.jsHeapLimitMB).toBeNull();
  });

  it('detects measureUserAgentSpecificMemory', () => {
    const perf = { measureUserAgentSpecificMemory: async () => ({ bytes: 0 }) };
    expect(detectMemoryApis(perf).measureUserAgent).toBe(true);
  });
});

describe('measureUserAgentMemoryMB', () => {
  it('returns MB when the API resolves', async () => {
    const perf = { measureUserAgentSpecificMemory: async () => ({ bytes: 10_485_760 }) };
    expect(await measureUserAgentMemoryMB(perf)).toBe(10);
  });

  it('returns null when the API is absent', async () => {
    expect(await measureUserAgentMemoryMB({})).toBeNull();
  });

  it('swallows a rejection (thrown without cross-origin isolation)', async () => {
    const perf = {
      measureUserAgentSpecificMemory: async () => {
        throw new Error('SecurityError');
      },
    };
    expect(await measureUserAgentMemoryMB(perf)).toBeNull();
  });
});

describe('peakUsedJSHeap', () => {
  it('returns the max usedJSHeapMB across samples', () => {
    const samples: MemorySample[] = [
      { atMs: 0, turn: 0, usedJSHeapMB: 100, totalJSHeapMB: null, jsHeapLimitMB: null, measuredUAMB: null },
      { atMs: 1, turn: 1, usedJSHeapMB: 250, totalJSHeapMB: null, jsHeapLimitMB: null, measuredUAMB: null },
      { atMs: 2, turn: 2, usedJSHeapMB: 180, totalJSHeapMB: null, jsHeapLimitMB: null, measuredUAMB: null },
    ];
    expect(peakUsedJSHeap(samples)).toBe(250);
  });

  it('returns null when no sample has a heap reading', () => {
    const samples: MemorySample[] = [
      { atMs: 0, turn: 0, usedJSHeapMB: null, totalJSHeapMB: null, jsHeapLimitMB: null, measuredUAMB: null },
    ];
    expect(peakUsedJSHeap(samples)).toBeNull();
  });
});

describe('marker lifecycle', () => {
  it('round-trips a marker through localStorage', () => {
    writeMarker(MARKER);
    expect(readMarker()).toEqual(MARKER);
  });

  it('updates only the completed-turn count', () => {
    writeMarker(MARKER);
    updateMarkerProgress(5);
    expect(readMarker()?.turnsCompleted).toBe(5);
  });

  it('clears the marker', () => {
    writeMarker(MARKER);
    clearMarker();
    expect(readMarker()).toBeNull();
  });

  it('returns null for malformed marker JSON', () => {
    localStorage.setItem('eco-sustained-probe-marker-v1', '{not json');
    expect(readMarker()).toBeNull();
  });
});

describe('orphaned-marker recovery (tab-kill evidence)', () => {
  it('reconstructs a killed record carrying the turn it died on', () => {
    const record = reconstructKilledRecord(MARKER);
    expect(record.outcome).toBe('killed');
    expect(record.turnsCompleted).toBe(3);
    expect(record.turnsRequested).toBe(6);
    expect(record.reconstructedFromMarker).toBe(true);
    expect(record.error).toContain('3/6');
    expect(record.levers).toEqual(MARKER.levers);
  });

  it('recoverOrphanedMarker records the kill and clears the marker', () => {
    writeMarker(MARKER);
    const recovered = recoverOrphanedMarker();
    expect(recovered?.outcome).toBe('killed');
    expect(readMarker()).toBeNull();
    const stored = loadSustainedProbes();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe('killed');
  });

  it('recoverOrphanedMarker is a no-op with no marker (clean prior run)', () => {
    expect(recoverOrphanedMarker()).toBeNull();
    expect(loadSustainedProbes()).toHaveLength(0);
  });
});

describe('record store', () => {
  const record: SustainedProbeRecord = {
    version: 1,
    recordedAt: '2026-07-15T00:00:00.000Z',
    modelId: 'candidate/qwen3.5-2b-onnx',
    backend: 'wasm',
    outcome: 'completed',
    turnsRequested: 6,
    turnsCompleted: 6,
    targetTokensPerTurn: 200,
    levers: { ortArtifact: null, numThreads: null, forceWasm: false },
    crossOriginIsolated: true,
    memoryApi: { performanceMemory: true, measureUserAgent: true },
    turns: [],
    samples: [],
    peakUsedJSHeapMB: 512,
    error: null,
  };

  it('persists and reloads records', () => {
    recordSustainedProbe(record);
    const loaded = loadSustainedProbes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.peakUsedJSHeapMB).toBe(512);
  });

  it('drops malformed records on load', () => {
    localStorage.setItem('eco-sustained-probe-records-v1', JSON.stringify([{ nope: true }, record]));
    expect(loadSustainedProbes()).toHaveLength(1);
  });
});
