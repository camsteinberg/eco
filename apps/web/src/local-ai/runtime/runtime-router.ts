// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Runtime router — picks an adapter per (model, device, intent).
 *
 * Rules:
 *
 *   - The catalog declares each model's preferred runtime via
 *     `ModelConfig.runtime` ('transformers' | 'litert' | 'webllm'). That's
 *     the primary signal — the router respects it.
 *
 *   - Transformers.js works on WebGPU (preferred) and WASM (fallback).
 *     The router doesn't pick a backend — the adapter inspects the
 *     profile at load time and chooses WebGPU vs WASM. That's because
 *     "what backend can I actually init" is a runtime answer, not a
 *     routing answer.
 *
 *   - LiteRT-LM Web runs only its own `.litertlm` builds — there is no
 *     cross-runtime fallback (a `.litertlm` can't load on TJS). It is
 *     Chromium-WebGPU-only by construction; on an unsupported device it
 *     fails at load. Compatibility gating keeps it off such devices upstream.
 *
 *   - WebLLM/MLC runs only its own MLC-compiled builds — no cross-runtime
 *     fallback, same reasoning as LiteRT. Re-integrated (s38) as the WebKit
 *     survival path ORT cannot serve; `WebLLMAdapter` exists and is routed
 *     to here, but no production engine factory is registered yet (that
 *     needs a specific self-hosted model_lib, a model-scope decision this
 *     router doesn't make) — until one is, load() fails with an honest
 *     'init-failed', matching every other not-yet-configured seam.
 *
 * No `intent`-based override is needed at the router level. The
 * recommendation engine already factored intent into which model it
 * recommends; by the time we're routing, the model is decided.
 */

import type { ModelConfig, DeviceProfile, ModelRuntime } from '../types';

export type RoutingResult = {
  runtime: ModelRuntime;
  /** Reason for the choice — useful for diagnostics. */
  reason: 'catalog-runtime' | 'forced-wasm';
};

// `_profile` is retained for the routing contract (callers pass the device
// profile) even though runtime selection is now purely catalog-declared.
export function selectRuntime(
  model: ModelConfig,
  _profile: DeviceProfile,
): RoutingResult {
  // LiteRT-LM Web (its own `.litertlm` builds only) — no cross-runtime fallback.
  if (model.runtime === 'litert') {
    return { runtime: 'litert', reason: 'catalog-runtime' };
  }

  // WebLLM/MLC (its own MLC-compiled builds only) — no cross-runtime fallback.
  if (model.runtime === 'webllm') {
    return { runtime: 'webllm', reason: 'catalog-runtime' };
  }

  // Everything else is Transformers.js; the adapter picks WebGPU vs WASM at
  // load time.
  return { runtime: 'transformers', reason: 'catalog-runtime' };
}
