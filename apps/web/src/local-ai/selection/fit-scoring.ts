// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Fit scoring — intent-weighted scorer.
 *
 * The dead "intent" input from L1 HIGH-01 is finally wired up here. Every
 * candidate model is scored on five axes and combined via per-intent weights.
 *
 * Axes (each returns 0..1):
 *   - speed       firstTokenMs lower is better, tokensPerSec higher is better.
 *                 Measured when seed evidence exists; predicted otherwise.
 *   - quality     smokePassRate from seed evidence (or predicted reliability
 *                 inferred from evidenceTier + capabilities).
 *   - reliability admission decision: allowed=1.0, with-warning=0.6.
 *                 Denied models never reach the scorer — recommend() filters
 *                 them out structurally.
 *   - memoryFit   how comfortably the model fits the device's memory. Smaller
 *                 model on bigger device → higher score. A model that fills
 *                 ≥50 % of reported memory caps at 0.4 (audible swap risk).
 *   - trust       confidence source: benchmark=1.0, ledger=0.95,
 *                 calculated=0.85. After the confidence floor (Wave 1A),
 *                 only models with proof reach scoring — trust is now a
 *                 tie-breaker, not a gate. Falls back to evidenceTier when
 *                 no confidence source is provided (back-compat).
 *
 * Intent weights (sum to 1.0):
 *   snappy   speed 0.45, quality 0.10, reliability 0.20, memoryFit 0.15, trust 0.10
 *   balanced speed 0.25, quality 0.25, reliability 0.20, memoryFit 0.10, trust 0.20
 *   quality  speed 0.10, quality 0.45, reliability 0.20, memoryFit 0.05, trust 0.20
 *
 * `scoreFit` is pure. It does not consult the ledger or the admission gate;
 * callers (recommend.ts) inject those via the optional `metrics`,
 * `reliability`, and `confidence` parameters so the scoring is fully testable
 * in isolation.
 */

import type { DeviceProfile, Intent, ModelConfig } from '../types';
import { predictMetrics, type ScoringMetrics } from './predicted-fit';

/**
 * Confidence source for scoring — matches AvailableConfidence from
 * recommend.ts. Optional so callers that pre-date the floor can still
 * call scoreFit without it (falls back to evidenceTier).
 */
export type ConfidenceSource = 'benchmark' | 'calculated' | 'ledger';

export type FitScore = {
  speed: number;
  quality: number;
  reliability: number;
  memoryFit: number;
  trust: number;
  total: number;
};

export type IntentWeights = {
  speed: number;
  quality: number;
  reliability: number;
  memoryFit: number;
  trust: number;
};

export const INTENT_WEIGHTS: Readonly<Record<Intent, Readonly<IntentWeights>>> =
  Object.freeze({
    snappy: { speed: 0.45, quality: 0.1, reliability: 0.2, memoryFit: 0.15, trust: 0.1 },
    balanced: { speed: 0.25, quality: 0.25, reliability: 0.2, memoryFit: 0.1, trust: 0.2 },
    quality: { speed: 0.1, quality: 0.45, reliability: 0.2, memoryFit: 0.05, trust: 0.2 },
  });

const FAST_FIRST_TOKEN_MS = 250;
const SLOW_FIRST_TOKEN_MS = 5000;
const TARGET_TOKENS_PER_SEC = 30;
const MEMORY_FIT_HEADROOM_RATIO = 0.5;

export type ScoreFitInput = {
  model: ModelConfig;
  profile: DeviceProfile;
  intent: Intent;
  /** Measured or predicted metrics. If omitted, predicted metrics are used. */
  metrics?: ScoringMetrics;
  /** Reliability axis input (1.0 for admitted, 0.6 for with-warning). */
  reliability?: number;
  /**
   * Confidence source for the trust axis. When provided, trust is driven
   * by how the model was proven (benchmark > ledger > calculated). When
   * omitted, falls back to evidenceTier for back-compat with tests that
   * pre-date the confidence floor.
   */
  confidence?: ConfidenceSource | null;
};

export function scoreFit(input: ScoreFitInput): FitScore {
  const { model, profile, intent } = input;
  const metrics = input.metrics ?? predictMetrics(model, profile);
  const reliability = clamp01(input.reliability ?? 1);
  const weights = INTENT_WEIGHTS[intent];

  const speed = scoreSpeed(metrics);
  const quality = clamp01(metrics.smokePassRate);
  const memoryFit = scoreMemoryFit(model, profile);
  const trust = scoreTrust(model, input.confidence);

  const total =
    weights.speed * speed
    + weights.quality * quality
    + weights.reliability * reliability
    + weights.memoryFit * memoryFit
    + weights.trust * trust;

  return {
    speed,
    quality,
    reliability,
    memoryFit,
    trust,
    total: clamp01(total),
  };
}

export function scoreSpeed(metrics: ScoringMetrics): number {
  const firstTokenComponent = invertedScale(
    metrics.firstTokenMs,
    FAST_FIRST_TOKEN_MS,
    SLOW_FIRST_TOKEN_MS,
  );
  const throughputComponent = saturatingScale(metrics.tokensPerSec, TARGET_TOKENS_PER_SEC);
  return clamp01(0.6 * firstTokenComponent + 0.4 * throughputComponent);
}

export function scoreMemoryFit(model: ModelConfig, profile: DeviceProfile): number {
  if (profile.deviceMemoryGB <= 0) {
    // No memory reading — treat as neutral.
    return 0.6;
  }
  const ratio = model.sizeGB / profile.deviceMemoryGB;
  // ≤25 % of RAM → score 1; 50 % → 0.4; ≥100 % → 0.
  if (ratio <= 0.25) return 1;
  if (ratio <= MEMORY_FIT_HEADROOM_RATIO) {
    const t = (ratio - 0.25) / (MEMORY_FIT_HEADROOM_RATIO - 0.25);
    return clamp01(1 - 0.6 * t);
  }
  if (ratio < 1) {
    const t = (ratio - MEMORY_FIT_HEADROOM_RATIO) / (1 - MEMORY_FIT_HEADROOM_RATIO);
    return clamp01(0.4 - 0.4 * t);
  }
  return 0;
}

/**
 * Trust axis — tie-breaker between models that all pass the confidence
 * floor. When `confidence` is provided (the normal path after Wave 1A),
 * scoring is driven by how the model was proven:
 *   - benchmark: 1.0  (real measurement on similar hardware)
 *   - ledger:    0.95 (this device has personally run it)
 *   - calculated: 0.85 (we predicted; slightly below proven as tie-break)
 *
 * Falls back to evidenceTier when confidence is not provided (back-compat
 * for tests and call sites that pre-date the floor).
 */
export function scoreTrust(model: ModelConfig, confidence?: ConfidenceSource | null): number {
  if (confidence != null) {
    switch (confidence) {
      case 'benchmark':
        return 1;
      case 'ledger':
        return 0.95;
      case 'calculated':
        return 0.85;
    }
  }
  // Fallback: evidenceTier-based scoring (pre-floor back-compat)
  switch (model.evidenceTier) {
    case 'proven':
      return 1;
    case 'predicted':
      return 0.6;
    case 'experimental':
    default:
      return 0.2;
  }
}

function invertedScale(value: number, lowGood: number, highBad: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  if (value <= lowGood) return 1;
  if (value >= highBad) return 0;
  return 1 - (value - lowGood) / (highBad - lowGood);
}

function saturatingScale(value: number, target: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  return clamp01(value / target);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
