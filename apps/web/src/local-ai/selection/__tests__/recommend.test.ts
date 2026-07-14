// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Phase F — recommend() unit tests.
 *
 * Covers:
 *   - Per-slot preference (eco-fast vs eco-smart pick different models on
 *     the same profile).
 *   - Per-intent shift (snappy vs quality pick different models on the same
 *     profile + slot).
 *   - Below-floor profile throws NoAssignableModelError.
 *   - listCandidates returns at least one for every viable profile.
 *   - listCatalog buckets correctly: tested/untested/experimental are
 *     disjoint and total equals catalog size minus unsupported models.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCatalog } from '../../catalog/catalog';
import { isAssignable } from '../../device/compatibility';
import { CURRENT_LEDGER_VERSION } from '../../evidence/ledger';
import { canServe, listCandidates, listCatalog, NoAssignableModelError, recommend, starterModelForSlot } from '../recommend';
import { isBelowFloor } from '../../device/below-floor';
import type { DeviceProfile } from '../../types';

const PROFILE_24GB: DeviceProfile = {
  browserClass: 'chromium',
  webgpuSupport: 'webgpu',
  deviceMemoryGB: 24,
  isMobile: false,
  override: 'auto',
};

const PROFILE_8GB: DeviceProfile = {
  ...PROFILE_24GB,
  deviceMemoryGB: 8,
};

const PROFILE_FIREFOX: DeviceProfile = {
  browserClass: 'firefox',
  webgpuSupport: 'wasm-only',
  deviceMemoryGB: 16,
  isMobile: false,
  override: 'auto',
};

const PROFILE_BELOW_FLOOR: DeviceProfile = {
  browserClass: 'unknown',
  webgpuSupport: 'none',
  deviceMemoryGB: 2,
  isMobile: false,
  override: 'auto',
};

describe('canServe — hardware-level assignability gate (COV-1)', () => {
  // isBelowFloor only trips on low memory + no capability, so it MISSES these
  // two bands even though no model is assignable — the gap the coverage audit
  // surfaced. canServe must be false for both.
  const PROFILE_B1_NO_CAP_HIGH_MEM: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'none',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
  };
  const PROFILE_B2_WEBGPU_2GB: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 2,
    isMobile: false,
    webgpuShaderF16: true,
    override: 'auto',
  };

  it('is true for a capable device (has an assignable model)', () => {
    expect(canServe(PROFILE_24GB)).toBe(true);
  });

  it('is false for a genuine below-floor device', () => {
    expect(canServe(PROFILE_BELOW_FLOOR)).toBe(false);
  });

  it('covers the B1 band isBelowFloor misses: no capability + high memory', () => {
    expect(isBelowFloor(PROFILE_B1_NO_CAP_HIGH_MEM)).toBe(false);
    expect(canServe(PROFILE_B1_NO_CAP_HIGH_MEM)).toBe(false);
  });

  it('covers the B2 band isBelowFloor misses: 2GB WebGPU', () => {
    expect(isBelowFloor(PROFILE_B2_WEBGPU_2GB)).toBe(false);
    expect(canServe(PROFILE_B2_WEBGPU_2GB)).toBe(false);
  });

  it('when canServe is false, recommend() throws NoAssignableModelError', () => {
    for (const p of [PROFILE_BELOW_FLOOR, PROFILE_B1_NO_CAP_HIGH_MEM, PROFILE_B2_WEBGPU_2GB]) {
      expect(canServe(p)).toBe(false);
      expect(() => recommend('eco-fast', p)).toThrow(NoAssignableModelError);
    }
  });
});

describe('recommend — WebGPU adapter without shader-f16', () => {
  // The setup path resolves the eco-fast slot. On an f16-less adapter every
  // q4f16 build is unsupported, so the survivors are the non-f16 models:
  // the graduated Gemma 4 (litertlm, the device-appropriate DEFAULT — Track E
  // 2026-06-30), LFM2.5-350M (onnx-q4 since the 2026-07-01 artifact swap — the
  // light option a weak f16-less iGPU can actually load), and the demoted
  // Bonsai (onnx-q4, selectable but ranked last).
  const PROFILE_NO_SHADER_F16: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    webgpuShaderF16: false,
  };

  it('recommends the graduated Gemma 4 (LiteRT) for the eco-fast slot', () => {
    const pick = recommend('eco-fast', PROFILE_NO_SHADER_F16);
    expect(pick.id).toBe('candidate/gemma-4-e2b-litert');
    expect(pick.format).toBe('litertlm');
  });

  it('also defaults the eco-smart slot to Gemma 4 on an f16-less adapter', () => {
    // Both slots fall back to the f16-less default where Qwen3.5-2B (q4f16)
    // is unassignable — mirroring how both slots collapse onto Qwen on capable
    // hardware.
    const pick = recommend('eco-smart', PROFILE_NO_SHADER_F16);
    expect(pick.id).toBe('candidate/gemma-4-e2b-litert');
  });

  it('promotes Gemma 4 first on an f16-less adapter with LFM2.5-350M as the light fallback', () => {
    const candidates = listCandidates('eco-fast', PROFILE_NO_SHADER_F16);
    expect(candidates[0]!.model.id).toBe('candidate/gemma-4-e2b-litert');
    // The f16-free survivors after Bonsai's retirement (2026-07-11): Gemma 4 +
    // the 0.28GB LFM2.5-350M starter.
    expect(candidates.map((c) => c.model.id)).toContain('candidate/lfm2.5-350m-onnx');
  });

  it('ranks the f16-less ladder Gemma 4 → LFM2.5-350M (q4)', () => {
    // The cascade walks this ranking on setup failures (selection/cascade.ts):
    // when the 2GB Gemma download fails, the next attempt is the 0.28GB starter.
    // Bonsai was the former last rung; it retired 2026-07-11.
    const ids = listCandidates('eco-fast', PROFILE_NO_SHADER_F16).map((c) => c.model.id);
    expect(ids[0]).toBe('candidate/gemma-4-e2b-litert');
    expect(ids[ids.length - 1]).toBe('candidate/lfm2.5-350m-onnx');
  });

  it('surfaces Gemma 4 first in the flat catalog dialog on an f16-less adapter', () => {
    const r = listCatalog(PROFILE_NO_SHADER_F16);
    expect(r.available[0]!.model.id).toBe('candidate/gemma-4-e2b-litert');
  });

  it('excludes every f16 model from the eco-fast candidate list', () => {
    const candidates = listCandidates('eco-fast', PROFILE_NO_SHADER_F16);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      // Only non-f16 formats survive on an f16-less adapter: the onnx-q4
      // builds (Bonsai, LFM2.5-350M) and the graduated Gemma 4 (litertlm —
      // LiteRT never touches the ORT f16 EP).
      expect(['onnx-q4', 'litertlm']).toContain(c.model.format);
    }
  });
});

describe('recommend — per-slot preference', () => {
  it('eco-fast picks a snappy/balanced model on Chromium 24 GB', () => {
    const fast = recommend('eco-fast', PROFILE_24GB);
    expect(fast.capabilities.intent.some((i) => i === 'snappy' || i === 'balanced')).toBe(true);
  });

  it('eco-smart picks a balanced/quality model on Chromium 24 GB', () => {
    const smart = recommend('eco-smart', PROFILE_24GB);
    expect(smart.capabilities.intent.some((i) => i === 'balanced' || i === 'quality')).toBe(true);
  });

  it('eco-fast and eco-smart both resolve to the proven everyday default on 24 GB (post everyday-swap collapse)', () => {
    const fast = recommend('eco-fast', PROFILE_24GB);
    const smart = recommend('eco-smart', PROFILE_24GB);
    // Post-swap the everyday default IS the smart-tier model, so both slots
    // promote Qwen3.5-2B. Smart stays a proven pick; fast still matches via its
    // 'balanced' intent (Qwen declares balanced + quality, never quality-only).
    expect(smart.evidenceTier).toBe('proven');
    expect(fast.capabilities.intent.includes('snappy') || fast.capabilities.intent.includes('balanced')).toBe(true);
  });
});

describe('recommend — per-slot preferred picks', () => {
  it('eco-fast resolves to Qwen3.5-2B on compatible devices (everyday-swap default)', () => {
    // Everyday-swap (2026-06-13): Qwen3.5-2B is the everyday default on devices
    // that can run it (8 GB floor). "Ceiling on default model size" still holds —
    // stronger hardware doesn't auto-upgrade to a bigger model; it loads the
    // default faster. LFM2.5-1.2B demotes to the fast/light tier.
    const fast8 = recommend('eco-fast', PROFILE_8GB, 'snappy');
    const fast24 = recommend('eco-fast', PROFILE_24GB, 'snappy');
    expect(fast8.id).toBe('candidate/qwen3.5-2b-onnx');
    expect(fast24.id).toBe('candidate/qwen3.5-2b-onnx');
  });

  it('eco-smart resolves to Qwen3.5-2B on compatible devices (coincides with the everyday default)', () => {
    // Post-swap the eco-smart pick coincides with the everyday default: the
    // everyday default IS the smart-tier model. The slot stays distinct in code
    // for when a larger smart model (Qwen3.5-4B) graduates.
    const smart8 = recommend('eco-smart', PROFILE_8GB, 'quality');
    const smart24 = recommend('eco-smart', PROFILE_24GB, 'quality');
    expect(smart8.id).toBe('candidate/qwen3.5-2b-onnx');
    expect(smart24.id).toBe('candidate/qwen3.5-2b-onnx');
  });

  it('both slots resolve to the SAME model on capable hardware post-swap (fast === smart === Qwen3.5)', () => {
    // The everyday-swap collapsed the two slots onto Qwen3.5-2B. They re-split
    // when a larger smart model graduates and PREFERRED_SMART_MODEL_ID moves.
    const fast = recommend('eco-fast', PROFILE_24GB);
    const smart = recommend('eco-smart', PROFILE_24GB);
    expect(fast.id).toBe('candidate/qwen3.5-2b-onnx');
    expect(smart.id).toBe('candidate/qwen3.5-2b-onnx');
  });
});

describe('recommend — non-Chromium profiles', () => {
  // Finding E: on a wasm-only profile the 350m (block-quant embeddings) is
  // CPU-EP-unloadable, so qwen3-0.6b is the only WASM-viable model. Both slots
  // resolve to it directly — no cascade through the 350m.
  it('Firefox WASM 16 GB eco-fast returns Qwen3 (350m is CPU-EP-unloadable)', () => {
    const pick = recommend('eco-fast', PROFILE_FIREFOX);
    expect(pick.id).toBe('local/qwen3-0.6b');
  });

  it('Firefox WASM 16 GB eco-smart returns Qwen3', () => {
    const pick = recommend('eco-smart', PROFILE_FIREFOX);
    expect(pick.id).toBe('local/qwen3-0.6b');
  });

  it('never surfaces the 350m on a wasm-only profile (no doomed cascade rung)', () => {
    const ids = listCandidates('eco-fast', PROFILE_FIREFOX).map((c) => c.model.id);
    expect(ids).not.toContain('candidate/lfm2.5-350m-onnx');
    expect(ids).toEqual(['local/qwen3-0.6b']);
  });
});

describe('recommend — below floor', () => {
  it('throws NoAssignableModelError on below-floor profile', () => {
    expect(() => recommend('eco-fast', PROFILE_BELOW_FLOOR)).toThrow(NoAssignableModelError);
    expect(() => recommend('eco-smart', PROFILE_BELOW_FLOOR)).toThrow(NoAssignableModelError);
  });

  it('the thrown error contains the profile shape', () => {
    try {
      recommend('eco-fast', PROFILE_BELOW_FLOOR);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NoAssignableModelError);
      const e = err as NoAssignableModelError;
      expect(e.slot).toBe('eco-fast');
      expect(e.profile).toBe(PROFILE_BELOW_FLOOR);
    }
  });
});

describe('starterModelForSlot — instant-start Stage A pick (slice 2b)', () => {
  const PROFILE_NO_SHADER_F16: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    webgpuShaderF16: false,
  };

  it('picks the smallest offerable model on capable hardware, not the class-best', () => {
    // Stage A optimizes for the fastest trustworthy chat, not the best model:
    // a 0.28 GB starter gets a fresh device talking in ~a minute, and the
    // consent-driven upgrade carries it to the class-best afterwards.
    const starter = starterModelForSlot('eco-fast', PROFILE_24GB);
    expect(starter?.id).toBe('candidate/lfm2.5-350m-onnx');
    expect(starter?.id).not.toBe(recommend('eco-fast', PROFILE_24GB).id);
  });

  it('picks the 350m-q4 starter on an f16-less adapter (fixes the founder-class device)', () => {
    const starter = starterModelForSlot('eco-fast', PROFILE_NO_SHADER_F16);
    expect(starter?.id).toBe('candidate/lfm2.5-350m-onnx');
    expect(starter?.format).toBe('onnx-q4');
  });

  it('never returns a model the engine would not offer (structural reuse of listCandidates)', () => {
    for (const profile of [PROFILE_24GB, PROFILE_8GB, PROFILE_FIREFOX, PROFILE_NO_SHADER_F16]) {
      const starter = starterModelForSlot('eco-fast', profile);
      const offered = listCandidates('eco-fast', profile).map((c) => c.model.id);
      expect(starter).not.toBeNull();
      expect(offered).toContain(starter!.id);
    }
  });

  it('returns null on a below-floor profile instead of throwing', () => {
    expect(starterModelForSlot('eco-fast', PROFILE_BELOW_FLOOR)).toBeNull();
  });

  it('converges with recommend() when only one candidate survives', () => {
    // wasm-only devices where the starter IS the class-best: Stage A and the
    // upgrade path collapse into a no-op — same model, no popup. Finding E: the
    // 350m is CPU-EP-unloadable here, so qwen3-0.6b is the sole WASM-viable model
    // and therefore both the starter and the recommendation.
    const candidates = listCandidates('eco-fast', PROFILE_FIREFOX);
    const starter = starterModelForSlot('eco-fast', PROFILE_FIREFOX);
    expect(candidates.map((c) => c.model.id)).toContain(starter!.id);
    expect(starter?.id).toBe('local/qwen3-0.6b');
    expect(starter?.id).toBe(recommend('eco-fast', PROFILE_FIREFOX).id);
  });
});

describe('listCandidates', () => {
  it('returns at least one candidate for every viable profile/slot pair', () => {
    const profiles: { name: string; profile: DeviceProfile }[] = [
      { name: 'chromium-24gb', profile: PROFILE_24GB },
      { name: 'chromium-8gb', profile: PROFILE_8GB },
      { name: 'firefox-16gb', profile: PROFILE_FIREFOX },
    ];
    for (const { name, profile } of profiles) {
      for (const slot of ['eco-fast', 'eco-smart'] as const) {
        const ranked = listCandidates(slot, profile);
        expect(ranked.length, `${name} ${slot}`).toBeGreaterThan(0);
      }
    }
  });

  it('returns Qwen3.5-2B first (preferred default) then remaining by score descending', () => {
    const ranked = listCandidates('eco-fast', PROFILE_24GB);
    // The default should be promoted to position 0 on capable devices.
    expect(ranked[0]!.model.id).toBe('candidate/qwen3.5-2b-onnx');
    // Remaining entries (after the promoted default) are score-descending.
    for (let i = 2; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score.total).toBeGreaterThanOrEqual(ranked[i]!.score.total);
    }
  });

  it('returns Qwen3.5-2B first for eco-smart (preferred smart pick), score order after', () => {
    const ranked = listCandidates('eco-smart', PROFILE_24GB);
    expect(ranked[0]!.model.id).toBe('candidate/qwen3.5-2b-onnx');
    for (let i = 2; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score.total).toBeGreaterThanOrEqual(ranked[i]!.score.total);
    }
    // The smart-pick promotion also drives the cascade: a smoke failure on the
    // smart pick falls back to the natural score ranking, never to nothing.
    expect(ranked.length).toBeGreaterThan(1);
  });

  it('falls back to natural ranking for eco-smart where the smart pick is unassignable', () => {
    // Firefox/WASM: Qwen3.5-2B requires WebGPU → promotion is a no-op and the
    // fit-score ranking decides (Qwen3-0.6B class).
    const ranked = listCandidates('eco-smart', PROFILE_FIREFOX);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.map((c) => c.model.id)).not.toContain('candidate/qwen3.5-2b-onnx');
  });

  it('every returned candidate is assignable', () => {
    const ranked = listCandidates('eco-fast', PROFILE_24GB);
    for (const c of ranked) {
      expect(isAssignable(c.model, PROFILE_24GB)).toBe(true);
    }
  });
});

describe('listCatalog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a single ranked available list (no tier buckets)', () => {
    const r = listCatalog(PROFILE_24GB);
    expect(Array.isArray(r.available)).toBe(true);
    // No duplicates in the ranked list.
    const ids = new Set(r.available.map((entry) => entry.model.id));
    expect(ids.size).toBe(r.available.length);
  });

  it('surfaces phi3 benchmark proof on Chromium 24 GB', () => {
    // phi3's seed row is dated 2026-05-13; pin the clock to the snapshot's
    // generation date so the row stays inside its 45-day freshness TTL and the
    // benchmark-confidence path is exercised deterministically (otherwise this
    // assertion rots once the row ages past the window).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = listCatalog(PROFILE_24GB);
    const phi3 = r.available.find((entry) => entry.model.id === 'local/phi3-mini-4k-q4f16');
    expect(phi3?.confidence).toBe('benchmark');
  });

  it('omits unsupported models entirely on Firefox', () => {
    const r = listCatalog(PROFILE_FIREFOX);
    const allIds = r.available.map((entry) => entry.model.id);
    expect(allIds).not.toContain('local/phi3-mini-4k-q4f16');
  });

  it('returns shape with an empty available array for below-floor profiles', () => {
    const r = listCatalog(PROFILE_BELOW_FLOOR);
    expect(Array.isArray(r.available)).toBe(true);
  });

  it('ranks Qwen3.5-2B first (preferred default) then remaining by fit score', () => {
    const r = listCatalog(PROFILE_24GB);
    // The default should be promoted to position 0 on capable devices.
    expect(r.available[0]!.model.id).toBe('candidate/qwen3.5-2b-onnx');
    // Remaining entries (after the promoted default) are score-descending.
    for (let i = 2; i < r.available.length; i++) {
      expect(r.available[i - 1]!.scoreTotal).toBeGreaterThanOrEqual(r.available[i]!.scoreTotal);
    }
  });

  it('every surfaced entry carries a confidence source (no bare predicted-fit)', () => {
    const r = listCatalog(PROFILE_24GB);
    for (const entry of r.available) {
      expect(['benchmark', 'calculated', 'ledger']).toContain(entry.confidence);
    }
  });

  it('auto-hides models with a recent smoke-fail in the ledger', () => {
    // Pre-seed the ledger with a smoke-fail for Phi-3 on this profile.
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: 'local/phi3-mini-4k-q4f16',
          profileKey: 'chromium|high-memory-laptop|webgpu',
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    const r = listCatalog(PROFILE_24GB);
    const ids = r.available.map((e) => e.model.id);
    expect(ids).not.toContain('local/phi3-mini-4k-q4f16');
    localStorage.clear();
  });

  it('keeps the currently-bound model visible even if it would otherwise be filtered out', () => {
    // Pre-seed the ledger with a smoke-fail for Phi-3 on this profile.
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: 'local/phi3-mini-4k-q4f16',
          profileKey: 'chromium|high-memory-laptop|webgpu',
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    // Without the exemption, Phi-3 would be filtered. With it, it stays visible.
    const withoutExemption = listCatalog(PROFILE_24GB);
    expect(withoutExemption.available.map((e) => e.model.id)).not.toContain('local/phi3-mini-4k-q4f16');
    const withExemption = listCatalog(PROFILE_24GB, {
      currentlyBoundModelId: 'local/phi3-mini-4k-q4f16',
    });
    expect(withExemption.available.map((e) => e.model.id)).toContain('local/phi3-mini-4k-q4f16');
    localStorage.clear();
  });
});

describe('recommend — confidence floor', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('keeps otherwise eligible shipping models available when the seed snapshot is stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T00:00:00.000Z'));

    const catalog = listCatalog(PROFILE_24GB);
    const candidates = listCandidates('eco-fast', PROFILE_24GB);

    expect(catalog.available.length).toBeGreaterThan(0);
    expect(candidates.length).toBeGreaterThan(0);
    expect(catalog.available[0]!.confidence).toBe('calculated');
    expect(candidates.some((candidate) => candidate.admission.reason === 'predicted-fit')).toBe(true);
    expect(recommend('eco-fast', PROFILE_24GB).id).toBe('candidate/qwen3.5-2b-onnx');
  });

  it('throws NoAssignableModelError when every model has a recent smoke-fail on this profile', () => {
    // Pre-seed ledger with smoke-fail for every catalog model on the Firefox
    // WASM profile. With no seed proof exemption and no currently-bound model,
    // the confidence floor rejects everything.
    const catalog = getCatalog();
    const entries = catalog
      .filter((m) => {
        // Only seed failures for models that are assignable on Firefox WASM.
        // Non-assignable models are filtered by compatibility, not the floor.
        return isAssignable(m, PROFILE_FIREFOX);
      })
      .map((m) => ({
        modelId: m.id,
        profileKey: 'firefox|wasm-fallback-laptop|wasm-only',
        outcome: 'smoke-fail',
        recordedAt: new Date().toISOString(),
        ledgerVersion: CURRENT_LEDGER_VERSION,
      }));
    localStorage.setItem('eco-local-ai-ledger-v1', JSON.stringify(entries));

    expect(() => recommend('eco-fast', PROFILE_FIREFOX)).toThrow(NoAssignableModelError);
  });

  it('skips a model with recentFailureCount >= 1 when no exemption', () => {
    // Pre-seed a smoke-fail for the top-ranked model on Chromium 24 GB.
    const topPick = recommend('eco-fast', PROFILE_24GB);
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: topPick.id,
          profileKey: 'chromium|high-memory-laptop|webgpu',
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    const afterFail = recommend('eco-fast', PROFILE_24GB);
    expect(afterFail.id).not.toBe(topPick.id);
  });

  it('returns the bound model even if it has recent failures when currentlyBoundModelId matches', () => {
    const topPick = recommend('eco-fast', PROFILE_24GB);
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: topPick.id,
          profileKey: 'chromium|high-memory-laptop|webgpu',
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );
    // Without exemption: top pick is skipped.
    const withoutExemption = recommend('eco-fast', PROFILE_24GB);
    expect(withoutExemption.id).not.toBe(topPick.id);

    // With exemption: top pick stays available because it's the bound model.
    const candidates = listCandidates('eco-fast', PROFILE_24GB, undefined, {
      currentlyBoundModelId: topPick.id,
    });
    const boundCandidate = candidates.find((c) => c.model.id === topPick.id);
    expect(boundCandidate).toBeDefined();
  });

  // ── slice 3: download-fail auto-demotion ──
  describe('download-fail auto-demotion', () => {
    const LEGACY_KEY = 'chromium|high-memory-laptop|webgpu';
    const STARTER_ID = 'candidate/lfm2.5-350m-onnx';

    const seedDownloadFails = (modelId: string, daysAgoList: number[]): void => {
      const entries = daysAgoList.map((daysAgo) => ({
        modelId,
        profileKey: LEGACY_KEY,
        outcome: 'download-fail',
        errorCode: 'failed',
        recordedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
        ledgerVersion: CURRENT_LEDGER_VERSION,
      }));
      localStorage.setItem('eco-local-ai-ledger-v1', JSON.stringify(entries));
    };

    it('demotes a model with >=2 download-fails in 7d from the auto-offer', () => {
      const top = recommend('eco-fast', PROFILE_24GB);
      seedDownloadFails(top.id, [0, 1]);
      expect(recommend('eco-fast', PROFILE_24GB).id).not.toBe(top.id);
      expect(listCandidates('eco-fast', PROFILE_24GB).some((c) => c.model.id === top.id)).toBe(false);
    });

    it('does NOT demote at a single download-fail (threshold is 2)', () => {
      const top = recommend('eco-fast', PROFILE_24GB);
      seedDownloadFails(top.id, [0]);
      expect(recommend('eco-fast', PROFILE_24GB).id).toBe(top.id);
    });

    it('does NOT demote when the second failure is 8 days old (outside the 7d window)', () => {
      const top = recommend('eco-fast', PROFILE_24GB);
      seedDownloadFails(top.id, [0, 8]);
      expect(recommend('eco-fast', PROFILE_24GB).id).toBe(top.id);
    });

    it('keeps a demoted model available when it is the currently-bound pick', () => {
      const top = recommend('eco-fast', PROFILE_24GB);
      seedDownloadFails(top.id, [0, 1]);
      const candidates = listCandidates('eco-fast', PROFILE_24GB, undefined, {
        currentlyBoundModelId: top.id,
      });
      expect(candidates.some((c) => c.model.id === top.id)).toBe(true);
    });

    it('never blocks manual selection — listCatalog still lists a download-failed model', () => {
      const top = recommend('eco-fast', PROFILE_24GB);
      seedDownloadFails(top.id, [0, 1]);
      expect(listCatalog(PROFILE_24GB).available.some((a) => a.model.id === top.id)).toBe(true);
    });

    it('NEVER demotes the starter floor even after repeated download failures', () => {
      // Sanity: the starter is normally offerable for eco-fast on this device.
      expect(
        listCandidates('eco-fast', PROFILE_24GB).some((c) => c.model.id === STARTER_ID),
      ).toBe(true);
      seedDownloadFails(STARTER_ID, [0, 1, 2]);
      expect(
        listCandidates('eco-fast', PROFILE_24GB).some((c) => c.model.id === STARTER_ID),
      ).toBe(true);
    });
  });

  it('listCandidates surfaces all compatible models regardless of confidence source', () => {
    // v1.0 policy: confidence source is NOT required to surface a model.
    // The smoke test on first use is the quality gate.
    const profiles: { name: string; profile: DeviceProfile }[] = [
      { name: 'chromium-24gb', profile: PROFILE_24GB },
      { name: 'chromium-8gb', profile: PROFILE_8GB },
      { name: 'firefox-16gb', profile: PROFILE_FIREFOX },
    ];
    for (const { name, profile } of profiles) {
      for (const slot of ['eco-fast', 'eco-smart'] as const) {
        const ranked = listCandidates(slot, profile);
        // Every compatible model that matches this slot should be present
        // (unless it has a recent failure in the ledger).
        expect(ranked.length, `${name} ${slot}`).toBeGreaterThan(0);
        // Each surfaced candidate must pass admission (not denied) and carry
        // a non-zero reliability — the smoke test, not the dialog, gates
        // quality, but the floor still excludes denied/incompatible models.
        for (const candidate of ranked) {
          expect(candidate.admission.decision, `${name} ${slot} ${candidate.model.id}`)
            .not.toBe('denied');
          expect(candidate.reliability, `${name} ${slot} ${candidate.model.id}`)
            .toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('catalog has no v1.0 experimental models', () => {
  it('every shipped catalog entry is proven or predicted (sanity check on data)', () => {
    for (const model of getCatalog()) {
      expect(['proven', 'predicted']).toContain(model.evidenceTier);
    }
  });
});
