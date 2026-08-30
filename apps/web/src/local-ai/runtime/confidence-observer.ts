// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * A passive logits observer for Transformers.js generation.
 *
 * `LogitsProcessorList._call` invokes each entry as a FUNCTION —
 * `processor(input_ids, logits)` (logits_process.js:86) — which works because
 * `LogitsProcessor` extends `Callable`, whose constructor returns a Proxy that
 * routes calls to `_call`. A plain object with a `_call` method is NOT
 * callable and throws `TypeError: … is not a function` on the first decode
 * step. So the observer must be a real subclass; this module is the only
 * place that knows that.
 */

import { LogitsProcessor, type Tensor } from '@huggingface/transformers';
import type { ConfidenceAccumulator } from './confidence';

export class ConfidenceObserver extends LogitsProcessor {
  constructor(private readonly acc: ConfidenceAccumulator) {
    super();
  }

  /** Records the step and returns the logits UNCHANGED. */
  override _call(_input_ids: bigint[][], logits: Tensor): Tensor {
    // Record only float32 logits. Any other dtype would be read as the wrong
    // numbers and silently corrupt calibration data; skipping leaves
    // `confidence` absent on the receipt, which is honest.
    if (logits.type === 'float32' && logits.data instanceof Float32Array) {
      this.acc.recordStep(logits.data);
    }
    return logits;
  }
}
