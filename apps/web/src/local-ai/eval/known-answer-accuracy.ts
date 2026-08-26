// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Known-answer accuracy — the headline "did it get the answer right" number,
 * computed from exactly the known-answer probe set (never diluted into a
 * composite). The sibling of `leak-rate.ts`.
 */

import { KNOWN_ANSWER_PROBE_IDS } from './known-answer-probes';
import type { EvalResult, EvalRun } from './types';

export type ModelKnownAnswerAccuracy = {
  modelId: string;
  /** Results that produced a scored exactness value (errors excluded). */
  scoredCount: number;
  /** Mean exactness over scored results (0..1). `null` when nothing scored. */
  accuracy: number | null;
  /** Fraction of scored results with exactness === 1 (a right answer, no trap). */
  strictAccuracy: number | null;
  /** Prompt ids where no right answer was stated (exactness 0). */
  wrongPromptIds: string[];
  /** Prompt ids where a right AND a trap answer both appeared (exactness 0.5). */
  ambiguousPromptIds: string[];
};

function isKnownAnswerResult(result: EvalResult): boolean {
  return result.category === 'known-answer' && KNOWN_ANSWER_PROBE_IDS.has(result.promptId);
}

export function computeKnownAnswerAccuracy(run: EvalRun): ModelKnownAnswerAccuracy[] {
  const byModel = new Map<string, EvalResult[]>();
  for (const result of run.results) {
    if (!isKnownAnswerResult(result)) continue;
    const bucket = byModel.get(result.modelId);
    if (bucket) bucket.push(result);
    else byModel.set(result.modelId, [result]);
  }

  const out: ModelKnownAnswerAccuracy[] = [];
  for (const [modelId, results] of byModel) {
    const scored = results.filter((r) => typeof r.scores.exactness === 'number');
    const scoredCount = scored.length;
    const wrongPromptIds = scored.filter((r) => r.scores.exactness === 0).map((r) => r.promptId);
    const ambiguousPromptIds = scored
      .filter((r) => r.scores.exactness === 0.5)
      .map((r) => r.promptId);
    if (scoredCount === 0) {
      out.push({
        modelId,
        scoredCount: 0,
        accuracy: null,
        strictAccuracy: null,
        wrongPromptIds,
        ambiguousPromptIds,
      });
      continue;
    }
    const sum = scored.reduce((acc, r) => acc + (r.scores.exactness as number), 0);
    const strict = scored.filter((r) => r.scores.exactness === 1).length;
    out.push({
      modelId,
      scoredCount,
      accuracy: sum / scoredCount,
      strictAccuracy: strict / scoredCount,
      wrongPromptIds,
      ambiguousPromptIds,
    });
  }
  return out;
}
