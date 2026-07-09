// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Catalog — the v1.0 model list.
 *
 * Exactly 7 models ship in the user-facing catalog:
 *   1. local/phi3-mini-4k-q4f16    — Phi-3 Mini   (Chromium WebGPU ≥16GB, proven)
 *   2. local/smollm2-1.7b-webllm-q4f16 — SmolLM2  (secondary high-memory, proven)
 *   3. local/bonsai-1.7b-q4        — Bonsai      (capable-laptop, proven; demoted default)
 *   4. local/qwen3-0.6b            — Qwen3       (universal small / Safari WASM, proven)
 *   5. candidate/lfm2.5-1.2b-instruct-onnx — LFM2.5 1.2B (capable-laptop, proven; DEFAULT)
 *   6. candidate/lfm2.5-350m-onnx  — LFM2.5      (starter; f16-less-WebGPU light rung —
 *                                    NOT the WASM floor: its block-quant embeddings need
 *                                    GatherBlockQuantized, absent on ort-web's CPU EP)
 *   7. candidate/qwen3.5-2b-onnx   — Qwen3.5 2B  (capable-laptop, proven; SMART PICK,
 *                                    graduated 2026-06-11 from the chat #7 bake-off)
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
 * Return the full v1.0 catalog (7 models). Order matches catalog-data.json,
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
