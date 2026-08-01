// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * localStorage persistence for eval-harness runs.
 *
 * Mirrors `diagnostics/capture.ts`: a versioned key holding a JSON array,
 * FIFO-capped, self-healing on malformed data, with an `exportEvalRuns()` JSON
 * dump. Pure I/O over `safeStorage` — no browser/model/DOM beyond storage.
 *
 *   - localStorage key `eco-local-ai-eval-v1` holds a JSON array of `EvalRun`s.
 *   - A parse failure (or non-array) clears the key and starts fresh.
 *   - Capped at `MAX_RUNS` (FIFO — oldest evicted first) to bound usage.
 *
 * `setJudgeScores` exists so a blind human/LLM judge can fill in
 * coherence/taskFit on an already-persisted run (e.g. during an A/B review)
 * without re-running generation.
 */

import { safeStorage } from '../../lib/local-storage';
import type { EvalCategory, EvalRun, EvalRunDevice, EvalRuntimeAdapter, JudgeDimension } from './types';

const STORAGE_KEY = 'eco-local-ai-eval-v1';
const SCHEMA_VERSION = 1;
/** FIFO cap. Runs are large (many results); 20 keeps localStorage bounded. */
export const MAX_RUNS = 20;

const EVAL_CATEGORIES: ReadonlySet<EvalCategory> = new Set([
  'factual-known',
  'math',
  'reasoning',
  'code',
  'summarization',
  'instruction-following',
  'uncertainty',
  'stop-behavior',
  'conversation',
  'format-json',
  'richness',
  'answer-shape',
  'everyday-use',
  'everyday-conversation',
  'captured',
]);

const RUNTIME_ADAPTERS: ReadonlySet<EvalRuntimeAdapter> = new Set([
  'transformers',
  // Historical persisted value: pre-2026-07-10 eval records may carry it. The
  // WebLLM runtime is retired; kept so old records still parse/round-trip.
  'webllm',
  'litert',
  'unknown',
]);

// ─── I/O ────────────────────────────────────────────────────────────────

/** Persist a run. Pushes, trims to `MAX_RUNS` (FIFO), and writes. */
export function saveEvalRun(run: EvalRun): void {
  if (typeof localStorage === 'undefined') return;
  const current = loadEvalRuns();
  current.push(run);
  // FIFO: keep the newest MAX_RUNS.
  const trimmed = current.slice(-MAX_RUNS);
  writeRuns(trimmed);
}

/**
 * Load all persisted runs. Self-heals: a malformed/non-array payload clears the
 * key and returns []. Individual invalid entries are filtered out (so one bad
 * run can't poison the rest).
 */
export function loadEvalRuns(): EvalRun[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = safeStorage.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      safeRemove();
      return [];
    }
    return parsed.filter(isValidEvalRun);
  } catch {
    safeRemove();
    return [];
  }
}

/** Look up a single run by id, or `null` if absent. */
export function getEvalRun(runId: string): EvalRun | null {
  return loadEvalRuns().find((r) => r.runId === runId) ?? null;
}

/** All runs sharing a label (e.g. every 'baseline' run). Insertion order. */
export function getEvalRunsByLabel(label: string): EvalRun[] {
  return loadEvalRuns().filter((r) => r.label === label);
}

/** Remove all persisted runs. */
export function clearEvalRuns(): void {
  if (typeof localStorage === 'undefined') return;
  safeRemove();
}

/**
 * Fill judge scores (coherence/taskFit) on matching results of a persisted run,
 * then re-persist. Matches each update by (promptId, modelId). Only the fields
 * provided are written, so a partial update leaves the other judge dim alone.
 * Returns `true` if the run existed (and was updated), `false` otherwise.
 */
export function setJudgeScores(
  runId: string,
  updates: {
    promptId: string;
    modelId: string;
    sampleIndex?: number;
    coherence?: number;
    taskFit?: number;
  }[],
): boolean {
  if (typeof localStorage === 'undefined') return false;
  const runs = loadEvalRuns();
  const idx = runs.findIndex((r) => r.runId === runId);
  if (idx === -1) return false;

  const run = runs[idx]!;
  for (const update of updates) {
    for (const result of run.results) {
      const sampleMatches =
        update.sampleIndex === undefined || result.sampleIndex === update.sampleIndex;
      if (result.promptId === update.promptId && result.modelId === update.modelId && sampleMatches) {
        // Judge dims are human/LLM-entered (looser trust boundary): only write
        // documented 1..5 values so a stray NaN/Infinity/out-of-range score
        // can't poison `judgeAverages`.
        if (isValidJudgeScore(update.coherence)) {
          result.scores.coherence = update.coherence;
        }
        if (isValidJudgeScore(update.taskFit)) {
          result.scores.taskFit = update.taskFit;
        }
      }
    }
  }

  writeRuns(runs);
  return true;
}

/** One row of the judge skeleton: a (prompt, model) result awaiting judging. */
export type JudgeSkeletonEntry = {
  promptId: string;
  modelId: string;
  /** 1-based replicate index when the run has repeated samples. */
  sampleIndex?: number;
  /** The judge dims this probe requested (for the operator's reference). */
  needs: JudgeDimension[];
};

/**
 * Build the "fill judge scores" skeleton for a run: one entry per result that
 * REQUESTED judging (`result.judge`) and still has at least one requested dim
 * unfilled. Focuses the human on exactly the probes that need a subjective
 * score instead of forcing them to transcribe every (promptId, modelId) pair by
 * hand — the anti-toil affordance for the A/B review. The operator pastes the
 * stringified result into the judge-score box and fills in the 1..5 values.
 * Pure (no storage) so it's unit-testable; the panel passes the selected run.
 */
export function buildJudgeSkeleton(run: EvalRun): JudgeSkeletonEntry[] {
  const out: JudgeSkeletonEntry[] = [];
  for (const result of run.results) {
    const needs = result.judge;
    if (!needs || needs.length === 0) continue;
    const unfilled = needs.filter((dim) => result.scores[dim] == null);
    if (unfilled.length === 0) continue;
    out.push({
      promptId: result.promptId,
      modelId: result.modelId,
      ...(result.sampleIndex !== undefined ? { sampleIndex: result.sampleIndex } : {}),
      needs: unfilled,
    });
  }
  return out;
}

/** Pretty-printed JSON dump of every persisted run (for sharing/inspection). */
export function exportEvalRuns(): string {
  const runs = loadEvalRuns();
  const dump = {
    schemaVersion: SCHEMA_VERSION,
    dumpedAt: new Date().toISOString(),
    runs,
  };
  return JSON.stringify(dump, null, 2);
}

/**
 * Normalize an `exportEvalRuns()` payload into valid runs without touching
 * storage. Accepts the envelope object itself, its JSON string, or a
 * double-stringified envelope from clipboard/file-transfer paths.
 */
export function normalizeImportedEvalRuns(input: unknown): EvalRun[] {
  const parsed = parseJsonEnvelope(input);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Eval import must be an exportEvalRuns() envelope object.');
  }

  const envelope = parsed as Record<string, unknown>;
  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`Eval import schemaVersion must be ${String(SCHEMA_VERSION)}.`);
  }
  if (!Array.isArray(envelope.runs)) {
    throw new Error('Eval import envelope must include a runs array.');
  }

  return envelope.runs
    .map(cloneJsonValue)
    .filter(isValidEvalRun);
}

// ─── Internal ─────────────────────────────────────────────────────────────

function writeRuns(runs: EvalRun[]): void {
  if (typeof localStorage === 'undefined') return;
  // safeStorage drops the write on quota/serialization failure rather than throw.
  safeStorage.set(STORAGE_KEY, JSON.stringify(runs));
}

function parseJsonEnvelope(input: unknown): unknown {
  let current: unknown = input;
  for (let depth = 0; depth < 2 && typeof current === 'string'; depth++) {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      throw new Error('Eval import must be valid JSON.');
    }
  }
  if (typeof current === 'string') {
    throw new Error('Eval import must resolve to an exportEvalRuns() envelope object.');
  }
  return current;
}

function cloneJsonValue(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
}

function safeRemove(): void {
  safeStorage.remove(STORAGE_KEY);
}

function isValidJudgeScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 5;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidEvalCategory(value: unknown): value is EvalCategory {
  return typeof value === 'string' && EVAL_CATEGORIES.has(value as EvalCategory);
}

function isValidRuntimeAdapter(value: unknown): value is EvalRuntimeAdapter {
  return typeof value === 'string' && RUNTIME_ADAPTERS.has(value as EvalRuntimeAdapter);
}

function isValidEvalRunDevice(value: unknown): value is EvalRunDevice {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.profileKey === 'string' && value.profileKey.trim().length > 0 &&
    typeof value.browserClass === 'string' && value.browserClass.trim().length > 0 &&
    typeof value.webgpuSupport === 'string' && value.webgpuSupport.trim().length > 0 &&
    typeof value.deviceClass === 'string' && value.deviceClass.trim().length > 0
  );
}

/**
 * Structural guard: a stored entry is a usable `EvalRun`. Validates the
 * envelope AND each result's shape, dropping individual malformed results
 * (mirroring how `capture.ts` filters bad entries) so a single corrupt result
 * can't reach `buildScorecard` and crash it (`r.perf.ttftMs`) or poison a mean.
 *
 * Mutates `value.results` in place to keep only valid results — this runs only
 * on freshly-parsed `JSON.parse` output, never on a live object.
 */
function isValidEvalRun(value: unknown): value is EvalRun {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof v.runId !== 'string') return false;
  if (typeof v.label !== 'string') return false;
  if (!isValidEvalRunDevice(v.device)) return false;
  if (!Array.isArray(v.results)) return false;
  // Drop malformed results rather than rejecting the whole run — a run with
  // some good results is still useful for the models that did produce them.
  v.results = v.results.filter(isValidEvalResult);
  return true;
}

/** Each result must carry the fields aggregation and judge export dereference. */
function isValidEvalResult(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const r = value;
  if (typeof r.promptId !== 'string' || r.promptId.trim().length === 0) return false;
  if (typeof r.modelId !== 'string' || r.modelId.trim().length === 0) return false;
  if (!isValidEvalCategory(r.category)) return false;
  if (!isValidRuntimeAdapter(r.runtimeAdapter)) return false;
  if (typeof r.output !== 'string') return false;
  if (!isPlainObject(r.generationOptions)) return false;
  if (!isPlainObject(r.scores)) return false;
  if (!isPlainObject(r.perf)) return false;
  if (r.error !== null && typeof r.error !== 'string') return false;
  return true;
}
