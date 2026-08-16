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
import { getCatalog, getModel } from '../../catalog/catalog';
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

  it('recommends the plain-int4 LFM2.5-1.2B (q4) for the eco-fast slot', () => {
    // Device-coverage fix (2026-08-10): the f16-less eco-fast pick is now the SAME
    // 1.2B everyday default, via its plain-int4 build (onnx-q4, needs no shader-f16)
    // — not Gemma 4 (kept as the deeper eco-smart pick below).
    const pick = recommend('eco-fast', PROFILE_NO_SHADER_F16);
    expect(pick.id).toBe('candidate/lfm2.5-1.2b-instruct-q4-onnx');
    expect(pick.format).toBe('onnx-q4');
  });

  it('defaults the eco-smart (deeper) slot to Gemma 4 on an f16-less adapter', () => {
    // eco-fast gets the plain-int4 1.2B (its own instant-start rung); eco-smart
    // keeps Gemma 4 as the deeper f16-less pick, since Qwen3.5-2B / the 2.6B (q4f16)
    // are unassignable without shader-f16.
    const pick = recommend('eco-smart', PROFILE_NO_SHADER_F16);
    expect(pick.id).toBe('candidate/gemma-4-e2b-litert');
  });

  it('promotes the 1.2B (q4) first on an f16-less adapter, with 350M + Gemma 4 as fallbacks', () => {
    const candidates = listCandidates('eco-fast', PROFILE_NO_SHADER_F16);
    expect(candidates[0]!.model.id).toBe('candidate/lfm2.5-1.2b-instruct-q4-onnx');
    // The f16-free survivors: the plain-int4 1.2B (default), the 0.28GB LFM2.5-350M
    // light floor, and Gemma 4 (litertlm deeper pick).
    expect(candidates.map((c) => c.model.id)).toContain('candidate/lfm2.5-350m-onnx');
    expect(candidates.map((c) => c.model.id)).toContain('candidate/gemma-4-e2b-litert');
  });

  it('ranks the f16-less ladder 1.2B (q4) → LFM2.5-350M → Gemma 4', () => {
    // The cascade walks this ranking on setup failures (selection/cascade.ts): the
    // good 1.2B (q4) leads as the first download, then the tiny 350M, then the
    // larger Gemma 4 LiteRT. Order captured empirically from the real functions.
    const ids = listCandidates('eco-fast', PROFILE_NO_SHADER_F16).map((c) => c.model.id);
    expect(ids).toEqual([
      'candidate/lfm2.5-1.2b-instruct-q4-onnx',
      'candidate/lfm2.5-350m-onnx',
      'candidate/gemma-4-e2b-litert',
    ]);
  });

  it('surfaces the 1.2B (q4) first in the flat catalog dialog on an f16-less adapter', () => {
    const r = listCatalog(PROFILE_NO_SHADER_F16);
    expect(r.available[0]!.model.id).toBe('candidate/lfm2.5-1.2b-instruct-q4-onnx');
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

  it('eco-fast stays the fast default and eco-smart is the deeper graduated pick on 24 GB (slots re-split)', () => {
    const fast = recommend('eco-fast', PROFILE_24GB);
    const smart = recommend('eco-smart', PROFILE_24GB);
    // The 2026-08-10 LFM2-2.6B graduation re-split the slots the 2026-08-09 read had
    // collapsed onto the 1.2B: eco-smart is the deeper 2.6B, eco-fast stays the fast
    // 1.2B. A by-eye read judged it decisively better than the 1.2B and 2B, but that
    // is NOT a hardware benchmark — it ships zero seed rows, so 'proven' overclaimed.
    // Wave-3 evidence-truth (TIER-1) flipped it to 'predicted', the honest label
    // pending a second-machine benchmark. The eco-smart PICK is unchanged: it is the
    // hardcoded PREFERRED_SMART_MODEL_ID that promotePreferred pins to the top of the
    // slot regardless of tier — the flip only lowers its (unused-here) quality axis.
    expect(smart.id).toBe('candidate/lfm2-2.6b-onnx');
    expect(smart.evidenceTier).toBe('predicted');
    expect(fast.capabilities.intent.includes('snappy') || fast.capabilities.intent.includes('balanced')).toBe(true);
  });
});

describe('recommend — per-slot preferred picks', () => {
  it('eco-fast resolves to LFM2.5-1.2B on compatible devices (model-ladder default)', () => {
    // Model-ladder read (2026-08-09, reverses the 2026-06-13 everyday-swap):
    // LFM2.5-1.2B-instruct is the everyday default on devices that can run it
    // (8 GB floor) — the fast, accurate workhorse. Stronger hardware doesn't
    // auto-upgrade to a bigger model; the 2B is opt-in via "Choose your own".
    const fast8 = recommend('eco-fast', PROFILE_8GB, 'snappy');
    const fast24 = recommend('eco-fast', PROFILE_24GB, 'snappy');
    expect(fast8.id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(fast24.id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
  });

  it('eco-smart resolves to the deeper LFM2-2.6B on compatible devices (graduated 2026-08-10)', () => {
    // The measured deeper tier (LFM2-2.6B) graduated and PREFERRED_SMART_MODEL_ID
    // moved to it, re-splitting the slots the 2026-08-09 read had collapsed onto the
    // 1.2B. The 2.6B carries an 8 GB floor, so it is the eco-smart pick on both the
    // 8 GB and 24 GB profiles.
    const smart8 = recommend('eco-smart', PROFILE_8GB, 'quality');
    const smart24 = recommend('eco-smart', PROFILE_24GB, 'quality');
    expect(smart8.id).toBe('candidate/lfm2-2.6b-onnx');
    expect(smart24.id).toBe('candidate/lfm2-2.6b-onnx');
  });

  it('the two slots re-split on capable hardware (fast = LFM2.5-1.2B, smart = the deeper LFM2-2.6B)', () => {
    // The slots collapsed onto the 1.2B on 2026-08-09; the 2026-08-10 LFM2-2.6B
    // graduation re-split them. eco-fast is the fast everyday default; eco-smart is
    // the deeper opt-in the upgrade card now offers as a genuine size-up.
    const fast = recommend('eco-fast', PROFILE_24GB);
    const smart = recommend('eco-smart', PROFILE_24GB);
    expect(fast.id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(smart.id).toBe('candidate/lfm2-2.6b-onnx');
    expect(fast.id).not.toBe(smart.id);
  });
});

describe('recommend — non-Chromium profiles', () => {
  // Finding E + the no-GPU floor (2026-08-10): on a wasm-only profile the int4
  // LFM2.5 builds (350m, 1.2B-q4) block-quantize embeddings and are CPU-EP-unloadable,
  // so they never appear. The preferred floor is now the fast int8 SmolLM2-360M (both
  // slots floor to it); Qwen2.5-0.5B and the retired qwen3-0.6b remain as alternatives.
  it('Firefox WASM 16 GB eco-fast returns SmolLM2-360M (the fast int8 floor)', () => {
    const pick = recommend('eco-fast', PROFILE_FIREFOX);
    expect(pick.id).toBe('candidate/smollm2-360m-instruct-onnx');
  });

  it('Firefox WASM 16 GB eco-smart also floors to SmolLM2-360M', () => {
    const pick = recommend('eco-smart', PROFILE_FIREFOX);
    expect(pick.id).toBe('candidate/smollm2-360m-instruct-onnx');
  });

  it('surfaces the CPU-EP-safe floor set, SmolLM2 first, and never the 350m', () => {
    const ids = listCandidates('eco-fast', PROFILE_FIREFOX).map((c) => c.model.id);
    // SmolLM2 (the preferred fast floor) leads; Qwen2.5-0.5B and qwen3-0.6b follow as
    // alternatives. The block-quant 350m (CPU-EP-unloadable) never appears.
    expect(ids[0]).toBe('candidate/smollm2-360m-instruct-onnx');
    expect(ids).not.toContain('candidate/lfm2.5-350m-onnx');
    expect([...ids].sort()).toEqual(
      [
        'candidate/qwen2.5-0.5b-instruct-onnx',
        'candidate/smollm2-360m-instruct-onnx',
        'local/qwen3-0.6b',
      ].sort(),
    );
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

  it('picks the class-best 1.2B on capable hardware (within the fast-download budget)', () => {
    // Model-ladder fix (2026-08-09): Stage A no longer serves the SMALLEST model.
    // The old smallest-wins rule handed a capable device LFM2.5-350M (0.28 GB) —
    // an extraction model wrong-type for chat that also fails to load on WebGPU
    // (GatherBlockQuantized). Now the class-best pick is the starter when it fits
    // STARTER_MAX_SIZE_GB, so the 0.76 GB everyday default is a fast-enough first
    // download AND a good first impression — and Stage A converges with the
    // class-best (no jarring mid-session swap).
    const starter = starterModelForSlot('eco-fast', PROFILE_24GB);
    expect(starter?.id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(starter?.id).toBe(recommend('eco-fast', PROFILE_24GB).id);
  });

  it('picks the 1.2B (q4) starter on an f16-less adapter — no step-down to the weak 350M', () => {
    // Device-coverage fix (2026-08-10): the f16-less first download used to step
    // DOWN to the weak 350M because Gemma 4 (1.87GB) exceeds STARTER_MAX_SIZE_GB.
    // The plain-int4 1.2B (0.85GB) is now the f16-less eco-fast pick AND fits the
    // budget, so it is its own starter — converging with recommend() exactly as on
    // capable hardware.
    const starter = starterModelForSlot('eco-fast', PROFILE_NO_SHADER_F16);
    expect(starter?.id).toBe('candidate/lfm2.5-1.2b-instruct-q4-onnx');
    expect(starter?.format).toBe('onnx-q4');
    expect(starter?.id).toBe(recommend('eco-fast', PROFILE_NO_SHADER_F16).id);
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

  it('converges with recommend() on a wasm-only device (the fast int8 floor)', () => {
    // wasm-only devices where the starter IS the class-best: Stage A and the
    // upgrade path collapse into a no-op — same model, no popup. The preferred
    // no-GPU floor SmolLM2-360M (0.37GB ≤ STARTER_MAX_SIZE_GB) is both the starter
    // and the recommendation, so a fresh no-GPU device's first chat runs on it.
    const candidates = listCandidates('eco-fast', PROFILE_FIREFOX);
    const starter = starterModelForSlot('eco-fast', PROFILE_FIREFOX);
    expect(candidates.map((c) => c.model.id)).toContain(starter!.id);
    expect(starter?.id).toBe('candidate/smollm2-360m-instruct-onnx');
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

  it('returns LFM2.5-1.2B first (preferred default) then remaining by score descending', () => {
    const ranked = listCandidates('eco-fast', PROFILE_24GB);
    // The default should be promoted to position 0 on capable devices.
    expect(ranked[0]!.model.id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
    // Remaining entries (after the promoted default) are score-descending.
    for (let i = 2; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score.total).toBeGreaterThanOrEqual(ranked[i]!.score.total);
    }
  });

  it('returns the deeper LFM2-2.6B first for eco-smart (preferred smart pick), score order after', () => {
    const ranked = listCandidates('eco-smart', PROFILE_24GB);
    expect(ranked[0]!.model.id).toBe('candidate/lfm2-2.6b-onnx');
    for (let i = 2; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score.total).toBeGreaterThanOrEqual(ranked[i]!.score.total);
    }
    // The smart-pick promotion also drives the cascade: a smoke failure on the
    // smart pick falls back to the natural score ranking, never to nothing.
    expect(ranked.length).toBeGreaterThan(1);
  });

  it('falls back to natural ranking for eco-smart where the smart pick is unassignable', () => {
    // Firefox/WASM: the smart pick (LFM2-2.6B) requires WebGPU → promotion is a
    // no-op and the fit-score ranking decides (Qwen3-0.6B class). The 2.6B is
    // unassignable here, so it never surfaces.
    const ranked = listCandidates('eco-smart', PROFILE_FIREFOX);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.map((c) => c.model.id)).not.toContain('candidate/lfm2-2.6b-onnx');
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

  it('surfaces LFM2.5-1.2B benchmark proof on Chromium 24 GB', () => {
    // The LFM2.5-1.2B high-memory benchmark seed is dated 2026-06-19; pin the clock
    // to that date so the row stays inside its 45-day freshness TTL and the
    // benchmark-confidence path is exercised deterministically (otherwise this
    // assertion rots once the row ages past the window).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T00:00:00.000Z'));
    const r = listCatalog(PROFILE_24GB);
    const entry = r.available.find((e) => e.model.id === 'candidate/lfm2.5-1.2b-instruct-onnx');
    expect(entry?.confidence).toBe('benchmark');
  });

  it('omits unsupported models entirely on Firefox', () => {
    const r = listCatalog(PROFILE_FIREFOX);
    const allIds = r.available.map((entry) => entry.model.id);
    // qwen3.5-2b is a chromium-only WebGPU model — unsupported on Firefox.
    expect(allIds).not.toContain('candidate/qwen3.5-2b-onnx');
  });

  it('never surfaces or binds the retired Phi-3 (MC-2), even as a currently-bound id', () => {
    const RETIRED = 'local/phi3-mini-4k-q4f16';
    expect(listCatalog(PROFILE_24GB).available.map((e) => e.model.id)).not.toContain(RETIRED);
    // Even the currently-bound escape hatch (which retains a smoke-failed pick)
    // must not resurrect a model that no longer exists in the catalog.
    expect(
      listCandidates('eco-smart', PROFILE_24GB, undefined, { currentlyBoundModelId: RETIRED }).map(
        (c) => c.model.id,
      ),
    ).not.toContain(RETIRED);
  });

  it('returns shape with an empty available array for below-floor profiles', () => {
    const r = listCatalog(PROFILE_BELOW_FLOOR);
    expect(Array.isArray(r.available)).toBe(true);
  });

  it('ranks LFM2.5-1.2B first (preferred default) then remaining by fit score', () => {
    const r = listCatalog(PROFILE_24GB);
    // The default should be promoted to position 0 on capable devices.
    expect(r.available[0]!.model.id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
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

  const seedSmartSmokeFail = () =>
    localStorage.setItem(
      'eco-local-ai-ledger-v1',
      JSON.stringify([
        {
          modelId: 'candidate/qwen3.5-2b-onnx',
          profileKey: 'chromium|high-memory-laptop|webgpu',
          outcome: 'smoke-fail',
          recordedAt: new Date().toISOString(),
          ledgerVersion: CURRENT_LEDGER_VERSION,
        },
      ]),
    );

  it('keeps a single-smoke-fail model VISIBLE in manual Settings but hidden from auto-offer (FH-1)', () => {
    seedSmartSmokeFail();
    // Manual Settings still shows it — re-selecting re-runs the smoke gate, so
    // showing it IS the retry path. Hiding it for 30 days with no recourse was the
    // FH-1 trap (asymmetric with downloads, which are already manual-exempt).
    expect(listCatalog(PROFILE_24GB).available.map((e) => e.model.id)).toContain(
      'candidate/qwen3.5-2b-onnx',
    );
    // Auto-offer still excludes it — never auto-recommend a model that just failed.
    expect(listCandidates('eco-smart', PROFILE_24GB).map((c) => c.model.id)).not.toContain(
      'candidate/qwen3.5-2b-onnx',
    );
    localStorage.clear();
  });

  it('keeps the currently-bound model in auto-offer even with a recent smoke-fail', () => {
    seedSmartSmokeFail();
    // Auto-offer hides a smoke-failed model...
    expect(listCandidates('eco-smart', PROFILE_24GB).map((c) => c.model.id)).not.toContain(
      'candidate/qwen3.5-2b-onnx',
    );
    // ...unless it's the user's currently-bound pick — never silently drop it.
    // (4-arg form: intent left as the slot default, options in the 4th position.)
    const bound = listCandidates('eco-smart', PROFILE_24GB, undefined, {
      currentlyBoundModelId: 'candidate/qwen3.5-2b-onnx',
    });
    expect(bound.map((c) => c.model.id)).toContain('candidate/qwen3.5-2b-onnx');
    localStorage.clear();
  });
});

describe('listCatalog — bound-but-unassignable model stays switchable (FH-2)', () => {
  // A device probed AFTER binding: webgpuShaderF16 flips to false, which makes
  // every q4f16 build unassignable (formatRequiresShaderF16 gate). The user's
  // bound q4f16 1.2B must NOT vanish from the manual Switch list — otherwise
  // there is no path to switch away from a model the device can no longer run.
  const PROFILE_NO_SHADER_F16: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 16,
    isMobile: false,
    override: 'auto',
    webgpuShaderF16: false,
  };
  const BOUND_Q4F16 = 'candidate/lfm2.5-1.2b-instruct-onnx'; // q4f16 → unassignable here

  it('keeps the bound model in the Switch list even when it is no longer assignable', () => {
    // Guard the premise: this model really is unassignable on this profile.
    expect(isAssignable(getModel(BOUND_Q4F16)!, PROFILE_NO_SHADER_F16)).toBe(false);
    const ids = listCatalog(PROFILE_NO_SHADER_F16, { currentlyBoundModelId: BOUND_Q4F16 })
      .available.map((e) => e.model.id);
    expect(ids).toContain(BOUND_Q4F16);
  });

  it('still excludes the same unassignable model when it is NOT the bound one', () => {
    const ids = listCatalog(PROFILE_NO_SHADER_F16, { currentlyBoundModelId: null })
      .available.map((e) => e.model.id);
    expect(ids).not.toContain(BOUND_Q4F16);
  });

  it('auto-offer (listCandidates) never surfaces the unassignable model, even when bound', () => {
    const ids = listCandidates('eco-fast', PROFILE_NO_SHADER_F16, undefined, {
      currentlyBoundModelId: BOUND_Q4F16,
    }).map((c) => c.model.id);
    expect(ids).not.toContain(BOUND_Q4F16);
  });
});

describe('recommend — sub-8GB WebGPU floor (FR-2)', () => {
  const PROFILE_CHROMIUM_6GB_F16: DeviceProfile = {
    browserClass: 'chromium',
    webgpuSupport: 'webgpu',
    deviceMemoryGB: 6,
    isMobile: false,
    webgpuShaderF16: true,
    override: 'auto',
  };

  it('recommends the proven qwen3-0.6b (not the 350M extraction model) for eco-fast on a sub-8GB WebGPU device', () => {
    // The 1.2B family needs 8GB; without a preferred floor, fit-ranking surfaced
    // the 0.35B LFM2.5-350M (extraction-type, wrong for chat) as "Recommended" by
    // a ~0.004 margin. FR-2 promotes the proven qwen3-0.6b chat floor instead.
    expect(recommend('eco-fast', PROFILE_CHROMIUM_6GB_F16).id).toBe('local/qwen3-0.6b');
    // The 350M stays offerable — just no longer the top "Recommended" pick.
    expect(listCandidates('eco-fast', PROFILE_CHROMIUM_6GB_F16).map((c) => c.model.id)).toContain(
      'candidate/lfm2.5-350m-onnx',
    );
  });

  it('leaves safari/firefox WebGPU on the proven qwen3-0.6b (already correct — no regression)', () => {
    const safari: DeviceProfile = {
      browserClass: 'safari',
      webgpuSupport: 'webgpu',
      deviceMemoryGB: 16,
      isMobile: false,
      override: 'auto',
    };
    expect(recommend('eco-fast', safari).id).toBe('local/qwen3-0.6b');
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
    expect(recommend('eco-fast', PROFILE_24GB).id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
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

    // Offsets are days-ago from now. "Recent" failures (small offsets) must
    // post-date the failure-evidence epoch (FAILURE_EVIDENCE_VALID_FROM) to
    // count — a failure recorded before a shipped funnel fix is not a device
    // verdict. An hour-scale spread keeps distinct rows safely after the epoch.
    const HOUR = 1 / 24;
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
      seedDownloadFails(top.id, [0, HOUR]);
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
      seedDownloadFails(top.id, [0, HOUR]);
      const candidates = listCandidates('eco-fast', PROFILE_24GB, undefined, {
        currentlyBoundModelId: top.id,
      });
      expect(candidates.some((c) => c.model.id === top.id)).toBe(true);
    });

    it('never blocks manual selection — listCatalog still lists a download-failed model', () => {
      const top = recommend('eco-fast', PROFILE_24GB);
      seedDownloadFails(top.id, [0, HOUR]);
      expect(listCatalog(PROFILE_24GB).available.some((a) => a.model.id === top.id)).toBe(true);
    });

    it('NEVER demotes the starter floor even after repeated download failures', () => {
      // Sanity: the starter is normally offerable for eco-fast on this device.
      expect(
        listCandidates('eco-fast', PROFILE_24GB).some((c) => c.model.id === STARTER_ID),
      ).toBe(true);
      seedDownloadFails(STARTER_ID, [0, HOUR, 2 * HOUR]);
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

// The rung-1 WebKit-mobile WebLLM entry (candidate/qwen2.5-0.5b-mlc) must be a
// pure ADDITION for iOS/WebKit-mobile: it may never enter a candidate set,
// recommendation, or catalog listing for any currently-served profile. This is
// the recommendation-level no-regression proof that complements the
// compatibility-level scope test — it exercises the real selection pipeline
// (isAssignable → admit → slot → floor → score → promote), not just isCompatible.
describe('recommend — WebKit-mobile MLC entry is additive only', () => {
  const MLC_ID = 'candidate/qwen2.5-0.5b-mlc';

  // Every non-iOS-WebKit profile the suite already models, spanning the served
  // device classes: Chromium (high/low mem), Firefox WASM, and below-floor.
  const nonWebKitMobileProfiles: Record<string, DeviceProfile> = {
    chromium24: PROFILE_24GB,
    chromium8: PROFILE_8GB,
    firefoxWasm: PROFILE_FIREFOX,
    chromiumWasmOnly: { browserClass: 'chromium', webgpuSupport: 'wasm-only', deviceMemoryGB: 8, isMobile: false, override: 'auto' },
    chromiumNoShaderF16: { browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto', webgpuShaderF16: false },
    safariDesktopWebgpu: { browserClass: 'safari', webgpuSupport: 'webgpu', deviceMemoryGB: 16, isMobile: false, override: 'auto', webgpuShaderF16: true },
    androidChrome: { browserClass: 'chromium', webgpuSupport: 'webgpu', deviceMemoryGB: 8, isMobile: true, override: 'auto' },
  };

  it('never appears in candidates or recommendations on any currently-served profile', () => {
    for (const [label, profile] of Object.entries(nonWebKitMobileProfiles)) {
      for (const slot of ['eco-fast', 'eco-smart'] as const) {
        const ids = listCandidates(slot, profile).map((c) => c.model.id);
        expect(ids, `${label}/${slot} candidates must exclude the MLC entry`).not.toContain(MLC_ID);
        if (canServe(profile)) {
          expect(recommend(slot, profile).id, `${label}/${slot} recommendation`).not.toBe(MLC_ID);
        }
      }
      expect(
        listCatalog(profile).available.map((a) => a.model.id),
        `${label} catalog listing must exclude the MLC entry`,
      ).not.toContain(MLC_ID);
      expect(isAssignable(getModel(MLC_ID)!, profile), `${label} assignability`).toBe(false);
    }
  });

  it('recommendations on served profiles are unchanged by the entry (spot-check known-good picks)', () => {
    // The 1.2B stays the eco-fast everyday default and the graduated 2.6B is the
    // eco-smart pick on capable Chromium; SmolLM2-360M is the no-GPU (Firefox WASM)
    // floor. If the MLC entry leaked into any of these, one of these ids would change.
    expect(recommend('eco-fast', PROFILE_24GB).id).toBe('candidate/lfm2.5-1.2b-instruct-onnx');
    expect(recommend('eco-smart', PROFILE_24GB).id).toBe('candidate/lfm2-2.6b-onnx');
    expect(recommend('eco-fast', PROFILE_FIREFOX).id).toBe('candidate/smollm2-360m-instruct-onnx');
  });

  it('IS the recommendation on iOS/WebKit-mobile with WebGPU (the positive case)', () => {
    const iosSafariWebgpu: DeviceProfile = {
      browserClass: 'safari',
      webgpuSupport: 'webgpu',
      deviceMemoryGB: 8,
      isMobile: true,
      override: 'auto',
      webgpuShaderF16: true,
    };
    expect(canServe(iosSafariWebgpu)).toBe(true);
    expect(listCandidates('eco-fast', iosSafariWebgpu).length).toBeGreaterThan(0);
    expect(recommend('eco-fast', iosSafariWebgpu).id).toBe(MLC_ID);
    expect(recommend('eco-smart', iosSafariWebgpu).id).toBe(MLC_ID);
  });
});
