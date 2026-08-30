// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runtime parity — comparison logic for cross-runtime output consistency.
 *
 * ## What this exists to answer
 *
 * Two runtimes (e.g. Transformers.js/ORT-WebGPU and WebLLM/MLC) can serve
 * the SAME underlying model family and quantization, yet produce meaningfully
 * different text because of different compilation pipelines, graph
 * optimizations, and operator kernels. This module generates a fixed set of
 * diverse prompts on both runtimes and scores whether the outputs are
 * consistent enough to consider them interchangeable from a user's
 * perspective.
 *
 * ## Relationship to the backend cross-check
 *
 * The backend cross-check (`backend-crosscheck.ts`) compares WebGPU vs WASM
 * WITHIN Transformers.js — same weights, same ONNX graph, two execution
 * providers. This module compares ACROSS runtimes — potentially different
 * weight formats, different inference engines, different everything except the
 * base model architecture. The backend cross-check catches silent GPU garbage;
 * this catches systematic divergence between runtime stacks.
 *
 * ## Reuse
 *
 * The per-output degeneracy analysis and similarity measurement are imported
 * from `backend-crosscheck.ts` — the health criteria and Dice overlap are the
 * same regardless of what produced the text. Only the prompt set, verdict
 * logic, and record schema are new.
 */

import {
  measureSimilarity,
  type CrossCheckSimilarity,
  type OutputQuality,
} from './backend-crosscheck';
import { safeStorage } from '../../lib/local-storage';

// ─── Prompt set ───────────────────────────────────────────────────────────

/**
 * Twelve short, diverse prompts covering factual recall, instruction
 * following, arithmetic, code, summarization, and creative tasks. Each is
 * short enough that 96 tokens of output is plenty, and diverse enough that
 * garbage on ANY category shows.
 */
export const PARITY_PROMPTS: readonly { id: string; text: string; category: string }[] = [
  { id: 'factual-1', text: 'In two or three sentences, explain what a rainbow is and why one appears after rain.', category: 'factual' },
  { id: 'factual-2', text: 'What is the boiling point of water at sea level, and why does it change at high altitude?', category: 'factual' },
  { id: 'instruction-1', text: 'List three tips for writing a clear email, as a numbered list.', category: 'instruction' },
  { id: 'instruction-2', text: 'Rewrite this sentence in the passive voice: "The cat chased the mouse across the garden."', category: 'instruction' },
  { id: 'arithmetic-1', text: 'What is 17 times 23?', category: 'arithmetic' },
  { id: 'arithmetic-2', text: 'If a store sells apples for $1.50 each and you buy 7, how much do you pay?', category: 'arithmetic' },
  { id: 'code-1', text: 'Write a JavaScript function that reverses a string.', category: 'code' },
  { id: 'code-2', text: 'What does the following Python expression evaluate to: [x**2 for x in range(5)]?', category: 'code' },
  { id: 'summarize-1', text: 'Summarize in one sentence: "Photosynthesis is the process by which green plants use sunlight to convert carbon dioxide and water into glucose and oxygen, providing energy for the plant and releasing oxygen into the atmosphere."', category: 'summarize' },
  { id: 'summarize-2', text: 'Summarize in one sentence: "The Great Wall of China was built over many centuries by different dynasties to protect against invasions from the north, stretching over 13,000 miles across mountains, deserts, and plains."', category: 'summarize' },
  { id: 'creative-1', text: 'Write a haiku about the ocean.', category: 'creative' },
  { id: 'creative-2', text: 'In one sentence, describe what a city looks like at midnight.', category: 'creative' },
];

/** Token cap per generation — same as the backend cross-check. */
export const RUNTIME_PARITY_MAX_TOKENS = 96;

/**
 * System prompt shared across all generations, matching the backend
 * cross-check's implicit default (no system prompt). Keeping it empty
 * removes one variable from the comparison.
 */
export const RUNTIME_PARITY_SYSTEM_PROMPT = '';

// ─── Types ────────────────────────────────────────────────────────────────

/** Per-prompt result for one runtime. */
export type PromptOutput = {
  promptId: string;
  text: string;
  quality: OutputQuality;
  ms: number;
};

/** Per-prompt comparison between two runtimes. */
export type PromptComparison = {
  promptId: string;
  category: string;
  promptText: string;
  outputA: string;
  outputB: string;
  qualityA: OutputQuality;
  qualityB: OutputQuality;
  similarity: CrossCheckSimilarity;
  /** Either side is degenerate. */
  anyDegenerate: boolean;
};

export type ParityVerdict = 'consistent' | 'divergent' | 'degenerate';

export type ParityResult = {
  comparisons: PromptComparison[];
  /** Mean token overlap across all non-degenerate comparisons. */
  meanTokenOverlap: number;
  /** Number of prompts where at least one side is degenerate. */
  degenerateCount: number;
  verdict: ParityVerdict;
  summary: string;
};

// ─── Comparison logic ─────────────────────────────────────────────────────

/**
 * Compare per-prompt outputs from two runtimes. Both arrays must be in the
 * same prompt order (aligned by index to `PARITY_PROMPTS`).
 */
export function compareParityOutputs(
  outputsA: readonly PromptOutput[],
  outputsB: readonly PromptOutput[],
): ParityResult {
  if (outputsA.length !== outputsB.length) {
    throw new Error(
      `Output arrays have different lengths (${outputsA.length} vs ${outputsB.length}); they must be aligned.`,
    );
  }

  const comparisons: PromptComparison[] = [];
  for (let i = 0; i < outputsA.length; i++) {
    const a = outputsA[i]!;
    const b = outputsB[i]!;
    const prompt = PARITY_PROMPTS[i]!;
    const similarity = measureSimilarity(a.text, b.text);
    comparisons.push({
      promptId: prompt.id,
      category: prompt.category,
      promptText: prompt.text,
      outputA: a.text,
      outputB: b.text,
      qualityA: a.quality,
      qualityB: b.quality,
      similarity,
      anyDegenerate: a.quality.degenerate || b.quality.degenerate,
    });
  }

  return judgeParityResult(comparisons);
}

/**
 * Produce the overall verdict from a set of per-prompt comparisons.
 *
 * Rules:
 * - Any degenerate output on either side => `degenerate` (the runtime
 *   producing garbage is broken, period).
 * - Mean token overlap below the threshold => `divergent`.
 * - Otherwise => `consistent`.
 *
 * The threshold is deliberately the same as the backend cross-check's
 * `MIN_TOKEN_OVERLAP` (0.45) — if two runtimes agree less than two entirely
 * different models do, that is a finding.
 */
export function judgeParityResult(comparisons: readonly PromptComparison[]): ParityResult {
  const degenerateCount = comparisons.filter((c) => c.anyDegenerate).length;

  if (degenerateCount > 0) {
    const degPrompts = comparisons
      .filter((c) => c.anyDegenerate)
      .map((c) => c.promptId)
      .join(', ');
    return {
      comparisons: [...comparisons],
      meanTokenOverlap: meanOverlap(comparisons),
      degenerateCount,
      verdict: 'degenerate',
      summary: `${degenerateCount} of ${comparisons.length} prompts produced degenerate output on at least one runtime (${degPrompts}).`,
    };
  }

  const mean = meanOverlap(comparisons);
  // Use the same threshold as the backend cross-check.
  const MIN_PARITY_OVERLAP = 0.45;

  if (mean < MIN_PARITY_OVERLAP) {
    return {
      comparisons: [...comparisons],
      meanTokenOverlap: mean,
      degenerateCount: 0,
      verdict: 'divergent',
      summary: `Outputs diverge: mean token overlap ${mean.toFixed(3)} is below the ${MIN_PARITY_OVERLAP} threshold across ${comparisons.length} prompts.`,
    };
  }

  return {
    comparisons: [...comparisons],
    meanTokenOverlap: mean,
    degenerateCount: 0,
    verdict: 'consistent',
    summary: `Runtimes agree: mean token overlap ${mean.toFixed(3)} across ${comparisons.length} prompts — no sign of systematic divergence.`,
  };
}

function meanOverlap(comparisons: readonly PromptComparison[]): number {
  const healthy = comparisons.filter((c) => !c.anyDegenerate);
  if (healthy.length === 0) return 0;
  const sum = healthy.reduce((acc, c) => acc + c.similarity.tokenOverlap, 0);
  return sum / healthy.length;
}

// ─── Record store (localStorage, FIFO) ────────────────────────────────────

const RECORDS_KEY = 'eco-runtime-parity-records-v1';
const MAX_RECORDS = 10;

export type RuntimeParityRecord = {
  version: 1;
  recordedAt: string;
  modelIdA: string;
  modelIdB: string;
  includesWasmBaseline: boolean;
  outcome: 'completed' | 'error';
  verdict: ParityVerdict | null;
  summary: string;
  /** Per-prompt comparisons (A vs B). */
  result: ParityResult | null;
  /** Optional WASM baseline comparisons (A-WebGPU vs A-WASM). */
  wasmBaseline: ParityResult | null;
  /** Wall-clock totals per runtime, ms. */
  timings: { runtimeAMs: number | null; runtimeBMs: number | null; wasmBaselineMs: number | null };
  error: string | null;
};

export function recordRuntimeParity(record: RuntimeParityRecord): void {
  const current = loadRuntimeParityRecords();
  current.push(record);
  safeStorage.set(RECORDS_KEY, JSON.stringify(current.slice(-MAX_RECORDS)));
}

export function loadRuntimeParityRecords(): RuntimeParityRecord[] {
  const raw = safeStorage.get(RECORDS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isParityRecord);
  } catch {
    return [];
  }
}

export function clearRuntimeParityRecords(): void {
  safeStorage.remove(RECORDS_KEY);
}

function isParityRecord(value: unknown): value is RuntimeParityRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.modelIdA === 'string' &&
    typeof v.modelIdB === 'string' &&
    typeof v.recordedAt === 'string' &&
    (v.outcome === 'completed' || v.outcome === 'error')
  );
}

// ─── JSON export shape ────────────────────────────────────────────────────

export type RuntimeParityExport = {
  exportedAt: string;
  records: RuntimeParityRecord[];
};

export function exportRuntimeParity(): RuntimeParityExport {
  return {
    exportedAt: new Date().toISOString(),
    records: loadRuntimeParityRecords(),
  };
}
