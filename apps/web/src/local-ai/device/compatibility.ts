// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Compatibility — clean (device × model) → supported lookup.
 *
 * Encodes the v1.0 catalog's hardware floor as data, so the
 * recommendation engine can guarantee invariant 2 ("every recommendation
 * is assignable"). The rules below match the catalog spec at
 * `docs/design/2026-05-16/vision-and-architecture.md` §2.4 and the seed
 * evidence at `apps/web/src/local-ai/evidence/data/v1-launch-manual-evidence.json`.
 *
 * Downstream consumers:
 *   - `selection/recommend.ts` refuses to return any model where
 *     `isAssignable(model, profile)` is false.
 *   - The Switch dialog uses `isCompatible(...) === 'with-warning'` to
 *     tag models that run but with a caveat.
 *
 * Adding a catalog model means adding a rule here. A grep test in
 * `__tests__/compatibility.test.ts` asserts every catalog id has a rule.
 */

import type { DeviceProfile, ModelConfig } from '../types';

export type CompatibilityResult = 'supported' | 'unsupported' | 'with-warning';

type CompatibilityRule = {
  /** Requires WebGPU (cannot run in WASM-only). */
  requireWebgpu: boolean;
  /** Minimum reported device memory in GB. 0 means "no floor". */
  minDeviceMemoryGB: number;
  /** Browser engines that have been measured or are confidently predicted. */
  allowedBrowsers: readonly DeviceProfile['browserClass'][];
  /** If true, returns `'with-warning'` on a mobile form factor. */
  warnIfMobile: boolean;
  /**
   * The model's build emits an op that onnxruntime-web's WebGPU EP supports but
   * its CPU/WASM EP does NOT — so it can never load on a `wasm-only` device
   * (where every model runs through the CPU EP). The proven case is
   * GatherBlockQuantized (block-quantized embeddings): the LFM2.5-350M ONNX
   * build hard-fails "Kernel not found for GatherBlockQuantized ep:CPU" in ~1.2s
   * on the CPU EP, yet runs fine on the WebGPU EP (see
   * `pitfall_gemma4_gatherblockquantized_webgpu`, addendum 2026-07-02). Optional:
   * absent means "runs on the CPU EP." Only bites when `webgpuSupport ===
   * 'wasm-only'`; WebGPU devices are unaffected. Keeps Finding E data-driven — the
   * setup cascade never attempts a model that can't load on this device's EP.
   */
  cpuEpIncompatible?: boolean;
};

const RULES: Readonly<Record<string, CompatibilityRule>> = Object.freeze({
  'local/phi3-mini-4k-q4f16': {
    requireWebgpu: true,
    minDeviceMemoryGB: 16,
    allowedBrowsers: ['chromium'] as const,
    warnIfMobile: true,
  },
  'candidate/lfm2.5-1.2b-instruct-onnx': {
    requireWebgpu: true,
    minDeviceMemoryGB: 8,
    allowedBrowsers: ['chromium'] as const,
    warnIfMobile: true,
  },
  // 'unknown' is included: a user-agent we cannot classify gets the same
  // unvalidated-browser tier as safari/firefox rather than a categorical
  // rejection. The capability probes (WebGPU/WASM, memory floor, CPU-EP) plus
  // the first-use smoke gate are the real gate — the UA class was the only thing
  // wholesale-declining these users. Premium models stay engine-validated
  // (chromium-only), so this only opens the conservative floor tier.
  'local/qwen3-0.6b': {
    requireWebgpu: false,
    minDeviceMemoryGB: 4,
    allowedBrowsers: ['chromium', 'safari', 'firefox', 'mobile', 'unknown'] as const,
    warnIfMobile: false,
  },
  // LFM2.5-350M (onnx-q4). Runs on the WebGPU EP (incl. f16-less adapters — it's
  // the light onnx-q4 rung there), but its block-quantized embeddings emit
  // GatherBlockQuantized, which ort-web's CPU/WASM EP does NOT implement — so it
  // hard-fails "Kernel not found" on any wasm-only device. cpuEpIncompatible
  // keeps it out of the WASM setup cascade (Finding E), leaving qwen3-0.6b as the
  // sole WASM floor. requireWebgpu stays false so it remains offerable on the
  // f16-less-but-WebGPU tier where it genuinely loads.
  // 'unknown' included for the same policy as qwen3-0.6b: an unclassifiable UA
  // gets the floor tier, not a wholesale decline. Capability probes + the smoke
  // gate remain the real protection (and cpuEpIncompatible still keeps this out
  // of the wasm-only cascade, unknown UA or not).
  'candidate/lfm2.5-350m-onnx': {
    requireWebgpu: false,
    minDeviceMemoryGB: 3,
    allowedBrowsers: ['chromium', 'safari', 'firefox', 'mobile', 'unknown'] as const,
    warnIfMobile: false,
    cpuEpIncompatible: true,
  },
  // Smart pick (chat #7 graduation). 1.40GB q4f16 weights + near-constant
  // DeltaNet recurrent state sits between Bonsai (1.15GB, 8GB floor) and
  // Phi-3 (2.14GB, 16GB floor); measured only on high-memory hardware, but the
  // Bonsai precedent + the first-use smoke gate make 8GB the honest floor.
  'candidate/qwen3.5-2b-onnx': {
    requireWebgpu: true,
    minDeviceMemoryGB: 8,
    allowedBrowsers: ['chromium'] as const,
    warnIfMobile: true,
  },
  // Gemma 4 E2B via LiteRT (the f16-less C2/C3 answer — model-offering overhaul
  // 2026-06-29). LiteRT is WebGPU-only and Chromium-only by construction
  // (runtime/litert-adapter.ts), so requireWebgpu + chromium. Crucially its
  // `litertlm` format does NOT need shader-f16 (formatRequiresShaderF16 → false),
  // so the f16 gate above keeps it ASSIGNABLE on f16-less adapters where every
  // q4f16 model is filtered out — exactly the desktop-Intel / Adreno-Android hole
  // it fills. 8GB floor matches Bonsai/Qwen (mmap keeps resident weights ~0.8GB
  // of the ~1.9GB download). warnIfMobile: real Android per-tab memory is
  // unvalidated (Track C C3 is provisional) — offered with a caveat, smoke-gated.
  'candidate/gemma-4-e2b-litert': {
    requireWebgpu: true,
    minDeviceMemoryGB: 8,
    allowedBrowsers: ['chromium'] as const,
    warnIfMobile: true,
  },
});

/**
 * WebKit on a mobile form factor — iOS Safari, and in fact EVERY iOS browser
 * (Chrome/CriOS, Firefox/FxiOS) since they all render through WebKit and
 * classify `'safari'` + `isMobile` in `device/profile.ts`. So this predicate is
 * "iOS WebKit" exactly.
 *
 * Why it gates before any load: the real-device spike (iPhone 13, iOS Safari)
 * showed every model LOAD crashes the tab in a restart loop — onnxruntime-web
 * fully materializes the model weights into the WASM heap (~5× working set),
 * which blows past iOS's ~2GB per-tab memory ceiling before a single token is
 * generated. The structural fix (Phase A/B working-set reduction) is pursued
 * separately; until a phone-validated config exists, iOS must be declined
 * BEFORE any download/load attempt and welcomed with the designed handoff
 * surface, never a crash loop.
 *
 * Scope: this is WebKit-mobile only. Android Chrome classifies `'chromium'` +
 * `isMobile` and is unaffected (it keeps serving with-warning); the UA-stripped
 * `'mobile'` class is likewise untouched.
 */
export function isWebKitMobile(profile: DeviceProfile): boolean {
  return profile.isMobile && profile.browserClass === 'safari';
}

/**
 * Model ids proven to LOAD and run within the WebKit-mobile memory envelope.
 * Empty today: the iPhone-13 spike proved every current catalog build
 * crash-loops on load there. This is the retest trigger — when the Phase A/B
 * working-set fix lands, add a model id here ONLY after a real-device iOS
 * retest confirms it loads without the tab-restart loop. Until an id is listed,
 * WebKit-mobile declines to the designed handoff surface.
 */
export const WEBKIT_MOBILE_VALIDATED_MODEL_IDS: readonly string[] = [];

export function isCompatible(model: ModelConfig, profile: DeviceProfile): CompatibilityResult {
  const rule = RULES[model.id];
  if (!rule) return 'unsupported';

  // WebKit-mobile (iOS) gate — BEFORE any capability probe so no model is ever
  // load-attempted on a device where the load itself crash-loops the tab (see
  // isWebKitMobile). A model graduates out of this decline only by being added
  // to WEBKIT_MOBILE_VALIDATED_MODEL_IDS after a phone-validated retest.
  if (isWebKitMobile(profile) && !WEBKIT_MOBILE_VALIDATED_MODEL_IDS.includes(model.id)) {
    return 'unsupported';
  }

  if (rule.requireWebgpu && profile.webgpuSupport !== 'webgpu') {
    return 'unsupported';
  }

  // Below-floor short-circuit: webgpuSupport === 'none' fails EVERY catalog
  // model, including Qwen3/LFM2.5 that don't require WebGPU. The intentional
  // design is: profiles with no WebGPU AND no viable WASM (the 'none'
  // verdict from device/profile.ts) cannot run any v1.0 model. The honest
  // experience for those users lives in device/below-floor.ts +
  // BelowFloorScreen — they get a "coming soon" surface, not a hidden
  // recommendation. Removing this guard would surface unrunnable models in
  // the catalog UI.
  if (profile.webgpuSupport === 'none') {
    return 'unsupported';
  }

  // CPU/WASM execution-provider viability. On a `wasm-only` device every model
  // runs through ort-web's CPU EP, which lacks some ops the WebGPU EP has — most
  // notably GatherBlockQuantized (LFM2.5-350M's block-quantized embeddings),
  // which hard-fails "Kernel not found" there. A cpuEpIncompatible model can
  // NEVER load on such a device, so filter it out before scoring — the setup
  // cascade then never burns a multi-minute doomed download on it (Finding E,
  // Every-Device program Phase 0). This does NOT bite on WebGPU devices
  // (webgpuSupport === 'webgpu'), where these same builds run on the WebGPU EP.
  if (profile.webgpuSupport === 'wasm-only' && rule.cpuEpIncompatible) {
    return 'unsupported';
  }

  // f16 catalog builds run on the WebGPU EP only when the adapter exposes the
  // shader-f16 feature. An adapter that lacks it loads the model then dies on
  // the first f16 op (observed: Chrome 149 on a Windows iGPU — 18 features,
  // no shader-f16). Flag those models unsupported so the cascade surfaces a
  // non-f16 model (Gemma 4 default, then Bonsai) or declines honestly, instead of burning a
  // multi-minute download on a model that can't run. The gate is explicit
  // `=== false`: an unprobed profile (`undefined`) keeps prior behavior, and a
  // WASM-EP device (`webgpuSupport !== 'webgpu'`) runs f16 fine on CPU.
  if (
    profile.webgpuSupport === 'webgpu'
    && profile.webgpuShaderF16 === false
    && formatRequiresShaderF16(model.format)
  ) {
    return 'unsupported';
  }

  if (profile.deviceMemoryGB > 0 && profile.deviceMemoryGB < rule.minDeviceMemoryGB) {
    return 'unsupported';
  }

  if (!rule.allowedBrowsers.includes(profile.browserClass)) {
    return 'unsupported';
  }

  if (rule.warnIfMobile && profile.isMobile) {
    return 'with-warning';
  }

  return 'supported';
}

export function isAssignable(model: ModelConfig, profile: DeviceProfile): boolean {
  return isCompatible(model, profile) !== 'unsupported';
}

/**
 * Whether a catalog `format` needs the WebGPU `shader-f16` feature to execute
 * on the WebGPU execution provider. The q4f16 / q2f16 ONNX builds emit f16
 * shader ops; plain int4 (`onnx-q4`) does not, and `litertlm` runs through a
 * separate runtime that never touches the ORT WebGPU EP. Exhaustive over the
 * union so a new format must be classified.
 */
export function formatRequiresShaderF16(format: ModelConfig['format']): boolean {
  switch (format) {
    case 'onnx-q4f16':
    case 'onnx-q2f16':
      return true;
    case 'onnx-q4':
    case 'litertlm':
      return false;
  }
}

export function hasCompatibilityRule(modelId: string): boolean {
  return Object.prototype.hasOwnProperty.call(RULES, modelId);
}
