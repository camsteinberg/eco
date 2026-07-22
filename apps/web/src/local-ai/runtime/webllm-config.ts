// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * WebLLM serving config — the SINGLE source of truth for how a catalog model
 * maps onto `@mlc-ai/web-llm`'s `ModelRecord` and Cache API layout.
 *
 * Three consumers must agree byte-for-byte or serving silently breaks:
 *
 *   - the engine factory (bootstrap.ts) builds the `appConfig` the engine
 *     reads its `ModelRecord.model` base + `model_lib` from;
 *   - the cache bridge (webllm-cache-bridge.ts) pre-populates WebLLM's Cache
 *     API namespaces keyed by URLs DERIVED FROM THAT SAME base;
 *   - the adapter's `weightsCached()` builds the same `appConfig` so the real
 *     `hasModelInCache` resolves our self-hosted record (a bare call with no
 *     appConfig would look only in `prebuiltAppConfig` and never find it).
 *
 * Because the base URL and the model id both come from ONE pure function here,
 * the three can never diverge. All functions are pure and unit-tested.
 *
 * Type-only imports of `AppConfig`/`ModelRecord` are erased at compile time —
 * this module pulls in NO `@mlc-ai/web-llm` runtime code, so importing it never
 * loads the lazy engine chunk.
 */

import type { AppConfig, ModelRecord } from '@mlc-ai/web-llm';
import type { ModelConfig } from '../types';

/**
 * The prebuilt-model-library version this npm is compatible with — mirrors
 * `@mlc-ai/web-llm`'s exported `modelVersion` ("v0_2_84/base"). The `model_lib`
 * wasm is compiled per (model, web-llm version); a web-llm bump generally
 * requires re-vendoring the wasm under a new version dir, so the version is
 * baked into the same-origin path and the two move together.
 */
export const WEBLLM_MODEL_LIB_VERSION = 'v0_2_84';

/** Same-origin dir the version's vendored `model_lib` wasm binaries live under. */
export const WEBLLM_MODEL_LIB_BASE_PATH = `/webllm/${WEBLLM_MODEL_LIB_VERSION}/`;

/**
 * The one `model_lib` this stage targets: the Qwen2-0.5B q4f16 WebGPU library
 * compiled against web-llm v0_2_84. Version-coupled by construction (see
 * WEBLLM_MODEL_LIB_VERSION). The wasm binary itself is vendored to
 * `apps/web/public/webllm/v0_2_84/` in a SEPARATE hash-verified step — this
 * constant only references its future same-origin path; nothing here ships it.
 *
 * A future multi-model stage derives this per-model from the catalog entry
 * instead of a constant; until a second WebLLM model exists there is exactly
 * one library, so a constant is the honest representation.
 */
export const WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH =
  `${WEBLLM_MODEL_LIB_BASE_PATH}Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm`;

/**
 * MLC's `ModelRecord.model_id` (and its cache layout) uses the repo name WITHOUT
 * the org prefix (e.g. `Qwen2-0.5B-Instruct-q4f16_1-MLC`). The catalog stores the
 * full HF id (`mlc-ai/Qwen2-0.5B-Instruct-q4f16_1-MLC`); strip the `mlc-ai/`
 * prefix to get the MLC id. Idempotent on an already-stripped id.
 */
export function stripMlcOrgPrefix(hfId: string): string {
  return hfId.replace(/^mlc-ai\//, '');
}

/**
 * The model's weight/config base URL — the single source of truth both the
 * engine's `ModelRecord.model` and the bridge's cache keys derive from.
 *
 * Returns the ALREADY-cleaned form web-llm's internal `cleanModelUrl` produces
 * (absolute, ending in `/resolve/main/`), so `cleanModelUrl` is idempotent on it
 * and the URL the engine keys its cache lookups by is byte-identical to the URL
 * the bridge writes under. The path is same-origin and intentionally NOT a real
 * hosted route: the bridge fully pre-populates the cache, so the engine's
 * check-before-fetch never actually fetches from here.
 */
export function webllmModelBaseUrl(mlcId: string, origin: string): string {
  return `${origin}/webllm/models/${mlcId}/resolve/main/`;
}

/** Build the single-record `ModelRecord` for a catalog model. */
export function buildWebLLMModelRecord(
  mlcId: string,
  origin: string,
  modelLibPath: string,
): ModelRecord {
  return {
    model: webllmModelBaseUrl(mlcId, origin),
    model_id: mlcId,
    model_lib: modelLibPath,
  };
}

/**
 * The `AppConfig` carrying exactly this model — passed to `CreateMLCEngine`/
 * `new MLCEngine`, `hasModelInCache`, and the bridge so every WebLLM call
 * resolves our self-hosted record instead of the prebuilt list.
 */
export function buildWebLLMAppConfig(
  mlcId: string,
  origin: string,
  modelLibPath: string,
): AppConfig {
  return { model_list: [buildWebLLMModelRecord(mlcId, origin, modelLibPath)] };
}

/**
 * The `model_lib` wasm path for a catalog model. One WebLLM model exists this
 * stage, so this returns the single vendored library regardless of input; the
 * parameter is here so the call sites already pass the model and a future
 * multi-model stage only has to change this body (e.g. a per-entry catalog
 * field) without touching its callers.
 */
export function webllmModelLibPathFor(_model: ModelConfig): string {
  return WEBLLM_QWEN2_0_5B_MODEL_LIB_PATH;
}

// ─── Cache-key mapping ──────────────────────────────────────────────────────

/** The three Cache API namespaces WebLLM 0.2.84 uses (verified against the tarball). */
export type WebLLMCacheScope = 'webllm/model' | 'webllm/config' | 'webllm/wasm';

/**
 * The Cache API namespace + key WebLLM will look a repo file up under, given its
 * repo-relative path and the model base URL.
 *
 * Verified against web-llm 0.2.84:
 *   - `mlc-chat-config.json` → `webllm/config`, key `new URL(name, base).href`
 *   - everything else (`tensor-cache.json`, `params_shard_*.bin`, tokenizer
 *     files) → `webllm/model`, key `new URL(name, base).href`
 * The `model_lib` wasm (`webllm/wasm`) is NOT mapped here — it is same-origin
 * static and the engine fetches + caches it itself on first load.
 *
 * `base` MUST be `webllmModelBaseUrl(...)` output so the key matches the URL the
 * engine computes internally (`new URL(dataPath, cleanModelUrl(record.model))`).
 */
export function webllmCacheTargetFor(
  fileName: string,
  base: string,
): { scope: WebLLMCacheScope; key: string } {
  const key = new URL(fileName, base).href;
  const basename = fileName.split('/').pop() ?? fileName;
  const scope: WebLLMCacheScope =
    basename === 'mlc-chat-config.json' ? 'webllm/config' : 'webllm/model';
  return { scope, key };
}
