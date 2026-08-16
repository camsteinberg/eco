// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Catalog — the v1.0 model list.
 *
 * Exactly 11 models ship in the user-facing catalog (the 8 headline picks below,
 * plus the f16-less int4 1.2B sibling and two int8 CPU-EP floor models —
 * qwen2.5-0.5b-instruct-onnx and smollm2-360m-instruct-onnx):
 *   1. local/phi3-mini-4k-q4f16    — Phi-3 Mini   (Chromium WebGPU ≥16GB, proven)
 *   2. local/qwen3-0.6b            — Qwen3       (universal small / Safari WASM, proven)
 *   3. candidate/lfm2.5-1.2b-instruct-onnx — LFM2.5 1.2B (capable-laptop, proven; DEFAULT)
 *   4. candidate/lfm2.5-350m-onnx  — LFM2.5      (starter; f16-less-WebGPU light rung —
 *                                    NOT the WASM floor: its block-quant embeddings need
 *                                    GatherBlockQuantized, absent on ort-web's CPU EP)
 *   5. candidate/qwen3.5-2b-onnx   — Qwen3.5 2B  (capable-laptop, proven; opt-in larger
 *                                    model via Settings. Was the everyday default + smart
 *                                    pick until the 2026-08-09 model-ladder read moved both
 *                                    slots to the faster, as-accurate 1.2B)
 *   6. candidate/gemma-4-e2b-litert — Gemma 4    (LiteRT; f16-less-WebGPU default, predicted)
 *   7. candidate/qwen2.5-0.5b-mlc  — Qwen2.5 0.5B (WebLLM/MLC; the WebKit-mobile pick,
 *                                    real-iPhone validated; iOS-only via requireWebKitMobile)
 *   8. candidate/lfm2-2.6b-onnx    — LFM2 2.6B   (capable-laptop; the graduated DEEPER
 *                                    eco-smart pick, 2026-08-10 — 'predicted' pending a
 *                                    second-machine by-eye validation)
 *
 * SmolLM2 (WebLLM/MLC) was retired 2026-07-10 and Bonsai 2026-07-11 — see the
 * retirement migrations in lifecycle/self-heal.ts and CHANGES.md.
 *
 * Non-shipping evaluation candidates live in
 * `apps/web/src/local-ai/eval/eval-candidates.ts` (the eval-only lane) and are
 * not in the user bundle. See `docs/design/2026-05-16/vision-and-architecture.md` §2.4.
 */

import type { ModelConfig } from '../types';
import catalogData from './catalog-data.json';

const MODELS: readonly ModelConfig[] = Object.freeze(
  (catalogData.models as ModelConfig[]).map((model) => Object.freeze(model)),
);

const MODELS_BY_ID: ReadonlyMap<string, ModelConfig> = new Map(
  MODELS.map((model) => [model.id, model]),
);

/**
 * Return the full v1.0 catalog (8 models). Order matches catalog-data.json,
 * which is the canonical source of truth.
 */
export function getCatalog(): ModelConfig[] {
  return [...MODELS];
}

/**
 * Return a single model by id, or null if the id is not in the v1.0 catalog.
 * Use this for model-id lookups (e.g., resolving a stored slot assignment).
 *
 * NOTE: this only returns v1.0 catalog models. Non-shipping evaluation
 * candidates are not reachable through this function — they live in
 * `apps/web/src/local-ai/eval/eval-candidates.ts`.
 */
export function getModel(id: string): ModelConfig | null {
  return MODELS_BY_ID.get(id) ?? null;
}
