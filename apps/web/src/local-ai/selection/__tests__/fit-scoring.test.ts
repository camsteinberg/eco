// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase F — fit-scoring unit tests.
 *
 * The scorer is pure. Tests inject metrics + reliability directly so the
 * intent-weighting math is verifiable in isolation. Two flagship tests:
 *
 *   1. Intent shifts the winner — same two models, swap intent, different
 *      winner. (Speed-favored model wins on snappy; quality-favored model
 *      wins on quality.)
 *   2. Reliability dominates when models are otherwise tied — a model with
 *      reliability=0.6 (with-warning) loses to an otherwise-identical model
 *      with reliability=1.0 (allowed) across all intents.
 */

import { describe, expect, it } from 'vitest';
import { getModel } from '../../catalog/catalog';
import {
  INTENT_WEIGHTS,
  scoreContextFit,
  scoreFit,
  scoreMemoryFit,
  scoreSpeed,
  scoreTrust,
} from '../fit-scoring';
import type { DeviceProfile, ModelConfig } from '../../types';

const PROFILE_24GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 24,
  isMobile: false,
  override: 'auto',
};

function model(id: string): ModelConfig {
  const m = getModel(id);
  if (!m) throw new Error(`expected catalog model ${id}`);
  return m;
}

describe('INTENT_WEIGHTS', () => {
  it.each(['snappy', 'balanced', 'quality'] as const)('weights for %s sum to 1', (intent) => {
    const w = INTENT_WEIGHTS[intent];
    const sum = w.speed + w.quality + w.reliability + w.memoryFit + w.trust + w.contextFit;
    expect(sum).toBeCloseTo(1, 5);
  });

  it.each(['snappy', 'balanced', 'quality'] as const)(
    'contextFit carries no weight yet for %s (Wave 3 scaffolding is behavior-neutral)',
    (intent) => {
      expect(INTENT_WEIGHTS[intent].contextFit).toBe(0);
    },
  );
});

describe('scoreSpeed', () => {
  it('is high when firstTokenMs is very low', () => {
    expect(scoreSpeed({ firstTokenMs: 200, tokensPerSec: 30, smokePassRate: 1 })).toBeGreaterThan(0.85);
  });

  it('is low when firstTokenMs is very high', () => {
    expect(scoreSpeed({ firstTokenMs: 8000, tokensPerSec: 5, smokePassRate: 1 })).toBeLessThan(0.2);
  });

  it('rewards higher throughput at the same firstTokenMs', () => {
    const slowThroughput = scoreSpeed({ firstTokenMs: 500, tokensPerSec: 5, smokePassRate: 1 });
    const fastThroughput = scoreSpeed({ firstTokenMs: 500, tokensPerSec: 50, smokePassRate: 1 });
    expect(fastThroughput).toBeGreaterThan(slowThroughput);
  });
});

describe('scoreMemoryFit', () => {
  it('is 1 when model fits comfortably (≤25 % of RAM)', () => {
    expect(scoreMemoryFit(model('candidate/lfm2.5-350m-onnx'), PROFILE_24GB)).toBe(1);
  });

  it('drops below 1 when model is >25 % of RAM', () => {
    // Qwen3.5-2B is 1.4 GB on a 4 GB device — about 35 %, above the 25 % cliff.
    const lowMem: DeviceProfile = { ...PROFILE_24GB, deviceMemoryGB: 4 };
    expect(scoreMemoryFit(model('candidate/qwen3.5-2b-onnx'), lowMem)).toBeLessThan(1);
  });

  it('returns neutral 0.6 when memory is unknown', () => {
    const unknown: DeviceProfile = { ...PROFILE_24GB, deviceMemoryGB: 0 };
    expect(scoreMemoryFit(model('local/qwen3-0.6b'), unknown)).toBeCloseTo(0.6, 2);
  });
});

describe('scoreTrust', () => {
  it('falls back to evidenceTier when no confidence provided: proven=1, predicted=0.6, experimental=0.2', () => {
    const proven: ModelConfig = { ...model('local/qwen3-0.6b') };
    const predicted: ModelConfig = { ...model('candidate/lfm2.5-350m-onnx') };
    const experimental: ModelConfig = {
      ...proven,
      id: 'lab/exp',
      evidenceTier: 'experimental',
    };
    expect(scoreTrust(proven)).toBe(1);
    expect(scoreTrust(predicted)).toBe(0.6);
    expect(scoreTrust(experimental)).toBe(0.2);
  });

  it('uses confidence source when provided: benchmark=1, ledger=0.95, calculated=0.85', () => {
    const m: ModelConfig = { ...model('candidate/lfm2.5-350m-onnx') };
    // evidenceTier is 'predicted' (0.6) but confidence overrides it
    expect(scoreTrust(m, 'benchmark')).toBe(1);
    expect(scoreTrust(m, 'ledger')).toBe(0.95);
    expect(scoreTrust(m, 'calculated')).toBe(0.85);
  });

  it('confidence=null falls back to evidenceTier', () => {
    const proven: ModelConfig = { ...model('local/qwen3-0.6b') };
    expect(scoreTrust(proven, null)).toBe(1);
    expect(scoreTrust(proven, undefined)).toBe(1);
  });
});

describe('scoreContextFit', () => {
  it('scores a longer catalog window higher (on merit)', () => {
    // 8192-token window (at the target) beats a 4096 window beats a 2048 window (at the floor).
    const long = scoreContextFit(model('candidate/lfm2.5-1.2b-instruct-onnx')); // ctx 8192
    const mid = scoreContextFit(model('candidate/lfm2.5-350m-onnx')); // ctx 4096
    const short = scoreContextFit(model('candidate/gemma-4-e2b-litert')); // ctx 2048
    expect(long).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(short);
  });

  it('saturates: 1 at/above the target window, 0 at/below the floor', () => {
    expect(scoreContextFit(model('candidate/lfm2.5-1.2b-instruct-onnx'))).toBe(1); // ctx 8192 = target
    expect(scoreContextFit(model('candidate/gemma-4-e2b-litert'))).toBe(0); // ctx 2048 = floor
  });

  it('is decoupled from sizeGB — the largest model here scores lowest', () => {
    // gemma-4-e2b-litert is the biggest catalog model (1.87 GB) yet has the
    // SHORTEST window (2048 → 0); the 350M (0.28 GB) scores higher. Context
    // capability, not size, drives this axis (memoryFit already carries size).
    const biggestModel = scoreContextFit(model('candidate/gemma-4-e2b-litert'));
    const tinyModel = scoreContextFit(model('candidate/lfm2.5-350m-onnx'));
    expect(tinyModel).toBeGreaterThan(biggestModel);
  });
});

describe('scoreFit — contextFit is behavior-neutral (Wave 3 scaffolding)', () => {
  it('a nonzero contextFit does not move the total (weighted 0 today)', () => {
    const m = model('candidate/lfm2.5-1.2b-instruct-onnx'); // ctx 8192 → contextFit 1
    const score = scoreFit({
      model: m,
      profile: PROFILE_24GB,
      intent: 'balanced',
      metrics: { firstTokenMs: 400, tokensPerSec: 40, smokePassRate: 0.9 },
      reliability: 1,
    });
    // contextFit is genuinely nonzero here...
    expect(score.contextFit).toBe(1);
    // ...but total is exactly the five weighted axes, no contextFit term.
    const w = INTENT_WEIGHTS.balanced;
    const fiveAxisTotal =
      w.speed * score.speed
      + w.quality * score.quality
      + w.reliability * score.reliability
      + w.memoryFit * score.memoryFit
      + w.trust * score.trust;
    expect(score.total).toBeCloseTo(fiveAxisTotal, 10);
  });
});

describe('scoreFit — intent shifts the winner', () => {
  it('snappy intent prefers the faster model', () => {
    const fast = scoreFit({
      model: model('local/qwen3-0.6b'),
      profile: PROFILE_24GB,
      intent: 'snappy',
      metrics: { firstTokenMs: 200, tokensPerSec: 35, smokePassRate: 0.7 },
      reliability: 1,
    });
    const slow = scoreFit({
      model: model('local/qwen3-0.6b'),
      profile: PROFILE_24GB,
      intent: 'snappy',
      metrics: { firstTokenMs: 1500, tokensPerSec: 10, smokePassRate: 1 },
      reliability: 1,
    });
    expect(fast.total).toBeGreaterThan(slow.total);
  });

  it('quality intent prefers the higher-pass-rate model', () => {
    const speedy = scoreFit({
      model: model('local/qwen3-0.6b'),
      profile: PROFILE_24GB,
      intent: 'quality',
      metrics: { firstTokenMs: 200, tokensPerSec: 35, smokePassRate: 0.5 },
      reliability: 1,
    });
    const careful = scoreFit({
      model: model('local/qwen3-0.6b'),
      profile: PROFILE_24GB,
      intent: 'quality',
      metrics: { firstTokenMs: 1500, tokensPerSec: 10, smokePassRate: 1 },
      reliability: 1,
    });
    expect(careful.total).toBeGreaterThan(speedy.total);
  });
});

describe('scoreFit — reliability tiebreaker', () => {
  it('allowed beats with-warning when otherwise identical', () => {
    const metrics = { firstTokenMs: 1000, tokensPerSec: 15, smokePassRate: 0.9 };
    const allowed = scoreFit({
      model: model('candidate/qwen3.5-2b-onnx'),
      profile: PROFILE_24GB,
      intent: 'balanced',
      metrics,
      reliability: 1,
    });
    const warned = scoreFit({
      model: model('candidate/qwen3.5-2b-onnx'),
      profile: PROFILE_24GB,
      intent: 'balanced',
      metrics,
      reliability: 0.6,
    });
    expect(allowed.total).toBeGreaterThan(warned.total);
  });
});
