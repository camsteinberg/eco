// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Blind pairwise scoring over persisted eval runs.
 *
 * A judge sees two replies to the same prompt and picks left / right / tie,
 * never learning which model or setting produced either. An "arm" is a
 * (runId, modelId) selection, so a pair is two models inside one run OR the
 * same model across two runs whose settings differed (settings are run-wide —
 * see `EvalRunConfigFingerprint`).
 *
 * Rules, matching the Open WebUI arena convention:
 *   - a pair exists only where BOTH arms produced a usable reply for the same
 *     (promptId, sampleIndex); anything else is EXCLUDED and counted, never
 *     silently dropped;
 *   - left/right order is a deterministic function of the pair id alone, so a
 *     re-render never reshuffles and a second judge sees the same layout;
 *   - nothing arm-identifying reaches the judging surface — `orderForJudge`
 *     returns text only.
 *
 * Verdicts persist under their own key (`eco-local-ai-pairwise-v1`), NOT inside
 * `eco-local-ai-eval-v1`, whose schema check is a hard equality on version 1.
 */

import { safeStorage } from '../../lib/local-storage';
import type { EvalHistoryTurn, EvalPromptSpec, EvalResult, EvalRun } from './types';

const STORAGE_KEY = 'eco-local-ai-pairwise-v1';
const SCHEMA_VERSION = 1;
/** 95% two-sided normal quantile, for the Wilson interval. */
const Z_95 = 1.959964;

/** One side of a comparison: a model's rows within one persisted run. */
export type PairArm = { runId: string; modelId: string };

/** A judge's call on one pair. `'A'`/`'B'` name the arms, never the sides. */
export type PairVerdict = 'A' | 'B' | 'tie';

/** Why a (promptId, sampleIndex) could not be judged. */
export type PairExclusionReason = 'missing-in-arm' | 'error' | 'empty-output';

export type PairExclusion = { pairId: string; promptId: string; reason: PairExclusionReason };

/** A judgeable comparison. `outputA`/`outputB` are arm-ordered, not side-ordered. */
export type Pair = {
  /** `${promptId}#${sampleIndex}` — carries no arm identity. */
  pairId: string;
  promptId: string;
  /** Prompt text when a spec was supplied; `null` when only ids are available. */
  promptText: string | null;
  history: EvalHistoryTurn[];
  outputA: string;
  outputB: string;
};

/** What the judge is allowed to see. Deliberately free of arm identity. */
export type JudgeView = {
  pairId: string;
  promptId: string;
  promptText: string | null;
  history: EvalHistoryTurn[];
  left: string;
  right: string;
  /** Maps a side back to an arm when recording the verdict. Never rendered. */
  leftIsA: boolean;
};

/** One judge's verdicts over one arm pairing. Persisted. */
export type PairwiseSession = {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  judge: string;
  armA: PairArm;
  armB: PairArm;
  /** pairId → verdict. Absent key means "not yet judged". */
  verdicts: Record<string, PairVerdict>;
  excludedCount: number;
  /** True when the judge revealed identities before finishing every pair. */
  revealedEarly: boolean;
};

export type PairwiseTally = {
  pairs: number;
  decided: number;
  winsA: number;
  winsB: number;
  ties: number;
  excluded: number;
  /** (winsA + ties/2) / decided — ties split, the arena convention. `null` if undecided. */
  winRateA: number | null;
  /** Wilson 95% interval on `winRateA`. `null` if undecided. */
  interval: { lo: number; hi: number } | null;
};

// ─── Pairing ────────────────────────────────────────────────────────────────

/**
 * Build every judgeable pair between two arms, plus the exclusions.
 *
 * Rows are keyed by (promptId, sampleIndex) so replicates line up rather than
 * collapsing; that is the same tuple `setJudgeScores` matches on. `specs`
 * supplies prompt text and history, which persisted results deliberately do not
 * store (`EvalPromptTrace` holds no prompt text).
 */
export function buildPairs(
  runs: readonly EvalRun[],
  armA: PairArm,
  armB: PairArm,
  specs: readonly EvalPromptSpec[] = [],
): { pairs: Pair[]; excluded: PairExclusion[] } {
  const rowsA = collectArmRows(runs, armA);
  const rowsB = collectArmRows(runs, armB);
  const specById = new Map(specs.map((s) => [s.id, s]));

  const pairs: Pair[] = [];
  const excluded: PairExclusion[] = [];
  const seen = new Set<string>();

  for (const pairId of [...rowsA.keys(), ...rowsB.keys()]) {
    if (seen.has(pairId)) continue;
    seen.add(pairId);
    const promptId = pairId.slice(0, pairId.lastIndexOf('#'));
    const a = rowsA.get(pairId);
    const b = rowsB.get(pairId);
    if (!a || !b) {
      excluded.push({ pairId, promptId, reason: 'missing-in-arm' });
      continue;
    }
    if (a.error !== null || b.error !== null) {
      excluded.push({ pairId, promptId, reason: 'error' });
      continue;
    }
    if (a.output.trim() === '' || b.output.trim() === '') {
      excluded.push({ pairId, promptId, reason: 'empty-output' });
      continue;
    }
    const spec = specById.get(promptId);
    pairs.push({
      pairId,
      promptId,
      promptText: spec?.prompt ?? null,
      history: spec?.history ?? [],
      outputA: a.output,
      outputB: b.output,
    });
  }

  pairs.sort((x, y) => x.pairId.localeCompare(y.pairId));
  excluded.sort((x, y) => x.pairId.localeCompare(y.pairId));
  return { pairs, excluded };
}

/**
 * Side assignment for one pair. A pure function of `pairId`, so a re-render,
 * a reload and a second judge all see the same left/right — and roughly half
 * the prompt set puts arm A on the left, which is what cancels position bias.
 */
export function orderForJudge(pair: Pair): JudgeView {
  const leftIsA = (fnv1a32(pair.pairId) & 1) === 0;
  return {
    pairId: pair.pairId,
    promptId: pair.promptId,
    promptText: pair.promptText,
    history: pair.history,
    left: leftIsA ? pair.outputA : pair.outputB,
    right: leftIsA ? pair.outputB : pair.outputA,
    leftIsA,
  };
}

/** Translate a side the judge clicked into an arm verdict. */
export function verdictFromSide(view: JudgeView, side: 'left' | 'right' | 'tie'): PairVerdict {
  if (side === 'tie') return 'tie';
  const isA = side === 'left' ? view.leftIsA : !view.leftIsA;
  return isA ? 'A' : 'B';
}

// ─── Tally ──────────────────────────────────────────────────────────────────

/** Counts, tie-split win rate for arm A, and its Wilson 95% interval. */
export function tally(session: PairwiseSession, pairs: readonly Pair[]): PairwiseTally {
  let winsA = 0;
  let winsB = 0;
  let ties = 0;
  for (const pair of pairs) {
    const verdict = session.verdicts[pair.pairId];
    if (verdict === 'A') winsA += 1;
    else if (verdict === 'B') winsB += 1;
    else if (verdict === 'tie') ties += 1;
  }
  const decided = winsA + winsB + ties;
  const winRateA = decided === 0 ? null : (winsA + ties / 2) / decided;
  return {
    pairs: pairs.length,
    decided,
    winsA,
    winsB,
    ties,
    excluded: session.excludedCount,
    winRateA,
    interval: winRateA === null ? null : wilsonInterval(winRateA, decided),
  };
}

/** Wilson score interval — honest at small n, where normal-approximation is not. */
export function wilsonInterval(p: number, n: number, z: number = Z_95): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 1 };
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// ─── Storage ────────────────────────────────────────────────────────────────

/** Stable identity of a session: one record per (armA, armB, judge). */
export function sessionIdFor(armA: PairArm, armB: PairArm, judge: string): string {
  return `${armA.runId}:${armA.modelId}|${armB.runId}:${armB.modelId}|${judge.trim().toLowerCase()}`;
}

/** All persisted sessions. Self-heals a malformed payload by clearing the key. */
export function loadPairwiseSessions(): PairwiseSession[] {
  const raw = safeStorage.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      safeStorage.remove(STORAGE_KEY);
      return [];
    }
    return parsed.filter(isValidSession);
  } catch {
    safeStorage.remove(STORAGE_KEY);
    return [];
  }
}

/** Upsert a session by `sessionId`, stamping `updatedAt`. */
export function savePairwiseSession(session: PairwiseSession): void {
  const sessions = loadPairwiseSessions();
  const next = { ...session, updatedAt: new Date().toISOString() };
  const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (idx === -1) sessions.push(next);
  else sessions[idx] = next;
  safeStorage.set(STORAGE_KEY, JSON.stringify(sessions));
}

export function clearPairwiseSessions(): void {
  safeStorage.remove(STORAGE_KEY);
}

/** Pretty JSON dump of one session plus its tally, for the download button. */
export function exportPairwiseSession(session: PairwiseSession, pairs: readonly Pair[]): string {
  return JSON.stringify(
    { schemaVersion: SCHEMA_VERSION, dumpedAt: new Date().toISOString(), session, tally: tally(session, pairs) },
    null,
    2,
  );
}

// ─── Internal ───────────────────────────────────────────────────────────────

function collectArmRows(runs: readonly EvalRun[], arm: PairArm): Map<string, EvalResult> {
  const run = runs.find((r) => r.runId === arm.runId);
  const rows = new Map<string, EvalResult>();
  if (!run) return rows;
  for (const result of run.results) {
    if (result.modelId !== arm.modelId) continue;
    const key = `${result.promptId}#${String(result.sampleIndex ?? 1)}`;
    // First row wins: a duplicate tuple would otherwise pair a row with itself.
    if (!rows.has(key)) rows.set(key, result);
  }
  return rows;
}

/** FNV-1a, 32-bit. Small, dependency-free, and well spread over short ids. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isValidSession(value: unknown): value is PairwiseSession {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  if (s.schemaVersion !== SCHEMA_VERSION) return false;
  if (typeof s.sessionId !== 'string' || typeof s.judge !== 'string') return false;
  if (typeof s.createdAt !== 'string' || typeof s.updatedAt !== 'string') return false;
  if (typeof s.excludedCount !== 'number' || typeof s.revealedEarly !== 'boolean') return false;
  if (!isArm(s.armA) || !isArm(s.armB)) return false;
  if (typeof s.verdicts !== 'object' || s.verdicts === null || Array.isArray(s.verdicts)) return false;
  return Object.values(s.verdicts).every((v) => v === 'A' || v === 'B' || v === 'tie');
}

function isArm(value: unknown): value is PairArm {
  if (typeof value !== 'object' || value === null) return false;
  const arm = value as Record<string, unknown>;
  return typeof arm.runId === 'string' && typeof arm.modelId === 'string';
}
