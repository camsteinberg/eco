// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PARITY_PROMPTS,
  RUNTIME_PARITY_MAX_TOKENS,
  clearRuntimeParityRecords,
  compareParityOutputs,
  exportRuntimeParity,
  judgeParityResult,
  loadRuntimeParityRecords,
  recordRuntimeParity,
  type PromptComparison,
  type PromptOutput,
  type RuntimeParityRecord,
} from '../runtime-parity';
import { analyzeOutput } from '../backend-crosscheck';

// ─── Synthetic outputs ────────────────────────────────────────────────────

/** Healthy answer to the rainbow prompt. */
const HEALTHY_A =
  'A rainbow is an arc of coloured light that appears in the sky when sunlight passes through ' +
  'droplets of water in the air. Each droplet bends the light and splits it into its separate ' +
  'colours, and the light then reflects back towards you.';

/** Same answer, rephrased — normal cross-runtime divergence. */
const HEALTHY_B =
  'A rainbow is a multicoloured arc visible in the sky, created when sunlight refracts through ' +
  'water droplets in the atmosphere. The droplets split white light into its component colours ' +
  'and reflect them back toward the observer.';

/** Degenerate: repetition collapse. */
const DEGENERATE =
  'The rainbow is a rainbow in the sky. The rainbow is a rainbow in the sky. ' +
  'The rainbow is a rainbow in the sky. The rainbow is a rainbow in the sky.';

/** Coherent but entirely unrelated. */
const UNRELATED =
  'Knead the dough on a floured surface for about ten minutes until it feels smooth and springs ' +
  'back when you press it. Leave it somewhere warm under a damp cloth until it has doubled.';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeOutputs(texts: string[]): PromptOutput[] {
  return texts.map((text, i) => {
    const prompt = PARITY_PROMPTS[i]!;
    return {
      promptId: prompt.id,
      text,
      quality: analyzeOutput(prompt.text, text),
      ms: 100,
    };
  });
}

/** Fill all 12 prompt slots with the same text (simplification for tests). */
function fillAll(text: string): PromptOutput[] {
  return makeOutputs(Array.from({ length: PARITY_PROMPTS.length }, () => text));
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('runtime-parity', () => {
  describe('PARITY_PROMPTS', () => {
    it('has 12 prompts', () => {
      expect(PARITY_PROMPTS).toHaveLength(12);
    });

    it('has unique ids', () => {
      const ids = PARITY_PROMPTS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('covers at least 5 categories', () => {
      const categories = new Set(PARITY_PROMPTS.map((p) => p.category));
      expect(categories.size).toBeGreaterThanOrEqual(5);
    });
  });

  describe('RUNTIME_PARITY_MAX_TOKENS', () => {
    it('is 96', () => {
      expect(RUNTIME_PARITY_MAX_TOKENS).toBe(96);
    });
  });

  describe('compareParityOutputs', () => {
    it('throws when output arrays have different lengths', () => {
      expect(() =>
        compareParityOutputs(fillAll(HEALTHY_A), fillAll(HEALTHY_A).slice(0, 6)),
      ).toThrow(/different lengths/);
    });

    it('returns consistent for identical outputs', () => {
      const result = compareParityOutputs(fillAll(HEALTHY_A), fillAll(HEALTHY_A));
      expect(result.verdict).toBe('consistent');
      expect(result.meanTokenOverlap).toBe(1);
      expect(result.degenerateCount).toBe(0);
    });

    it('returns consistent for closely rephrased outputs', () => {
      const result = compareParityOutputs(fillAll(HEALTHY_A), fillAll(HEALTHY_B));
      expect(result.verdict).toBe('consistent');
      expect(result.meanTokenOverlap).toBeGreaterThan(0.45);
      expect(result.degenerateCount).toBe(0);
    });

    it('returns degenerate when any output is degenerate', () => {
      const outputsA = fillAll(HEALTHY_A);
      const outputsB = fillAll(HEALTHY_B);
      // Make one output degenerate.
      outputsB[3] = {
        ...outputsB[3]!,
        text: DEGENERATE,
        quality: analyzeOutput(PARITY_PROMPTS[3]!.text, DEGENERATE),
      };
      const result = compareParityOutputs(outputsA, outputsB);
      expect(result.verdict).toBe('degenerate');
      expect(result.degenerateCount).toBe(1);
    });

    it('returns divergent for unrelated but healthy outputs', () => {
      const result = compareParityOutputs(fillAll(HEALTHY_A), fillAll(UNRELATED));
      expect(result.verdict).toBe('divergent');
      expect(result.meanTokenOverlap).toBeLessThan(0.45);
    });
  });

  describe('judgeParityResult', () => {
    function makeComparison(
      overlap: number,
      degenerate: boolean,
    ): PromptComparison {
      const prompt = PARITY_PROMPTS[0]!;
      return {
        promptId: prompt.id,
        category: prompt.category,
        promptText: prompt.text,
        outputA: 'text a',
        outputB: 'text b',
        qualityA: { tokens: 20, repetition: 0.9, wordlikeRatio: 0.95, nonLatinLetterRatio: 0, degenerate: false, reasons: [] },
        qualityB: { tokens: 20, repetition: 0.9, wordlikeRatio: 0.95, nonLatinLetterRatio: 0, degenerate, reasons: degenerate ? ['repetition-collapse'] : [] },
        similarity: { sharedPrefixTokens: 5, longestCommonSpan: 10, tokenOverlap: overlap, lengthRatio: 0.9 },
        anyDegenerate: degenerate,
      };
    }

    it('returns degenerate when any comparison has a degenerate output', () => {
      const comparisons = [
        makeComparison(0.8, false),
        makeComparison(0.7, true),
      ];
      const result = judgeParityResult(comparisons);
      expect(result.verdict).toBe('degenerate');
      expect(result.degenerateCount).toBe(1);
    });

    it('returns divergent when mean overlap is below threshold', () => {
      const comparisons = [
        makeComparison(0.3, false),
        makeComparison(0.2, false),
      ];
      const result = judgeParityResult(comparisons);
      expect(result.verdict).toBe('divergent');
    });

    it('returns consistent when mean overlap is above threshold', () => {
      const comparisons = [
        makeComparison(0.8, false),
        makeComparison(0.6, false),
      ];
      const result = judgeParityResult(comparisons);
      expect(result.verdict).toBe('consistent');
    });
  });

  describe('localStorage records', () => {
    beforeEach(() => clearRuntimeParityRecords());
    afterEach(() => clearRuntimeParityRecords());

    const baseRecord: RuntimeParityRecord = {
      version: 1,
      recordedAt: new Date().toISOString(),
      modelIdA: 'model-a',
      modelIdB: 'model-b',
      includesWasmBaseline: false,
      outcome: 'completed',
      verdict: 'consistent',
      summary: 'Test record.',
      result: null,
      wasmBaseline: null,
      timings: { runtimeAMs: 1000, runtimeBMs: 2000, wasmBaselineMs: null },
      error: null,
    };

    it('round-trips a record through save/load', () => {
      recordRuntimeParity(baseRecord);
      const loaded = loadRuntimeParityRecords();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.modelIdA).toBe('model-a');
      expect(loaded[0]!.verdict).toBe('consistent');
    });

    it('limits to MAX_RECORDS (10)', () => {
      for (let i = 0; i < 15; i++) {
        recordRuntimeParity({ ...baseRecord, modelIdA: `model-${i}` });
      }
      const loaded = loadRuntimeParityRecords();
      expect(loaded).toHaveLength(10);
      // Oldest 5 should have been evicted.
      expect(loaded[0]!.modelIdA).toBe('model-5');
    });

    it('clearRuntimeParityRecords empties the store', () => {
      recordRuntimeParity(baseRecord);
      clearRuntimeParityRecords();
      expect(loadRuntimeParityRecords()).toHaveLength(0);
    });
  });

  describe('exportRuntimeParity', () => {
    beforeEach(() => clearRuntimeParityRecords());
    afterEach(() => clearRuntimeParityRecords());

    it('returns the current records with a timestamp', () => {
      recordRuntimeParity({
        version: 1,
        recordedAt: new Date().toISOString(),
        modelIdA: 'a',
        modelIdB: 'b',
        includesWasmBaseline: false,
        outcome: 'completed',
        verdict: 'consistent',
        summary: 'ok',
        result: null,
        wasmBaseline: null,
        timings: { runtimeAMs: null, runtimeBMs: null, wasmBaselineMs: null },
        error: null,
      });
      const exported = exportRuntimeParity();
      expect(exported.exportedAt).toBeTruthy();
      expect(exported.records).toHaveLength(1);
    });
  });
});
