// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Per-generation confidence recorder — pure math, no side effects.
 *
 * WHY THIS EXISTS: a confidence-gated retrieval trigger is only sound if the
 * model's own token probabilities actually separate right answers from wrong
 * ones. That has never been measured for models this small (350M–2.6B). This
 * module records the signal — per-step log-probabilities and entropy — so that
 * answer correctness can be plotted against these numbers BEFORE any gate is
 * built. Nothing here gates or alters generation.
 *
 * The logits processor (for the Transformers.js path) observes the raw logits
 * at each decode step, computes log-softmax → top-1 log-probability and
 * Shannon entropy, and accumulates a running summary. It returns the logits
 * UNCHANGED — it is a passive observer.
 *
 * Under greedy decoding (do_sample: false, temperature 0) the top-1 token IS
 * the chosen token, so `top1LogProb` is exact. Under sampling the top-1 is an
 * approximation: the sampled token may differ. The `greedy` flag on the
 * summary records which regime produced this data.
 */

// ─── Summary shape ─────────────────────────────────────────────────────────

export type ConfidenceSummary = {
  /** Number of decode steps observed. */
  steps: number;
  /** Minimum top-1 log-probability across all steps. */
  minTop1LogProb: number;
  /** Step index (0-based) where the minimum occurred. */
  minAt: number;
  /** Arithmetic mean of top-1 log-probabilities. */
  meanTop1LogProb: number;
  /** Arithmetic mean of per-step Shannon entropy (nats). */
  meanEntropy: number;
  /** Maximum per-step Shannon entropy (nats). */
  maxEntropy: number;
  /** Step index (0-based) where the maximum entropy occurred. */
  maxEntropyAt: number;
  /** True when decoding was greedy (do_sample: false / temperature 0), meaning
   *  top-1 log-prob is the EXACT chosen-token log-prob. Under sampling it is
   *  an approximation — the sampled token may differ from argmax. */
  greedy: boolean;
};

// ─── Pure math helpers ─────────────────────────────────────────────────────

/**
 * In-place log-softmax over a Float32Array: `out[i] = logits[i] - log(sum(exp(logits)))`.
 *
 * Uses the max-subtraction trick for numerical stability. Writes into `out`
 * (which may alias `logits` if the caller wants to overwrite). Returns `out`.
 */
export function logSoftmax(logits: Float32Array, out: Float32Array): Float32Array {
  const n = logits.length;
  // Find max for numerical stability.
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = logits[i]!; // loop bound guarantees valid index
    if (v > max) max = v;
  }
  // Sum of exp(logits - max).
  let sumExp = 0;
  for (let i = 0; i < n; i++) {
    sumExp += Math.exp(logits[i]! - max);
  }
  const logSumExp = max + Math.log(sumExp);
  for (let i = 0; i < n; i++) {
    out[i] = logits[i]! - logSumExp;
  }
  return out;
}

/**
 * Shannon entropy (in nats) from log-probabilities.
 * `H = -sum(p * log(p)) = -sum(exp(logp) * logp)`.
 *
 * Skips entries where `exp(logp)` is effectively zero to avoid `0 * -Inf = NaN`.
 */
export function entropyFromLogProbs(logProbs: Float32Array): number {
  let h = 0;
  for (let i = 0; i < logProbs.length; i++) {
    const lp = logProbs[i]!; // loop bound guarantees valid index
    const p = Math.exp(lp);
    if (p > 0) {
      h -= p * lp;
    }
  }
  return h;
}

/**
 * Index of the maximum value in a Float32Array.
 */
export function argmax(arr: Float32Array): number {
  let best = 0;
  let bestVal = arr[0]!; // caller guarantees non-empty
  for (let i = 1; i < arr.length; i++) {
    const v = arr[i]!; // loop bound guarantees valid index
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

// ─── Running summary accumulator ───────────────────────────────────────────

/**
 * Accumulates per-step confidence statistics across a generation.
 *
 * Call `recordStep(logits)` once per decode step (with the raw logits row for
 * the single sequence). After generation, call `summarize(greedy)` to get the
 * final `ConfidenceSummary`.
 *
 * Reuses a single `Float32Array` buffer for log-softmax output to avoid
 * per-step allocation.
 */
export class ConfidenceAccumulator {
  private steps = 0;
  private sumTop1LogProb = 0;
  private minTop1LogProb = Infinity;
  private minAt = 0;
  private sumEntropy = 0;
  private maxEntropy = -Infinity;
  private maxEntropyAt = 0;
  /** Reusable buffer — allocated on first use, grown if vocab size changes. */
  private buf: Float32Array | null = null;

  /**
   * Record one decode step's logits. The Float32Array is the raw logit row
   * for the single sequence (vocab-sized).
   */
  recordStep(logits: Float32Array): void {
    const vocabSize = logits.length;
    if (this.buf === null || this.buf.length < vocabSize) {
      this.buf = new Float32Array(vocabSize);
    }
    const logProbs = logSoftmax(logits, this.buf);

    const top1Idx = argmax(logProbs);
    const top1LogProb = logProbs[top1Idx]!; // argmax returns a valid index
    const entropy = entropyFromLogProbs(logProbs);

    if (top1LogProb < this.minTop1LogProb) {
      this.minTop1LogProb = top1LogProb;
      this.minAt = this.steps;
    }
    if (entropy > this.maxEntropy) {
      this.maxEntropy = entropy;
      this.maxEntropyAt = this.steps;
    }

    this.sumTop1LogProb += top1LogProb;
    this.sumEntropy += entropy;
    this.steps++;
  }

  /**
   * Produce the final summary. Returns `null` if no steps were recorded.
   *
   * @param greedy Whether the generation used greedy decoding. When true,
   *   top-1 log-prob is the exact chosen-token probability. When false
   *   (sampling), it is an approximation.
   */
  summarize(greedy: boolean): ConfidenceSummary | null {
    if (this.steps === 0) return null;
    return {
      steps: this.steps,
      minTop1LogProb: this.minTop1LogProb,
      minAt: this.minAt,
      meanTop1LogProb: this.sumTop1LogProb / this.steps,
      meanEntropy: this.sumEntropy / this.steps,
      maxEntropy: this.maxEntropy,
      maxEntropyAt: this.maxEntropyAt,
      greedy,
    };
  }
}
