// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Compatibility — clean (device × model) → supported lookup.
 *
 * The rules themselves are NOT here: each model's hardware floor is its
 * `compat` block in `catalog/catalog-data.json`, alongside the weights it
 * describes and the provenance for every number (`compat._rationale`). This
 * module is the evaluator — it turns a `DeviceProfile` and a model's declared
 * rules into a verdict, and nothing else.
 *
 * Adding a catalog model is therefore a one-file change: an entry with no
 * `compat` block fails `assertCatalogEntry` at load rather than silently
 * inheriting another model's device rules.
 *
 * Downstream consumers:
 *   - `selection/recommend.ts` refuses to return any model where
 *     `isAssignable(model, profile)` is false.
 *   - `evidence/admission.ts` maps `'with-warning'` to a with-warning
 *     admission (`reliabilityFromDecision` in `selection/recommend.ts` reads
 *     it as 0.6, still exposed on `RecommendationCandidate.reliability`
 *     though nothing ranks on it post-R5c). The Switch dialog shows no
 *     warning tag (every surfaced entry is admitted); the caveat is
 *     informational, not a label.
 */

import type { DeviceProfile, ModelCompat, ModelConfig } from '../types';
import { getCatalog } from '../catalog/catalog';

export type CompatibilityResult = 'supported' | 'unsupported' | 'with-warning';

/**
 * Conservative memory assumed for a device that reports no memory value
 * (`deviceMemoryGB === 0`). Real Chrome always reports one of {0.25,0.5,1,2,4,8}
 * (never 0), so a 0 reading is a Chromium fork that strips the reported-memory
 * API. Skipping the floor for such a device let it be offered a premium
 * ≥8 GB-floor download it cannot be trusted to run. We instead assume 4 GB —
 * chosen to equal the 1.2B family's floor, so an unreported device keeps the same
 * good everyday model a real 4 GB device gets (not locked out) while the ≥8 GB
 * premium tier is declined. A genuinely-tiny fork is still backstopped by the
 * first-use smoke gate and the ≥2-download-fail demotion. No #176 regression: a
 * real 5-7 GB laptop reports a NON-zero 4 (the reading caps at 8 and rounds down),
 * so its value is used as-is and the recovered band is untouched.
 */
const UNREPORTED_MEMORY_ASSUMED_GB = 4;

/**
 * Every catalog model's declared device rules, keyed by id — a view over the
 * catalog, not a second source of truth. Keyed by id (rather than read off the
 * passed `ModelConfig`) so a model absent from the catalog is `'unsupported'`,
 * exactly as it has always been.
 */
const RULES: ReadonlyMap<string, ModelCompat> = new Map(
  getCatalog().map((model) => [model.id, model.compat]),
);

/**
 * WebKit on a mobile form factor — iOS Safari, and in fact EVERY iOS browser
 * (Chrome/CriOS, Firefox/FxiOS) since they all render through WebKit and
 * classify `'safari'` + `isMobile` in `device/profile.ts`. So this predicate is
 * "iOS WebKit" exactly.
 *
 * Why it gates before any load: real-device testing (iPhone, iOS Safari)
 * showed every ONNX model LOAD crashes the tab in a restart loop — onnxruntime-web
 * fully materializes the model weights into the WASM heap (a multiple of the
 * working set), which blows past iOS's per-tab memory ceiling before a single
 * token is generated. A model escapes this decline only via
 * WEBKIT_MOBILE_VALIDATED_MODEL_IDS below — earned by a real-device pass on a
 * runtime that stays inside the envelope. Everything else must be declined
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
 * A model earns a place here ONLY after a real-device iOS pass confirms it loads
 * and generates without the tab-restart loop; until an id is listed, WebKit-mobile
 * declines it to the designed handoff surface. Every ONNX build still crash-loops
 * on load there (onnxruntime-web fully materializes the weights into the WASM heap,
 * a multiple of the working set, blowing past iOS's per-tab memory ceiling before
 * the first token).
 *
 * Derived from the catalog: an entry earns a place by setting
 * `compat.webkitMobileValidated`. Qwen2.5-0.5B (WebLLM/MLC runtime) is the first
 * — the MLC engine keeps the resident working set inside the iOS envelope, and a
 * real iPhone loaded it and produced coherent prose. Its block additionally
 * carries `requireWebKitMobile`, so validating it opens iOS/WebKit-mobile ONLY;
 * no desktop/Chromium profile is affected.
 */
export const WEBKIT_MOBILE_VALIDATED_MODEL_IDS: readonly string[] =
  getCatalog().filter((model) => model.compat.webkitMobileValidated === true)
    .map((model) => model.id);

/**
 * True when `modelId` is scoped to iOS/WebKit-mobile only. Form-factor facts
 * only (no capability probes), so callers can safely clear a persisted binding
 * on a device class the model was never meant for.
 */
export function requiresWebKitMobile(modelId: string): boolean {
  return RULES.get(modelId)?.requireWebKitMobile === true;
}

export function isCompatible(model: ModelConfig, profile: DeviceProfile): CompatibilityResult {
  const rule = RULES.get(model.id);
  if (!rule) return 'unsupported';

  // Form-factor scope: a WebKit-mobile-only model (the rung-1 WebLLM pick) is
  // unsupported on every non-iOS-WebKit profile — desktop (incl. desktop Safari,
  // which also classifies `'safari'`), Android, and the UA-stripped `'mobile'`
  // class. This is what keeps the entry from perturbing any currently-served
  // desktop/Chromium recommendation; widening it is a separate envelope-gated call.
  if (rule.requireWebKitMobile && !isWebKitMobile(profile)) {
    return 'unsupported';
  }

  // WebKit-mobile (iOS) gate — BEFORE any capability probe so no model is ever
  // load-attempted on a device where the load itself crash-loops the tab (see
  // isWebKitMobile). A model graduates out of this decline only by being added
  // by setting `compat.webkitMobileValidated` after a phone-validated retest.
  if (isWebKitMobile(profile) && !WEBKIT_MOBILE_VALIDATED_MODEL_IDS.includes(model.id)) {
    return 'unsupported';
  }

  if (rule.requireWebgpu && profile.webgpuSupport !== 'webgpu') {
    return 'unsupported';
  }

  // Inverse of requireWebgpu: the int8 CPU-EP floor models are offered ONLY on
  // no-WebGPU devices. On any device with a WebGPU adapter (full or f16-less) a
  // WebGPU-native build decodes far faster, so these slow-on-WebGPU builds must not
  // surface there. (On 'none' devices the below-floor short-circuit already declines.)
  if (rule.requireWasmOnly && profile.webgpuSupport !== 'wasm-only') {
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

  // Inverse of the gate above: a `requireNoShaderF16` build is a plain-int4
  // variant published for f16-less adapters, so it is declined on an adapter that
  // DOES expose shader-f16 — there its q4f16 sibling is the better, non-duplicate
  // pick. Explicit `=== true`: an unprobed profile (`undefined`) is unaffected.
  if (
    profile.webgpuSupport === 'webgpu'
    && profile.webgpuShaderF16 === true
    && rule.requireNoShaderF16
  ) {
    return 'unsupported';
  }

  // WebGPU max-buffer floor (Wave 3 scaffolding — tightening only, dormant). A
  // model whose largest single GPU allocation exceeds the adapter's probed
  // `maxBufferSize` can never load on the WebGPU EP. The explicit `!== undefined`
  // guards mean this bites ONLY when the profile carries a probed ceiling AND the
  // entry declares a floor; no catalog entry sets `compat.minMaxBufferBytes` yet,
  // and an unprobed profile has no `webgpuMaxBufferBytes`, so today it changes nothing.
  if (
    rule.minMaxBufferBytes !== undefined
    && profile.webgpuMaxBufferBytes !== undefined
    && profile.webgpuMaxBufferBytes < rule.minMaxBufferBytes
  ) {
    return 'unsupported';
  }

  // Memory floor. An unreported reading (deviceMemoryGB === 0) is substituted with
  // a conservative UNREPORTED_MEMORY_ASSUMED_GB rather than skipping the floor —
  // otherwise a memory-stripping Chromium fork passes even the ≥8 GB premium tier
  // and is handed a doomed download (see the constant's rationale). For any device
  // that DOES report memory (> 0) this is byte-identical to the prior check.
  const effectiveDeviceMemoryGB =
    profile.deviceMemoryGB > 0 ? profile.deviceMemoryGB : UNREPORTED_MEMORY_ASSUMED_GB;
  if (effectiveDeviceMemoryGB < rule.minDeviceMemoryGB) {
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
    case 'mlc-q4f16':
      return true;
    case 'onnx-q4':
    case 'onnx-int8':
    case 'litertlm':
      return false;
  }
}

export function hasCompatibilityRule(modelId: string): boolean {
  return RULES.has(modelId);
}
