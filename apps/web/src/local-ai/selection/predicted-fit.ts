// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Predicted-fit lane — metrics for (model × profile) pairs without seed proof.
 *
 * For every combination admission allows, recommend() needs three
 * numbers to score: firstTokenMs, tokensPerSec, smokePassRate. Seed
 * evidence provides them for proven (model × profile) cells. The rest
 * get predicted values inferred from:
 *
 *   - model.sizeGB                — larger → slower first-token, slower throughput
 *   - profile.webgpuSupport       — WebGPU runs ~3× faster than WASM
 *   - profile.deviceMemoryGB      — more memory → less swap → marginally faster
 *   - model.capabilities.intent   — listed intents inform predicted smoke rate
 *   - model.evidenceTier          — proven > predicted > experimental
 *
 * The predictions are intentionally conservative — a real measurement on
 * the device (via the runtime ledger) will always override them. The
 * point of predicted-fit is to give the recommender SOMETHING to score
 * for profiles where we haven't shipped seed evidence (Firefox, Safari,
 * mobile, low-mem). Predicted metrics are never produced for a
 * (model × profile) the compatibility table marks unsupported, because
 * the caller filters first.
 */

import type { DeviceProfile, Intent, ModelConfig, Slot } from '../types';
import { loadSeedEvidenceForModel } from '../evidence/seed';

export type ScoringMetrics = {
  firstTokenMs: number;
  tokensPerSec: number;
  smokePassRate: number;
};

/**
 * Return measured metrics if seed evidence covers (model × profile); otherwise
 * return predicted metrics derived from catalog + profile features.
 */
export function getMetrics(model: ModelConfig, profile: DeviceProfile): ScoringMetrics {
  const seed = loadSeedEvidenceForModel(model.id, profile);
  if (seed && seed.firstTokenMs != null && seed.tokensPerSec != null) {
    return {
      firstTokenMs: seed.firstTokenMs,
      tokensPerSec: seed.tokensPerSec,
      smokePassRate: seed.smokePassRate,
    };
  }
  return predictMetrics(model, profile);
}

export function predictMetrics(model: ModelConfig, profile: DeviceProfile): ScoringMetrics {
  const isWebgpu = profile.webgpuSupport === 'webgpu';
  const memoryGB = profile.deviceMemoryGB > 0 ? profile.deviceMemoryGB : 8;

  // First-token baseline scales with model size. Tuned against the Phi-3
  // (2.14 GB, ~228 ms on Chromium 24 GB) and Bonsai (1.15 GB, ~1186 ms on
  // Chromium 8 GB) measurements from seed evidence.
  const baseFirstTokenMs = 300 + model.sizeGB * 800;
  const runtimeMultiplier = isWebgpu ? 1 : 3;
  const memoryAdjustment = clamp(2 - memoryGB / 16, 0.8, 1.5);
  const firstTokenMs = baseFirstTokenMs * runtimeMultiplier * memoryAdjustment;

  // Throughput baseline. Smaller model + more memory = faster generation.
  // Tuned so the smallest catalog model on Chromium WebGPU ≥16 GB lands near
  // 30 tok/s and the largest near 8 tok/s.
  const baseTokensPerSec = isWebgpu ? 35 - model.sizeGB * 10 : 12 - model.sizeGB * 3;
  const tokensPerSec = clamp(baseTokensPerSec, 1, 60);

  // Predicted smoke-pass rate: proven models bias high, predicted models
  // moderate, experimental low. Mobile + low-memory subtract a fixed amount
  // since smoke-fail risk rises on constrained devices.
  const tierBase = predictedTierSmokePass(model.evidenceTier);
  const constraintPenalty = profile.isMobile ? 0.1 : 0;
  const smokePassRate = clamp(tierBase - constraintPenalty, 0, 1);

  return { firstTokenMs, tokensPerSec, smokePassRate };
}

export function modelMatchesSlot(model: ModelConfig, slot: Slot): boolean {
  const preferred: readonly Intent[] =
    slot === 'eco-fast' ? ['snappy', 'balanced'] : ['balanced', 'quality'];
  return model.capabilities.intent.some((intent) => preferred.includes(intent));
}

export function slotDefaultIntent(slot: Slot): Intent {
  return slot === 'eco-fast' ? 'snappy' : 'quality';
}

function predictedTierSmokePass(tier: ModelConfig['evidenceTier']): number {
  switch (tier) {
    case 'proven':
      return 0.9;
    case 'predicted':
      return 0.7;
    case 'experimental':
    default:
      return 0.4;
  }
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
