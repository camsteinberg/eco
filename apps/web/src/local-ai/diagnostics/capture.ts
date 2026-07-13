// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Structured diagnostic capture for local-AI smoke verification.
 *
 * Parallel to the evidence ledger (`evidence/ledger.ts`), this module
 * records detailed failure diagnostics — error messages, stacks, load
 * timings, WebGPU state, cache probes — so we can see *why* a model
 * fails, not just *that* it failed.
 *
 * Storage:
 *
 *   - localStorage key `eco-local-ai-diagnostics-v1` holds a JSON array
 *     of entries. Self-heals on malformed data: a parse failure clears
 *     the key and starts fresh.
 *   - Capped at MAX_ENTRIES (FIFO — oldest evicted first) to bound
 *     localStorage usage.
 *   - Tab-crash safety is implicit: localStorage writes are atomic per
 *     key, so a partial entry can't land.
 *
 * Invariant 5: all navigator.* access is delegated to `device/profile.ts`
 * via `getDiagnosticEnv()`. This module MUST NOT reference navigator
 * globals directly.
 */

import type { RuntimeBackend } from '../runtime/types';
import { getDiagnosticEnv } from '../device/profile';
import { safeStorage } from '../../lib/local-storage';

const STORAGE_KEY = 'eco-local-ai-diagnostics-v1';
const MAX_ENTRIES = 50;
/**
 * v2 (slice 3): adds `resolvedBackend` — the execution provider a load actually
 * resolved to (webgpu can silently fall back to wasm). This is a best-effort
 * DEBUG store (FIFO, no recommender consumption), so a schema bump drops the
 * handful of older entries rather than migrating them.
 */
const SCHEMA_VERSION = 2;

// ─── Types ────────────────────────────────────────────────────────────────

export type DiagnosticOutcome = 'smoke-pass' | 'smoke-fail';

export type DiagnosticPhase =
  | 'load-start'
  | 'load-finish'
  | 'load-fail'
  | 'first-token'
  | 'generation-complete'
  | 'generation-fail'
  | 'webgpu-probe'
  | 'cache-probe'
  | 'runtime-import';

export type LocalAiDiagnostic = {
  schemaVersion: 2;
  recordedAt: string; // ISO
  modelId: string;
  profileKey: string; // from classifyDeviceClass()
  // `'webllm'` is a historical persisted value — devices hold diagnostic records
  // from before the WebLLM runtime was retired (2026-07-10). Kept so old records
  // still parse; no live catalog model produces it now.
  runtimeAdapter: 'webllm' | 'transformers' | 'litert' | 'unknown';
  /**
   * The execution provider the model load ACTUALLY resolved to. Distinct from
   * device capability (`webgpu.available`): a webgpu-capable device can still
   * run on wasm (adapter fallback). `null`/absent when no load resolved for
   * this model (pre-load failures).
   */
  resolvedBackend?: RuntimeBackend | null;
  outcome: DiagnosticOutcome;
  durations: {
    loadMs: number | null; // null if load failed
    firstTokenMs: number | null; // null if never got a token
    totalMs: number;
  };
  tokensReceived: number;
  error: { message: string; name?: string; stack?: string } | null;
  webgpu: {
    available: boolean;
    adapterRequested: boolean;
    adapterError?: string;
    features?: string[];
    limits?: Record<string, number>;
  };
  cache: { hit: boolean; fileCount?: number; sizeBytes?: number; files?: string[]; probedAt: string } | null;
  env: {
    userAgent: string;
    deviceMemoryGB: number | null;
    hardwareConcurrency: number | null;
    architecture?: string;
    platform?: string;
    platformVersion?: string;
    uaModel?: string;
    bitness?: string;
  };
  events: { at: number; phase: DiagnosticPhase; note?: string }[]; // ms from start
};

// ─── I/O helpers ──────────────────────────────────────────────────────────

export function recordDiagnostic(entry: LocalAiDiagnostic): void {
  if (typeof localStorage === 'undefined') return;
  const current = loadDiagnostics();
  current.push(entry);
  // FIFO: keep newest MAX_ENTRIES.
  const trimmed = current.slice(-MAX_ENTRIES);
  writeDiagnostics(trimmed);
}

export function loadDiagnostics(): LocalAiDiagnostic[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = safeStorage.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      safeRemove();
      return [];
    }
    return parsed.filter(isValidDiagnostic);
  } catch {
    safeRemove();
    return [];
  }
}

export function clearDiagnostics(): void {
  if (typeof localStorage === 'undefined') return;
  safeRemove();
}

export type DiagnosticDump = {
  schemaVersion: number;
  dumpedAt: string;
  env: {
    userAgent: string;
    deviceMemoryGB: number | null;
    hardwareConcurrency: number | null;
    architecture?: string;
    platform?: string;
    platformVersion?: string;
    uaModel?: string;
    bitness?: string;
  };
  entries: LocalAiDiagnostic[];
};

export async function exportDiagnostics(): Promise<string> {
  const entries = loadDiagnostics();
  const dump: DiagnosticDump = {
    schemaVersion: SCHEMA_VERSION,
    dumpedAt: new Date().toISOString(),
    env: await getDiagnosticEnv(),
    entries,
  };
  return JSON.stringify(dump, null, 2);
}

// ─── Internal ─────────────────────────────────────────────────────────────

function writeDiagnostics(entries: LocalAiDiagnostic[]): void {
  if (typeof localStorage === 'undefined') return;
  // safeStorage drops the write on quota/serialization failure rather than throw.
  safeStorage.set(STORAGE_KEY, JSON.stringify(entries));
}

function safeRemove(): void {
  safeStorage.remove(STORAGE_KEY);
}

function isValidDiagnostic(value: unknown): value is LocalAiDiagnostic {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof v.modelId !== 'string') return false;
  if (typeof v.profileKey !== 'string') return false;
  if (typeof v.recordedAt !== 'string') return false;
  if (v.outcome !== 'smoke-pass' && v.outcome !== 'smoke-fail') return false;
  if (typeof v.runtimeAdapter !== 'string') return false;
  if (typeof v.durations !== 'object' || v.durations === null) return false;
  if (typeof v.tokensReceived !== 'number') return false;
  return true;
}
