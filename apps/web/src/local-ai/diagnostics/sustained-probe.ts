// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Sustained-chat memory probe — measurement tooling for the per-device serving
 * matrix.
 *
 * The real-device spike showed WebKit builds a 2–4.5 GB working set for a 0.6 B
 * model and kills the tab under SUSTAINED chat, while the one-shot smoke gate
 * passed the same model. This probe reproduces that pressure on demand: it runs
 * N sequential generations whose prompts build on prior output so context/KV
 * genuinely grow, sampling memory throughout, and records the result as a
 * shareable diagnostic entry.
 *
 * Two memory sources, both feature-detected and null-safe:
 *   - `performance.memory` (Chromium-only, non-standard): usedJSHeapSize etc.
 *   - `performance.measureUserAgentSpecificMemory()` (crossOriginIsolated
 *     Chromium): a truer cross-realm total, sampled once per turn (it is slow).
 * WebKit and Firefox expose NEITHER — for those the probe's value is the
 * CRASH-EVIDENCE MARKER: a localStorage flag written at start and cleared on
 * clean completion. If the tab is killed mid-run the marker survives, so the
 * next mount can report "killed at turn X/N" — the only tab-kill signal WebKit
 * gives us.
 *
 * This is measurement-scoped tooling. The marker here is NOT the serving-path
 * gate (lifecycle/smoke.ts) — it never blocks a real user's model load.
 */

import {
  hasWebGpuApi,
  readForcedOrtArtifact,
  readForcedThreads,
  readForcedWasm,
  readForcedOrtArena,
  readForcedOrtMemPattern,
  readForcedOrtGraphOpt,
  type OrtGraphOptLevel,
} from '../device/profile';
import { safeStorage } from '../../lib/local-storage';
import type { OrtArtifact } from '../runtime/ort-artifact';

// ─── Storage keys ────────────────────────────────────────────────────────────

/** Crash-evidence marker: present ⇒ a probe is running (or was killed mid-run). */
const MARKER_KEY = 'eco-sustained-probe-marker-v1';
/** Completed / reconstructed probe records (FIFO, capped). */
const RECORDS_KEY = 'eco-sustained-probe-records-v1';
const MAX_RECORDS = 20;

export const SUSTAINED_PROBE_DEFAULT_TURNS = 6;
export const SUSTAINED_PROBE_DEFAULT_TARGET_TOKENS = 200;
/** Memory heap sampled at this cadence during a run. */
export const SUSTAINED_PROBE_SAMPLE_INTERVAL_MS = 1_000;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The measurement levers a probe ran under (echoed for the shared JSON).
 *  The three ORT session-option fields are optional so records written before
 *  the s32 seam parse unchanged. */
export type SustainedProbeLevers = {
  ortArtifact: OrtArtifact | null;
  numThreads: number | null;
  forceWasm: boolean;
  ortArena?: boolean | null;
  ortMemPattern?: boolean | null;
  ortGraphOpt?: OrtGraphOptLevel | null;
};

/** Which memory APIs the current environment exposes. */
export type MemoryApiSupport = {
  performanceMemory: boolean;
  measureUserAgent: boolean;
};

/** One heap sample. Every numeric field is MB, or null when unavailable. */
export type MemorySample = {
  /** ms from probe start. */
  atMs: number;
  /** 0 before the first turn; otherwise the turn index just completed. */
  turn: number;
  usedJSHeapMB: number | null;
  totalJSHeapMB: number | null;
  jsHeapLimitMB: number | null;
  /** performance.measureUserAgentSpecificMemory() total, when available. */
  measuredUAMB: number | null;
};

/** Per-turn outcome. */
export type SustainedProbeTurn = {
  turn: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Full rendered prompt length this turn — the growing context. */
  cumulativeContextTokens: number | null;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  error: string | null;
};

export type SustainedProbeOutcome = 'completed' | 'killed' | 'error';

export type SustainedProbeRecord = {
  version: 1;
  recordedAt: string; // ISO
  modelId: string;
  backend: string | null;
  outcome: SustainedProbeOutcome;
  turnsRequested: number;
  turnsCompleted: number;
  targetTokensPerTurn: number;
  levers: SustainedProbeLevers;
  crossOriginIsolated: boolean;
  memoryApi: MemoryApiSupport;
  turns: SustainedProbeTurn[];
  samples: MemorySample[];
  peakUsedJSHeapMB: number | null;
  error: string | null;
  /** True when this record was reconstructed from an orphaned (tab-killed) marker. */
  reconstructedFromMarker?: boolean;
};

/** Where a live probe currently is. A surviving (orphaned) marker's phase IS the
 *  death point — the only phase evidence WebKit gives us. */
export type SustainedProbeMarkerPhase = 'loading' | 'turn-in-flight' | 'turn-complete';

/** The live marker written at start and updated per turn. */
export type SustainedProbeMarker = {
  startedAt: string; // ISO
  modelId: string;
  turnsRequested: number;
  targetTokensPerTurn: number;
  levers: SustainedProbeLevers;
  /** Turns fully completed so far — the "killed at turn X" evidence. */
  turnsCompleted: number;
  /** Phase at last write. Absent on markers from builds before this field —
   *  those reconstruct with the legacy "killed at turn X" wording. */
  phase?: SustainedProbeMarkerPhase;
  /** Confirmed backend once the model load settles; null before. */
  backend?: string | null;
  /** Whether the WebGPU API existed at probe start — the best available hint
   *  at which EP the load was attempting when a kill precedes backend
   *  confirmation. Presence ≠ used: it is evidence, not a conclusion. */
  webgpuApiPresent?: boolean | null;
};

// ─── Memory sampling (pure, feature-detected) ────────────────────────────────

const BYTES_PER_MB = 1_048_576;

/** Bytes → MB, rounded to 1 dp; null passes through. */
export function bytesToMB(bytes: number | null | undefined): number | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
}

type PerformanceMemoryLike = {
  memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number };
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
};

/** Detect which memory APIs `perf` exposes (defaults to global performance). */
export function detectMemoryApis(perf: PerformanceMemoryLike | undefined = safePerformance()): MemoryApiSupport {
  return {
    performanceMemory: !!perf && typeof perf.memory === 'object',
    measureUserAgent: !!perf && typeof perf.measureUserAgentSpecificMemory === 'function',
  };
}

/** True when the WebGPU API exists — recorded on the marker at probe start as
 *  the likely-attempted EP when a kill precedes backend confirmation. Presence
 *  is a hint, not proof the EP was actually used. Delegates to device/profile's
 *  `hasWebGpuApi` — the module chartered to own WebGPU access (Invariant 5). */
export function detectWebGpuApi(): boolean {
  return hasWebGpuApi();
}

/**
 * Read a synchronous heap sample from `performance.memory`. `measuredUAMB` is
 * left null here — the async measureUserAgentSpecificMemory() is sampled
 * separately, per turn. All fields null on WebKit/Firefox.
 */
export function readMemorySample(
  atMs: number,
  turn: number,
  perf: PerformanceMemoryLike | undefined = safePerformance(),
): MemorySample {
  const mem = perf?.memory;
  return {
    atMs,
    turn,
    usedJSHeapMB: bytesToMB(mem?.usedJSHeapSize),
    totalJSHeapMB: bytesToMB(mem?.totalJSHeapSize),
    jsHeapLimitMB: bytesToMB(mem?.jsHeapSizeLimit),
    measuredUAMB: null,
  };
}

/**
 * Await `performance.measureUserAgentSpecificMemory()` and return its total in
 * MB, or null when the API is absent or rejects (it throws without cross-origin
 * isolation). Never throws — a measurement failure must not fail the probe.
 */
export async function measureUserAgentMemoryMB(
  perf: PerformanceMemoryLike | undefined = safePerformance(),
): Promise<number | null> {
  const fn = perf?.measureUserAgentSpecificMemory;
  if (typeof fn !== 'function') return null;
  try {
    const result = await fn.call(perf);
    return bytesToMB(result.bytes);
  } catch {
    return null;
  }
}

/** Peak `usedJSHeapMB` across samples, or null when none were captured. */
export function peakUsedJSHeap(samples: readonly MemorySample[]): number | null {
  let peak: number | null = null;
  for (const s of samples) {
    if (s.usedJSHeapMB != null && (peak == null || s.usedJSHeapMB > peak)) {
      peak = s.usedJSHeapMB;
    }
  }
  return peak;
}

function safePerformance(): PerformanceMemoryLike | undefined {
  return typeof performance !== 'undefined' ? (performance as PerformanceMemoryLike) : undefined;
}

// ─── Levers snapshot ─────────────────────────────────────────────────────────

/** Read the currently-active measurement levers from the URL. */
export function readActiveLevers(): SustainedProbeLevers {
  return {
    ortArtifact: readForcedOrtArtifact(),
    numThreads: readForcedThreads(),
    forceWasm: readForcedWasm(),
    ortArena: readForcedOrtArena(),
    ortMemPattern: readForcedOrtMemPattern(),
    ortGraphOpt: readForcedOrtGraphOpt(),
  };
}

// ─── Crash-evidence marker (localStorage) ────────────────────────────────────

export function writeMarker(marker: SustainedProbeMarker): void {
  safeStorage.set(MARKER_KEY, JSON.stringify(marker));
}

/** Patch the live marker in place (best-effort; no-op when absent). Called at
 *  every phase transition so an abrupt tab kill leaves the freshest evidence. */
export function updateMarker(
  patch: Partial<Pick<SustainedProbeMarker, 'phase' | 'backend' | 'turnsCompleted'>>,
): void {
  const marker = readMarker();
  if (!marker) return;
  writeMarker({ ...marker, ...patch });
}

export function readMarker(): SustainedProbeMarker | null {
  const raw = safeStorage.get(MARKER_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearMarker(): void {
  safeStorage.remove(MARKER_KEY);
}

function isMarker(value: unknown): value is SustainedProbeMarker {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.startedAt === 'string' &&
    typeof v.modelId === 'string' &&
    typeof v.turnsRequested === 'number' &&
    typeof v.turnsCompleted === 'number'
  );
}

/**
 * Turn an orphaned marker into a `killed` record. An orphaned marker means a
 * probe started but never cleared its marker — i.e. the tab was killed
 * mid-run, exactly the WebKit failure the smoke gate misses.
 */
export function reconstructKilledRecord(marker: SustainedProbeMarker): SustainedProbeRecord {
  return {
    version: 1,
    recordedAt: new Date().toISOString(),
    modelId: marker.modelId,
    backend: marker.backend ?? null,
    outcome: 'killed',
    turnsRequested: marker.turnsRequested,
    turnsCompleted: marker.turnsCompleted,
    targetTokensPerTurn: marker.targetTokensPerTurn,
    levers: marker.levers,
    crossOriginIsolated: safeCrossOriginIsolated(),
    memoryApi: detectMemoryApis(),
    turns: [],
    samples: [],
    peakUsedJSHeapMB: null,
    error: killedDeathPoint(marker),
    reconstructedFromMarker: true,
  };
}

/**
 * The death-point message for a killed record, selected by the marker's phase —
 * the phase at the last synchronous write IS where the tab died. Legacy markers
 * (no phase) keep the original turn-count wording so old evidence still reads.
 */
function killedDeathPoint(marker: SustainedProbeMarker): string {
  const { phase, turnsCompleted, turnsRequested } = marker;
  switch (phase) {
    case 'loading': {
      let msg = 'Tab was killed during model load — the model never finished loading.';
      // Before the backend confirms, whether the WebGPU API existed is the only
      // hint at which EP the load was attempting — evidence, not a conclusion.
      if (marker.backend == null && marker.webgpuApiPresent != null) {
        msg += ` WebGPU API was ${marker.webgpuApiPresent ? 'present' : 'absent'} at start (backend never confirmed).`;
      }
      return msg;
    }
    case 'turn-in-flight':
      return `Tab was killed while generating turn ${turnsCompleted + 1}/${turnsRequested} — the model loaded fine.`;
    case 'turn-complete':
      return `Tab was killed between turns, after completing turn ${turnsCompleted}/${turnsRequested}.`;
    default:
      return `Tab was killed during a sustained probe at turn ${turnsCompleted}/${turnsRequested}.`;
  }
}

/**
 * On mount: if a marker is orphaned, record a `killed` entry and clear it.
 * Returns the reconstructed record so the panel can surface it immediately, or
 * null when there was no orphaned marker.
 */
export function recoverOrphanedMarker(): SustainedProbeRecord | null {
  const marker = readMarker();
  if (!marker) return null;
  const record = reconstructKilledRecord(marker);
  recordSustainedProbe(record);
  clearMarker();
  return record;
}

// ─── Record store (localStorage, FIFO) ───────────────────────────────────────

export function recordSustainedProbe(record: SustainedProbeRecord): void {
  const current = loadSustainedProbes();
  current.push(record);
  safeStorage.set(RECORDS_KEY, JSON.stringify(current.slice(-MAX_RECORDS)));
}

export function loadSustainedProbes(): SustainedProbeRecord[] {
  const raw = safeStorage.get(RECORDS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

export function clearSustainedProbes(): void {
  safeStorage.remove(RECORDS_KEY);
}

function isRecord(value: unknown): value is SustainedProbeRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.modelId === 'string' &&
    typeof v.turnsRequested === 'number' &&
    Array.isArray(v.turns) &&
    Array.isArray(v.samples)
  );
}

function safeCrossOriginIsolated(): boolean {
  return typeof globalThis !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

// ─── Prompt building ─────────────────────────────────────────────────────────

/**
 * Build the next turn's user message so the conversation genuinely grows: each
 * turn asks the model to expand on its own prior answer, so cumulative context
 * (and KV) climbs turn over turn, mimicking real sustained chat.
 */
export function nextTurnPrompt(turn: number, priorAssistant: string | null): string {
  if (turn === 0 || !priorAssistant) {
    return 'Tell me an original short story about a lighthouse keeper. Write at least three paragraphs.';
  }
  const tail = priorAssistant.slice(-400);
  return `Continue the story from here, adding at least two more paragraphs and introducing a new character:\n\n"${tail}"`;
}
