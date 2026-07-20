// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bytesToMB,
  clearMarker,
  clearSustainedProbes,
  detectMemoryApis,
  detectWebGpuApi,
  loadSustainedProbes,
  measureUserAgentMemoryMB,
  peakUsedJSHeap,
  readMarker,
  readMemorySample,
  reconstructKilledRecord,
  recordSustainedProbe,
  recoverOrphanedMarker,
  updateMarker,
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

describe('detectWebGpuApi', () => {
  it('is false in jsdom, where navigator.gpu is absent', () => {
    // No WebGPU in jsdom — the null-safe check must simply report absence.
    expect(detectWebGpuApi()).toBe(false);
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

  it('round-trips the phase / backend / webgpuApiPresent fields', () => {
    const phased: SustainedProbeMarker = {
      ...MARKER,
      phase: 'turn-in-flight',
      backend: 'webgpu',
      webgpuApiPresent: true,
    };
    writeMarker(phased);
    expect(readMarker()).toEqual(phased);
  });

  it('round-trips the contextMode field', () => {
    const fresh: SustainedProbeMarker = { ...MARKER, contextMode: 'fresh' };
    writeMarker(fresh);
    expect(readMarker()?.contextMode).toBe('fresh');
  });

  it('round-trips the idle-observe fields', () => {
    const observed: SustainedProbeMarker = {
      ...MARKER,
      idleObserveSeconds: 120,
      idleObservedSeconds: 3,
      heartbeat: 'compute',
    };
    writeMarker(observed);
    const read = readMarker();
    expect(read?.idleObserveSeconds).toBe(120);
    expect(read?.idleObservedSeconds).toBe(3);
    expect(read?.heartbeat).toBe('compute');
  });

  it('round-trips the cooldownMs field', () => {
    const cooled: SustainedProbeMarker = { ...MARKER, cooldownMs: 5000 };
    writeMarker(cooled);
    expect(readMarker()?.cooldownMs).toBe(5000);
  });

  it('reads a legacy marker (no phase field) as valid', () => {
    // MARKER carries no phase/backend/webgpuApiPresent — the shape older builds
    // wrote. isMarker must not require the new fields.
    writeMarker(MARKER);
    const read = readMarker();
    expect(read).toEqual(MARKER);
    expect(read?.phase).toBeUndefined();
    // Absent contextMode on a legacy marker means 'growing' by convention.
    expect(read?.contextMode).toBeUndefined();
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

describe('updateMarker', () => {
  it('patches only the given fields and preserves the rest', () => {
    writeMarker(MARKER);
    updateMarker({ turnsCompleted: 5, phase: 'turn-complete' });
    const marker = readMarker();
    expect(marker?.turnsCompleted).toBe(5);
    expect(marker?.phase).toBe('turn-complete');
    // Untouched fields survive the patch.
    expect(marker?.modelId).toBe(MARKER.modelId);
    expect(marker?.levers).toEqual(MARKER.levers);
  });

  it('records the confirmed backend without disturbing the phase', () => {
    writeMarker({ ...MARKER, phase: 'loading' });
    updateMarker({ backend: 'webgpu' });
    const marker = readMarker();
    expect(marker?.backend).toBe('webgpu');
    expect(marker?.phase).toBe('loading');
  });

  it('ticks idleObservedSeconds without disturbing the observe cell', () => {
    writeMarker({ ...MARKER, phase: 'idle-observe', idleObserveSeconds: 120, heartbeat: 'raf' });
    updateMarker({ idleObservedSeconds: 4 });
    const marker = readMarker();
    expect(marker?.idleObservedSeconds).toBe(4);
    expect(marker?.idleObserveSeconds).toBe(120);
    expect(marker?.heartbeat).toBe('raf');
    expect(marker?.phase).toBe('idle-observe');
  });

  it('is a no-op when no marker exists', () => {
    updateMarker({ turnsCompleted: 2 });
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

  it('uses the legacy wording for a marker with no phase', () => {
    // MARKER predates the phase field — its death point is only the turn count.
    expect(reconstructKilledRecord(MARKER).error).toBe(
      'Tab was killed during a sustained probe at turn 3/6.',
    );
  });

  it("reads 'died during load' for a loading-phase kill", () => {
    const record = reconstructKilledRecord({ ...MARKER, phase: 'loading', backend: null });
    expect(record.error).toBe('Tab was killed during model load — the model never finished loading.');
  });

  it('appends the WebGPU-present hint when the backend never confirmed', () => {
    const record = reconstructKilledRecord({
      ...MARKER,
      phase: 'loading',
      backend: null,
      webgpuApiPresent: true,
    });
    expect(record.error).toContain('during model load');
    expect(record.error).toContain('WebGPU API was present at start (backend never confirmed).');
  });

  it('appends the WebGPU-absent hint when the backend never confirmed', () => {
    const record = reconstructKilledRecord({
      ...MARKER,
      phase: 'loading',
      backend: null,
      webgpuApiPresent: false,
    });
    expect(record.error).toContain('WebGPU API was absent at start (backend never confirmed).');
  });

  it('omits the WebGPU hint when presence is unknown (null)', () => {
    const record = reconstructKilledRecord({
      ...MARKER,
      phase: 'loading',
      backend: null,
      webgpuApiPresent: null,
    });
    expect(record.error).toBe('Tab was killed during model load — the model never finished loading.');
  });

  it('reports the in-flight turn (N+1) for a turn-in-flight kill', () => {
    // turnsCompleted 3 ⇒ it died generating turn 4.
    const record = reconstructKilledRecord({ ...MARKER, phase: 'turn-in-flight' });
    expect(record.error).toBe('Tab was killed while generating turn 4/6 — the model loaded fine.');
  });

  it('reports the last completed turn for a turn-complete kill', () => {
    const record = reconstructKilledRecord({ ...MARKER, phase: 'turn-complete' });
    expect(record.error).toBe('Tab was killed between turns, after completing turn 3/6.');
  });

  it('carries the marker backend onto the reconstructed record', () => {
    const record = reconstructKilledRecord({ ...MARKER, phase: 'turn-in-flight', backend: 'webgpu' });
    expect(record.backend).toBe('webgpu');
  });

  it('carries the marker context mode onto the reconstructed record', () => {
    // A killed run's record exists ONLY via reconstruction — dropping the mode
    // here mislabeled every tab-kill tombstone as 'growing' (s35 field report).
    const record = reconstructKilledRecord({ ...MARKER, phase: 'turn-in-flight', contextMode: 'fresh' });
    expect(record.contextMode).toBe('fresh');
  });

  it('leaves context mode absent when reconstructing a legacy marker', () => {
    const record = reconstructKilledRecord(MARKER);
    expect(record.contextMode).toBeUndefined();
  });

  it('carries the marker cooldownMs onto the reconstructed record', () => {
    // Like contextMode, cooldownMs names the cell being measured — a killed
    // run's record exists ONLY via reconstruction, so dropping it here would
    // mislabel which cooldown cell died (the #41 lesson, generalized).
    const record = reconstructKilledRecord({ ...MARKER, phase: 'turn-in-flight', cooldownMs: 5000 });
    expect(record.cooldownMs).toBe(5000);
  });

  it('leaves cooldownMs absent when reconstructing a legacy marker', () => {
    const record = reconstructKilledRecord(MARKER);
    expect(record.cooldownMs).toBeUndefined();
  });

  it('reports the idle-observe kill with survived seconds and heartbeat', () => {
    // The s37 field kill: a SUCCESSFUL run, then killed seconds into the
    // post-run quiescence. The tombstone must carry the time-to-kill.
    const record = reconstructKilledRecord({
      ...MARKER,
      phase: 'idle-observe',
      turnsCompleted: 6,
      idleObserveSeconds: 120,
      idleObservedSeconds: 5,
      heartbeat: 'none',
    });
    expect(record.error).toBe(
      'Tab was killed during the post-run idle-observe window — survived ~5s of 120s at heartbeat=none, after completing all 6/6 turns.',
    );
  });

  it('carries the idle-observe cell fields onto the reconstructed record', () => {
    // The observe cell is named by window + heartbeat + survival — all three
    // must survive reconstruction (the #41 cell-naming invariant).
    const record = reconstructKilledRecord({
      ...MARKER,
      phase: 'idle-observe',
      idleObserveSeconds: 120,
      idleObservedSeconds: 7,
      heartbeat: 'raf',
    });
    expect(record.idleObserveSeconds).toBe(120);
    expect(record.idleObservedSeconds).toBe(7);
    expect(record.heartbeat).toBe('raf');
  });

  it('leaves the idle-observe fields absent when reconstructing a legacy marker', () => {
    const record = reconstructKilledRecord(MARKER);
    expect(record.idleObserveSeconds).toBeUndefined();
    expect(record.idleObservedSeconds).toBeUndefined();
    expect(record.heartbeat).toBeUndefined();
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

  it('round-trips the contextMode field', () => {
    recordSustainedProbe({ ...record, contextMode: 'fresh' });
    expect(loadSustainedProbes().at(-1)?.contextMode).toBe('fresh');
  });

  it('round-trips the cooldownMs field', () => {
    recordSustainedProbe({ ...record, cooldownMs: 5000 });
    expect(loadSustainedProbes().at(-1)?.cooldownMs).toBe(5000);
  });

  it('round-trips the uaMeasureTimedOut flag', () => {
    recordSustainedProbe({ ...record, uaMeasureTimedOut: true });
    expect(loadSustainedProbes().at(-1)?.uaMeasureTimedOut).toBe(true);
  });

  it('reads a legacy record (no contextMode) as valid', () => {
    // `record` carries no contextMode — isRecord must not require it.
    recordSustainedProbe(record);
    const loaded = loadSustainedProbes().at(-1);
    expect(loaded?.contextMode).toBeUndefined();
  });
});
