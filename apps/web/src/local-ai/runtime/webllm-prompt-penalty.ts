// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A repetition penalty over the whole prompt, for the WebLLM runtime.
 *
 * WebLLM 0.2.84 applies `repetition_penalty` only to the tokens it generated
 * in the current round (`appearedTokensFreq`, cleared at every prefill), so
 * the prompt is never penalised and a small model can copy an earlier reply
 * out of its history. This processor applies the Hugging Face
 * `RepetitionPenaltyLogitsProcessor` rule instead: every id in (prompt ∪
 * generated so far) is penalised once — `logit < 0 ? logit * p : logit / p` —
 * which is what the Transformers runtime already does over its whole input.
 *
 * It plugs into WebLLM's `LogitProcessor` hook, which runs on the CPU before
 * the engine's own logit bias and penalty steps.
 */

import type { LogitProcessor } from '@mlc-ai/web-llm';

export class PromptRepetitionPenalty implements LogitProcessor {
  private readonly penalty: number;
  private readonly readPromptIds: () => Iterable<number>;
  private readonly seen = new Set<number>();
  private promptRead = false;

  /**
   * @param readPromptIds Returns the ids of the prompt the engine prefilled.
   *   Called once per round, on the first logits — after prefill, because the
   *   engine resets its processor and replaces its conversation during
   *   `create()`, so nothing installed before `create()` would survive.
   */
  constructor(penalty: number, readPromptIds: () => Iterable<number>) {
    this.penalty = penalty;
    this.readPromptIds = readPromptIds;
  }

  processLogits(logits: Float32Array): Float32Array {
    if (!this.promptRead) {
      for (const id of this.readPromptIds()) this.seen.add(id);
      this.promptRead = true;
    }
    for (const id of this.seen) {
      const logit = logits[id];
      if (logit === undefined) continue;
      logits[id] = logit < 0 ? logit * this.penalty : logit / this.penalty;
    }
    return logits;
  }

  processSampledToken(token: number): void {
    this.seen.add(token);
  }

  resetState(): void {
    this.seen.clear();
    this.promptRead = false;
  }
}
