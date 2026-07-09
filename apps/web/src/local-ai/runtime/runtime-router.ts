// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runtime router — picks an adapter per (model, device, intent).
 *
 * Rules:
 *
 *   - The catalog declares each model's preferred runtime via
 *     `ModelConfig.runtime` ('transformers' | 'webllm'). That's the
 *     primary signal — the router respects it unless the device cannot
 *     support that runtime (e.g. WebLLM on Safari).
 *
 *   - WebLLM requires Chromium-class WebGPU. On any other browser/device
 *     combination, fall back to Transformers.js (which has a WASM path).
 *
 *   - Transformers.js works on WebGPU (preferred) and WASM (fallback).
 *     The router doesn't pick a backend — the adapter inspects the
 *     profile at load time and chooses WebGPU vs WASM. That's because
 *     "what backend can I actually init" is a runtime answer, not a
 *     routing answer.
 *
 *   - Safari 26 WebGPU: the older JSEP memory-leak path was replaced in
 *     Transformers.js v4 (native C++ runtime), so the leak is moot. The
 *     router still prefers WASM on Safari for safety until v4 stability
 *     is empirically verified on Safari WebGPU.
 *
 * No `intent`-based override is needed at the router level. The
 * recommendation engine already factored intent into which model it
 * recommends; by the time we're routing, the model is decided.
 */

import type { ModelConfig, DeviceProfile, ModelRuntime } from '../types';

export type RoutingResult = {
  runtime: ModelRuntime;
  /** Reason for the choice — useful for diagnostics. */
  reason: 'catalog-runtime' | 'webllm-fallback' | 'forced-wasm';
};

export function selectRuntime(
  model: ModelConfig,
  profile: DeviceProfile,
): RoutingResult {
  // Default: trust the catalog's declared runtime.
  if (model.runtime === 'transformers') {
    return { runtime: 'transformers', reason: 'catalog-runtime' };
  }

  // LiteRT-LM Web (dev-only eval lane) runs only its own `.litertlm` builds —
  // there is no cross-runtime fallback (a `.litertlm` can't load on TJS). It is
  // Chromium-WebGPU-only by construction; on an unsupported device it fails at
  // load, which is acceptable for the dev harness it's gated to.
  if (model.runtime === 'litert') {
    return { runtime: 'litert', reason: 'catalog-runtime' };
  }

  // model.runtime === 'webllm' — needs Chromium WebGPU.
  if (canRunWebLLM(profile)) {
    return { runtime: 'webllm', reason: 'catalog-runtime' };
  }

  // Anything else falls back to the universal Transformers.js path
  // (which will pick WASM at load time when WebGPU is unavailable).
  return { runtime: 'transformers', reason: 'webllm-fallback' };
}

/**
 * WebLLM requires Chromium-class WebGPU. Safari and Firefox cannot use
 * the MLC runtime today even if WebGPU is reported, because the model
 * libraries are compiled with Chromium's WGSL dialect quirks in mind.
 *
 * If the catalog ever lists a WebLLM model that targets Firefox/Safari
 * specifically, expand this check accordingly.
 */
export function canRunWebLLM(profile: DeviceProfile): boolean {
  return profile.browserClass === 'chromium'
    && profile.webgpuSupport === 'webgpu'
    && !profile.isMobile;
}
