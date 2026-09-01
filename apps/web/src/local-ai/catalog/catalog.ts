// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Catalog — the v1.0 model list.
 *
 * Exactly 10 models ship in the user-facing catalog (the 7 headline picks below,
 * plus the f16-less int4 1.2B sibling and two CPU-EP floor models —
 * granite-4.0-350m-onnx (deeper q4) and smollm2-360m-instruct-onnx (lightest int8)):
 *   1. local/qwen3-0.6b            — Qwen3       (universal small / Safari WASM, proven)
 *   2. candidate/lfm2.5-1.2b-instruct-onnx — LFM2.5 1.2B (capable-laptop, proven; DEFAULT)
 *   3. candidate/lfm2.5-350m-onnx  — LFM2.5      (starter; f16-less-WebGPU light rung —
 *                                    NOT the WASM floor: its block-quant embeddings need
 *                                    GatherBlockQuantized, absent on ort-web's CPU EP)
 *   4. candidate/qwen3.5-2b-onnx   — Qwen3.5 2B  (capable-laptop, proven; opt-in larger
 *                                    model via Settings. Was the everyday default + smart
 *                                    pick until the 2026-08-09 model-ladder read moved both
 *                                    slots to the faster, as-accurate 1.2B)
 *   5. candidate/gemma-4-e2b-litert — Gemma 4    (LiteRT; f16-less-WebGPU default, predicted)
 *   6. candidate/qwen2.5-0.5b-mlc  — Qwen2.5 0.5B (WebLLM/MLC; the WebKit-mobile pick,
 *                                    real-iPhone validated; iOS-only via requireWebKitMobile)
 *   7. candidate/lfm2-2.6b-onnx    — LFM2 2.6B   (capable-laptop; the graduated DEEPER
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

import type {
  ModelConfig,
  ModelGeneration,
  ModelIntent,
  ModelLicense,
  ModelMaxNewTokens,
} from '../types';
import catalogData from './catalog-data.json';

/**
 * A shipping catalog entry. Narrower than `ModelConfig`: `license`,
 * `generation` and `maxNewTokens` are optional on the shared type (test
 * fixtures and eval-lane candidates don't carry them), but every entry in
 * catalog-data.json MUST have all three — we redistribute the weights, so the
 * license travels with them, and the catalog is the single description of how
 * a model is sampled and how long it may generate. `assertCatalogEntry` below
 * pins that at load; this type gives catalog consumers it at compile time.
 */
export type CatalogModel = ModelConfig & {
  license: ModelLicense;
  generation: ModelGeneration;
  maxNewTokens: ModelMaxNewTokens;
};

const INTENTS: readonly ModelIntent[] = [
  'quick', 'explain', 'deep', 'code', 'writing', 'file', 'research',
];

const SAMPLING_KEYS = [
  'temperature', 'topP', 'topK', 'repetitionPenalty', 'noRepeatNgramSize',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bad(id: string, what: string): never {
  throw new Error(`catalog-data.json: model "${id}" ${what}`);
}

function assertFiniteNumber(value: unknown, id: string, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bad(id, `has no finite \`${path}\` (got ${JSON.stringify(value)})`);
  }
}

function assertSampling(value: unknown, id: string, path: string, needsTemperature: boolean): void {
  if (!isRecord(value)) bad(id, `has no \`${path}\` object`);
  if (needsTemperature) assertFiniteNumber(value.temperature, id, `${path}.temperature`);
  for (const key of SAMPLING_KEYS) {
    if (value[key] !== undefined) assertFiniteNumber(value[key], id, `${path}.${key}`);
  }
}

/**
 * Fail loudly, at module load, on a catalog entry missing the data the serving
 * path needs. Deliberately NOT a silent fallback to a house default: an entry
 * that resolves to someone else's sampling is the drift class this fold exists
 * to end.
 */
function assertCatalogEntry(raw: unknown): void {
  if (!isRecord(raw) || typeof raw.id !== 'string') {
    throw new Error('catalog-data.json: entry has no string `id`');
  }
  const id = raw.id;
  if (!isRecord(raw.license)) bad(id, 'has no `license` block');

  assertSampling(raw.generation, id, 'generation', true);
  const generation = raw.generation as Record<string, unknown>;
  if (!isRecord(generation.intentOverrides)) bad(id, 'has no `generation.intentOverrides` object');
  for (const [intent, override] of Object.entries(generation.intentOverrides)) {
    if (!INTENTS.includes(intent as ModelIntent)) {
      bad(id, `has an unknown intent "${intent}" in \`generation.intentOverrides\``);
    }
    assertSampling(override, id, `generation.intentOverrides.${intent}`, false);
  }

  if (!isRecord(raw.maxNewTokens)) bad(id, 'has no `maxNewTokens` object');
  const budget = raw.maxNewTokens;
  for (const key of ['ceiling', 'default', 'max'] as const) {
    assertFiniteNumber(budget[key], id, `maxNewTokens.${key}`);
  }
  if (!isRecord(budget.intentTokens)) bad(id, 'has no `maxNewTokens.intentTokens` object');
  for (const [intent, tokens] of Object.entries(budget.intentTokens)) {
    if (!INTENTS.includes(intent as ModelIntent)) {
      bad(id, `has an unknown intent "${intent}" in \`maxNewTokens.intentTokens\``);
    }
    assertFiniteNumber(tokens, id, `maxNewTokens.intentTokens.${intent}`);
  }
}

for (const entry of catalogData.models as readonly unknown[]) assertCatalogEntry(entry);

const MODELS: readonly CatalogModel[] = Object.freeze(
  (catalogData.models as CatalogModel[]).map((model) => Object.freeze(model)),
);

const MODELS_BY_ID: ReadonlyMap<string, CatalogModel> = new Map(
  MODELS.map((model) => [model.id, model]),
);

/**
 * Return the full shipping catalog. Order matches catalog-data.json,
 * which is the canonical source of truth.
 */
export function getCatalog(): CatalogModel[] {
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
export function getModel(id: string): CatalogModel | null {
  return MODELS_BY_ID.get(id) ?? null;
}
