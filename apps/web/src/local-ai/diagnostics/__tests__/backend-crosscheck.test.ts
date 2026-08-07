// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CROSS_CHECK_PROMPT,
  MIN_TOKEN_OVERLAP,
  analyzeOutput,
  clearBackendCrossChecks,
  compareOutputs,
  explainWasmLoadFailure,
  judgeCrossCheck,
  loadBackendCrossChecks,
  measureSimilarity,
  nonLatinLetterRatio,
  recordBackendCrossCheck,
  type BackendCrossCheckRecord,
  type CrossCheckSimilarity,
} from '../backend-crosscheck';

// ─── Synthetic outputs ───────────────────────────────────────────────────────
//
// These stand in for what each arm can hand back. HEALTHY_* are what a working
// pair of backends looks like: the same answer, phrased differently, because
// greedy decoding diverges across kernels after the first near-tie. The rest
// are the shapes the silent-garbage failure class actually produces.

const HEALTHY_REFERENCE =
  'A rainbow is an arc of coloured light that appears in the sky when sunlight passes through ' +
  'droplets of water in the air. Each droplet bends the light and splits it into its separate ' +
  'colours, and the light then reflects back towards you. Rainbows show up after rain because ' +
  'the air is still full of droplets while the sun comes back out.';

/** Same answer, different wording — the normal cross-backend case. */
const HEALTHY_DIVERGENT_WORDING =
  'A rainbow is an arc of coloured light in the sky, formed when sunlight passes through droplets ' +
  'of water in the air. Each droplet bends the light and splits it into separate colours, then ' +
  'reflects it back toward the viewer. Rainbows appear after rain because the air is still full ' +
  'of droplets while the sun shines again.';

/** Coherent prose, but not an answer to the same question at all. */
const COHERENT_BUT_UNRELATED =
  'Knead the dough on a floured surface for about ten minutes, until it feels smooth and springs ' +
  'back when you press it. Leave it somewhere warm under a damp cloth until it has doubled in ' +
  'size, then shape your loaf and bake it hot.';

/** Repetition collapse — a decoder stuck in a loop. */
const REPETITION_COLLAPSE =
  'The rainbow is a rainbow in the sky. The rainbow is a rainbow in the sky. ' +
  'The rainbow is a rainbow in the sky. The rainbow is a rainbow in the sky.';

/** Token salad — punctuation and symbol fragments, no words. */
const TOKEN_SALAD = '!!! ??? -- ++ ... ((( ))) *** ### $$$ %%% &&& @@@ ^^^ ~~~ ||| /// <<< >>> ===';

/** Mostly salad with a few real words surviving — the messier real shape. */
const MOSTLY_SALAD = 'rainbow ??? -- ++ ... ((( ))) *** ### $$$ %%% &&& @@@ ^^^ light ~~~';

/** A sudden switch to another script, with the prompt entirely in English. */
const SCRIPT_SWITCH =
  'Радуга это дуга цветного света которая появляется на небе когда солнечный свет проходит ' +
  'сквозь капли воды в воздухе и каждая капля разделяет его на цвета.';

const NEAR_IDENTICAL_NOISE_FLOOR: CrossCheckSimilarity = {
  sharedPrefixTokens: 60,
  longestCommonSpan: 60,
  tokenOverlap: 1,
  lengthRatio: 1,
};

// ─── analyzeOutput: absolute, per-side health ────────────────────────────────

describe('analyzeOutput — the degeneracy layer', () => {
  it('passes healthy English prose with no findings', () => {
    const quality = analyzeOutput(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE);
    expect(quality.degenerate).toBe(false);
    expect(quality.reasons).toEqual([]);
    expect(quality.wordlikeRatio).toBeGreaterThan(0.9);
    expect(quality.repetition).toBeGreaterThan(0.5);
  });

  it('flags empty output', () => {
    const quality = analyzeOutput(CROSS_CHECK_PROMPT, '');
    expect(quality.degenerate).toBe(true);
    expect(quality.reasons).toEqual(['empty']);
    expect(quality.tokens).toBe(0);
  });

  it('flags whitespace-only output as empty, not as short prose', () => {
    expect(analyzeOutput(CROSS_CHECK_PROMPT, '   \n  \t ').reasons).toEqual(['empty']);
  });

  it('flags output that stops almost immediately', () => {
    const quality = analyzeOutput(CROSS_CHECK_PROMPT, 'A rainbow.');
    expect(quality.reasons).toEqual(['too-short']);
  });

  it('flags repetition collapse', () => {
    const quality = analyzeOutput(CROSS_CHECK_PROMPT, REPETITION_COLLAPSE);
    expect(quality.reasons).toContain('repetition-collapse');
  });

  it('flags token salad', () => {
    const quality = analyzeOutput(CROSS_CHECK_PROMPT, TOKEN_SALAD);
    expect(quality.reasons).toContain('token-salad');
    expect(quality.wordlikeRatio).toBe(0);
  });

  it('flags salad that still contains a few real words', () => {
    expect(analyzeOutput(CROSS_CHECK_PROMPT, MOSTLY_SALAD).reasons).toContain('token-salad');
  });

  it('flags a script switch when the prompt is entirely Latin', () => {
    const quality = analyzeOutput(CROSS_CHECK_PROMPT, SCRIPT_SWITCH);
    expect(quality.reasons).toContain('script-switch');
  });

  it('does NOT flag a script switch when the prompt is in that script', () => {
    const russianPrompt = 'Объясни в двух предложениях что такое радуга и почему она появляется.';
    expect(analyzeOutput(russianPrompt, SCRIPT_SWITCH).reasons).not.toContain('script-switch');
  });

  it('does NOT flag prose carrying a stray non-Latin character', () => {
    const withGreek = `${HEALTHY_REFERENCE} The angle is close to 42°, or about 0.73 radians (θ).`;
    expect(analyzeOutput(CROSS_CHECK_PROMPT, withGreek).degenerate).toBe(false);
  });

  it('does not double-report repetition on output already too short to judge', () => {
    // Below the token floor the short-ness IS the finding; a 3-word "loop" is
    // not evidence of a collapsed decoder.
    expect(analyzeOutput(CROSS_CHECK_PROMPT, 'no no no')).toMatchObject({
      reasons: ['too-short'],
    });
  });
});

describe('nonLatinLetterRatio', () => {
  it('is 0 for pure English and for text with no letters at all', () => {
    expect(nonLatinLetterRatio(HEALTHY_REFERENCE)).toBe(0);
    expect(nonLatinLetterRatio('123 456 !!!')).toBe(0);
  });

  it('is 1 for text entirely in another script', () => {
    expect(nonLatinLetterRatio('радуга')).toBe(1);
  });

  it('ignores digits and punctuation when computing the ratio', () => {
    expect(nonLatinLetterRatio('ab фы!!! 1234')).toBeCloseTo(0.5, 5);
  });
});

// ─── measureSimilarity ───────────────────────────────────────────────────────

describe('measureSimilarity', () => {
  it('scores an identical pair at the ceiling on every measure', () => {
    const similarity = measureSimilarity(HEALTHY_REFERENCE, HEALTHY_REFERENCE);
    expect(similarity.tokenOverlap).toBe(1);
    expect(similarity.lengthRatio).toBe(1);
    expect(similarity.sharedPrefixTokens).toBeGreaterThan(50);
    expect(similarity.longestCommonSpan).toBe(similarity.sharedPrefixTokens);
  });

  it('is symmetric', () => {
    const forward = measureSimilarity(HEALTHY_REFERENCE, HEALTHY_DIVERGENT_WORDING);
    const backward = measureSimilarity(HEALTHY_DIVERGENT_WORDING, HEALTHY_REFERENCE);
    expect(forward).toEqual(backward);
  });

  it('keeps a re-worded answer well above the threshold', () => {
    const similarity = measureSimilarity(HEALTHY_REFERENCE, HEALTHY_DIVERGENT_WORDING);
    expect(similarity.tokenOverlap).toBeGreaterThan(MIN_TOKEN_OVERLAP);
  });

  it('drops a coherent but unrelated answer below the threshold', () => {
    const similarity = measureSimilarity(HEALTHY_REFERENCE, COHERENT_BUT_UNRELATED);
    expect(similarity.tokenOverlap).toBeLessThan(MIN_TOKEN_OVERLAP);
  });

  it('scores an empty side at zero without dividing by zero', () => {
    expect(measureSimilarity(HEALTHY_REFERENCE, '')).toMatchObject({
      tokenOverlap: 0,
      sharedPrefixTokens: 0,
      lengthRatio: 0,
    });
  });

  it('does not credit a short output for repeating one shared word', () => {
    // Multiset (not set) overlap: "light light light" cannot claim credit for
    // three separate matches against a reference that says it once.
    const similarity = measureSimilarity('the light', 'light light light light');
    expect(similarity.tokenOverlap).toBeLessThan(0.5);
  });
});

// ─── compareOutputs: the cross-backend verdict ───────────────────────────────

describe('compareOutputs', () => {
  it('calls an identical pair consistent', () => {
    expect(compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, HEALTHY_REFERENCE).verdict).toBe(
      'consistent',
    );
  });

  it('calls a re-worded but equivalent answer consistent', () => {
    const result = compareOutputs(
      CROSS_CHECK_PROMPT,
      HEALTHY_REFERENCE,
      HEALTHY_DIVERGENT_WORDING,
    );
    expect(result.verdict).toBe('consistent');
    expect(result.candidate.degenerate).toBe(false);
  });

  it('calls a coherent but unrelated answer divergent, not garbage', () => {
    const result = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, COHERENT_BUT_UNRELATED);
    expect(result.verdict).toBe('divergent');
    expect(result.candidate.degenerate).toBe(false);
  });

  it.each([
    ['empty output', '', 'empty'],
    ['repetition collapse', REPETITION_COLLAPSE, 'repetition-collapse'],
    ['token salad', TOKEN_SALAD, 'token-salad'],
    ['a script switch', SCRIPT_SWITCH, 'script-switch'],
  ])('calls %s on the WebGPU arm backend-garbage', (_label, candidate, reason) => {
    const result = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, candidate);
    expect(result.verdict).toBe('backend-garbage');
    expect(result.candidate.reasons).toContain(reason);
    expect(result.summary).toContain('WebGPU');
  });

  it('does not blame the backend when the WASM reference is itself degenerate', () => {
    const result = compareOutputs(CROSS_CHECK_PROMPT, REPETITION_COLLAPSE, HEALTHY_REFERENCE);
    expect(result.verdict).toBe('reference-degenerate');
    expect(result.summary).toContain('cannot rule anything out');
  });

  it('reports both arms degenerate as a prompt/model problem, not a backend one', () => {
    const result = compareOutputs(CROSS_CHECK_PROMPT, TOKEN_SALAD, REPETITION_COLLAPSE);
    expect(result.verdict).toBe('reference-degenerate');
    expect(result.summary).toContain('Both arms');
  });

  it('reaches the garbage verdict without consulting the similarity threshold', () => {
    // Repetition collapse that ALSO shares most of the reference's vocabulary:
    // an overlap-only check would wave this through. The degeneracy layer must
    // catch it on its own.
    const loopedButOnTopic = `${'A rainbow is coloured light in the sky. '.repeat(6)}`;
    const result = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, loopedButOnTopic);
    expect(result.verdict).toBe('backend-garbage');
  });
});

// ─── judgeCrossCheck: folding in the noise floor ─────────────────────────────

describe('judgeCrossCheck', () => {
  const looseNoiseFloor: CrossCheckSimilarity = {
    sharedPrefixTokens: 1,
    longestCommonSpan: 2,
    tokenOverlap: 0.2,
    lengthRatio: 0.6,
  };

  it('passes a consistent comparison through under a tight noise floor', () => {
    const cross = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, HEALTHY_DIVERGENT_WORDING);
    expect(judgeCrossCheck(NEAR_IDENTICAL_NOISE_FLOOR, cross).verdict).toBe('consistent');
  });

  it('reports divergence when the same backend agrees with itself', () => {
    const cross = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, COHERENT_BUT_UNRELATED);
    expect(judgeCrossCheck(NEAR_IDENTICAL_NOISE_FLOOR, cross).verdict).toBe('divergent');
  });

  it('refuses to call divergence when the same backend already disagrees with itself', () => {
    const cross = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, COHERENT_BUT_UNRELATED);
    const judged = judgeCrossCheck(looseNoiseFloor, cross);
    expect(judged.verdict).toBe('inconclusive');
    expect(judged.summary).toContain('SAME backend');
  });

  it('still reports garbage even when the noise floor is useless', () => {
    // A degenerate output is an absolute finding — reproducibility of the
    // healthy case has no bearing on it.
    const cross = compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, TOKEN_SALAD);
    expect(judgeCrossCheck(looseNoiseFloor, cross).verdict).toBe('backend-garbage');
  });

  it('still reports a degenerate reference when the noise floor is useless', () => {
    const cross = compareOutputs(CROSS_CHECK_PROMPT, TOKEN_SALAD, HEALTHY_REFERENCE);
    expect(judgeCrossCheck(looseNoiseFloor, cross).verdict).toBe('reference-degenerate');
  });
});

// ─── Real measurements from the live run ─────────────────────────────────────
//
// Captured on an Apple-silicon Mac (Chromium, WebGPU), greedy, 96-token cap,
// running CROSS_CHECK_PROMPT through the real runtime. These pin the threshold
// to observed behaviour rather than to intuition — see the module docblock.

/** `candidate/qwen3.5-2b-onnx`, WebGPU. Both repeats returned this exactly. */
const LIVE_QWEN35_2B =
  'A rainbow is a natural optical phenomenon created when sunlight interacts with water droplets ' +
  'in the atmosphere. When sunlight enters a raindrop, it refracts, reflects off the back of the ' +
  'droplet, and refracts again as it exits, separating the white light into its constituent ' +
  'colors. One appears after rain because the droplets are suspended in the air, allowing the ' +
  'light to travel from the observer to the eye after the rain has stopped.';

/** `candidate/lfm2.5-350m-onnx`, WebGPU. Both repeats returned this exactly. */
const LIVE_LFM25_350M =
  'A rainbow is a natural phenomenon that occurs when sunlight interacts with water droplets in ' +
  'the atmosphere, creating a colorful arc of light. It appears after rain because rain creates ' +
  'the conditions necessary for this effect, such as moisture in the air and sunlight reflecting ' +
  'off the droplets.';

describe('threshold calibration against real generations', () => {
  it('reads a repeated greedy generation as a perfect noise floor', () => {
    // What the live run actually produced: two WebGPU generations, separated by
    // a full unload and reload, came back byte-identical on both models.
    for (const output of [LIVE_QWEN35_2B, LIVE_LFM25_350M]) {
      const similarity = measureSimilarity(output, output);
      expect(similarity.tokenOverlap).toBe(1);
      expect(similarity.lengthRatio).toBe(1);
    }
  });

  it('keeps two DIFFERENT models answering the same prompt above the threshold', () => {
    // The load-bearing calibration point. Two different vendors and sizes, both
    // coherent, is a harsher divergence than two backends of one model can
    // produce — so if this pair sat below the bar, the bar would be guaranteed
    // to false-positive on healthy cross-backend runs.
    const similarity = measureSimilarity(LIVE_QWEN35_2B, LIVE_LFM25_350M);
    expect(similarity.tokenOverlap).toBeGreaterThan(MIN_TOKEN_OVERLAP);
    expect(similarity.tokenOverlap).toBeCloseTo(0.562, 2);
  });

  it('finds no degeneracy in either real generation', () => {
    for (const output of [LIVE_QWEN35_2B, LIVE_LFM25_350M]) {
      expect(analyzeOutput(CROSS_CHECK_PROMPT, output).degenerate).toBe(false);
    }
  });
});

// ─── WASM load-failure classification ────────────────────────────────────────

describe('explainWasmLoadFailure', () => {
  // Both messages are verbatim from the live run.
  const QWEN_MESSAGE =
    "Can't create a session. ERROR_CODE: 9, ERROR_MESSAGE: Failed to find kernel for " +
    "com.microsoft.GatherBlockQuantized(1) (node:'/model/embed_tokens/Gather_Quant' " +
    "ep:'CPUExecutionProvider'). Kernel not found";
  const LFM_MESSAGE =
    "Can't create a session. ERROR_CODE: 9, ERROR_MESSAGE: Could not find an implementation for " +
    "GatherBlockQuantized(1) node with name '/model/embed_tokens/Gather_Quant'";

  it.each([
    ['the "failed to find kernel" wording', QWEN_MESSAGE],
    ['the "could not find an implementation" wording', LFM_MESSAGE],
  ])('explains %s as a structural CPU-EP gap', (_label, message) => {
    const explanation = explainWasmLoadFailure(message);
    expect(explanation).not.toBeNull();
    expect(explanation).toContain('GatherBlockQuantized');
    expect(explanation).toContain('cannot run on the WASM backend');
    // It must not read as an output-quality finding.
    expect(explanation).toContain('rather than a sign of bad output');
  });

  it('names the gap generically when the operator is not one we recognise', () => {
    const explanation = explainWasmLoadFailure('Failed to find kernel for SomeOtherOp(3)');
    expect(explanation).toContain('an operator its build depends on');
    expect(explanation).not.toContain('GatherBlockQuantized');
  });

  it('returns null for unrelated failures so the raw message survives', () => {
    expect(explainWasmLoadFailure('Out of memory')).toBeNull();
    expect(explainWasmLoadFailure('Load aborted')).toBeNull();
  });
});

// ─── Record store ────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<BackendCrossCheckRecord> = {}): BackendCrossCheckRecord {
  return {
    version: 1,
    recordedAt: '2026-08-03T00:00:00.000Z',
    modelId: 'candidate/qwen3.5-2b-onnx',
    prompt: CROSS_CHECK_PROMPT,
    maxTokens: 96,
    outcome: 'completed',
    verdict: 'consistent',
    summary: 'ok',
    webgpuBackend: 'webgpu',
    wasmBackend: 'wasm',
    noiseFloor: NEAR_IDENTICAL_NOISE_FLOOR,
    cross: compareOutputs(CROSS_CHECK_PROMPT, HEALTHY_REFERENCE, HEALTHY_DIVERGENT_WORDING),
    timings: { webgpuMs: 1200, webgpuRepeatMs: 1180, wasmMs: 61000 },
    outputs: { webgpu: HEALTHY_DIVERGENT_WORDING, webgpuRepeat: HEALTHY_DIVERGENT_WORDING, wasm: HEALTHY_REFERENCE },
    error: null,
    ...overrides,
  };
}

describe('record store', () => {
  beforeEach(() => clearBackendCrossChecks());
  afterEach(() => clearBackendCrossChecks());

  it('round-trips a record', () => {
    recordBackendCrossCheck(makeRecord());
    const loaded = loadBackendCrossChecks();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.verdict).toBe('consistent');
    expect(loaded[0]!.outputs.wasm).toBe(HEALTHY_REFERENCE);
  });

  it('keeps the newest 10 records', () => {
    for (let i = 0; i < 14; i++) {
      recordBackendCrossCheck(makeRecord({ modelId: `model-${i}` }));
    }
    const loaded = loadBackendCrossChecks();
    expect(loaded).toHaveLength(10);
    expect(loaded[0]!.modelId).toBe('model-4');
    expect(loaded[9]!.modelId).toBe('model-13');
  });

  it('drops entries that do not parse as records instead of throwing', () => {
    localStorage.setItem(
      'eco-backend-crosscheck-records-v1',
      JSON.stringify([{ version: 99, modelId: 'old' }, makeRecord()]),
    );
    expect(loadBackendCrossChecks()).toHaveLength(1);
  });

  it('returns an empty list for malformed JSON', () => {
    localStorage.setItem('eco-backend-crosscheck-records-v1', '{not json');
    expect(loadBackendCrossChecks()).toEqual([]);
  });
});
