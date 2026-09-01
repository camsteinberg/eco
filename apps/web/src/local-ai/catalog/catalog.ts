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
 * Non-shipping evaluation candidates live in the SAME file, flagged
 * `shipping: false`. `getCatalog()` filters them out; `getEvalLaneModels()` (and
 * the `eval/eval-candidates.ts` view over it) is the only way to reach them, and
 * the proxy serves them solely behind the loopback validation gate. See
 * `docs/design/2026-05-16/vision-and-architecture.md` §2.4.
 */

import type {
  BrowserClass,
  ModelCompat,
  ModelConfig,
  ModelDisplay,
  ModelGeneration,
  ModelIntent,
  ModelLicense,
  ModelMaxNewTokens,
  ModelTier,
  ModelTierAssignment,
  Slot,
} from '../types';
import catalogData from './catalog-data.json';

/**
 * A SHIPPING catalog entry. Narrower than `ModelConfig`: `license`,
 * `generation`, `maxNewTokens`, `compat`, `display` and `tier` are all optional
 * on the shared type (test fixtures and eval-lane entries don't carry them), but
 * every entry in catalog-data.json with `shipping: true` MUST have all of them —
 * we redistribute the weights, so the license travels with them, and the catalog
 * is the single description of how a model is sampled, how long it may generate,
 * which devices may run it, which device tier it is the default for, and how it
 * is named to a person. `assertCatalogEntry` below pins that at load; this type
 * gives catalog consumers it at compile time.
 */
export type CatalogModel = ModelConfig & {
  license: ModelLicense;
  generation: ModelGeneration;
  maxNewTokens: ModelMaxNewTokens;
  compat: ModelCompat;
  display: ModelDisplay;
  shipping: true;
  tier: ModelTierAssignment;
};

const INTENTS: readonly ModelIntent[] = [
  'quick', 'explain', 'deep', 'code', 'writing', 'file', 'research',
];

const SAMPLING_KEYS = [
  'temperature', 'topP', 'topK', 'repetitionPenalty', 'noRepeatNgramSize',
] as const;

const BROWSER_CLASSES: readonly BrowserClass[] = [
  'chromium', 'safari', 'firefox', 'mobile', 'unknown',
];

const SLOTS: readonly Slot[] = ['eco-fast', 'eco-smart'];

/**
 * The tier ladder, best rung first. `selection/recommend.ts` walks it in this
 * order, so the array IS the fallback order — see {@link ModelTierAssignment}.
 */
export const TIER_ORDER: readonly ModelTier[] = ['capable', 'laptop', 'phone', 'floor'];

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

function assertBoolean(value: unknown, id: string, path: string): void {
  if (typeof value !== 'boolean') {
    bad(id, `has no boolean \`${path}\` (got ${JSON.stringify(value)})`);
  }
}

function assertNonEmptyString(value: unknown, id: string, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    bad(id, `has no non-empty \`${path}\` (got ${JSON.stringify(value)})`);
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
  assertBoolean(raw.shipping, id, 'shipping');

  // A WebLLM entry with no vendored `model_lib` wasm cannot load at all — the
  // engine fails after a full download. Catch it here, at the point of origin.
  // Applies to BOTH lanes: an eval candidate is loaded by the same adapter.
  if (raw.runtime === 'webllm') {
    if (!isRecord(raw.quirks)) bad(id, 'is a webllm model with no `quirks` object');
    assertNonEmptyString(raw.quirks.webllmModelLibFile, id, 'quirks.webllmModelLibFile');
  }

  // The eval lane stops here. Those entries are never recommended, rendered in
  // primary UI, or served to a device — they are downloaded by id through the
  // loopback-gated validation proxy and handed straight to `loadModel`. Demanding
  // sampling, device rules, presentation copy and a redistribution license of them
  // would mean inventing all four, so the fields they genuinely need (id, runtime,
  // format, artifact) are what is checked. `shipping: true` is what turns the
  // full contract below on.
  if (raw.shipping !== true) {
    if (!isRecord(raw.artifact)) bad(id, 'is an eval-lane entry with no `artifact` block');
    return;
  }

  assertTier(raw.tier, id);
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

  assertCompat(raw.compat, id);
  assertDisplay(raw.display, id);
}

/**
 * A shipping entry must declare which device tier it is the default for, even if
 * the answer is "none" (`{}`). Silence is not an acceptable answer: an entry that
 * simply omitted the block would join the catalog as nobody's default and be
 * reachable only by fit score, which is exactly the drift this fold ends.
 */
function assertTier(value: unknown, id: string): void {
  if (!isRecord(value)) bad(id, 'has no `tier` object (use `{}` for "not a default")');
  for (const [slot, tier] of Object.entries(value)) {
    if (!SLOTS.includes(slot as Slot)) {
      bad(id, `has an unknown slot "${slot}" in \`tier\``);
    }
    if (!TIER_ORDER.includes(tier as ModelTier)) {
      bad(id, `has an unknown tier ${JSON.stringify(tier)} in \`tier.${slot}\``);
    }
  }
}

/**
 * Exactly one model may hold a given (slot, tier) rung. Two claimants would make
 * the ladder's lookup order depend on array position in catalog-data.json — a
 * silent tie-break nobody wrote down.
 */
function assertTierRungsAreUnique(models: readonly CatalogModel[]): void {
  const claimed = new Map<string, string>();
  for (const model of models) {
    for (const slot of SLOTS) {
      const tier = model.tier[slot];
      if (tier === undefined) continue;
      const rung = `${slot}/${tier}`;
      const holder = claimed.get(rung);
      if (holder !== undefined) {
        throw new Error(
          `catalog-data.json: models "${holder}" and "${model.id}" both claim tier rung ${rung}`,
        );
      }
      claimed.set(rung, model.id);
    }
  }
}

function assertCompat(value: unknown, id: string): void {
  if (!isRecord(value)) bad(id, 'has no `compat` block');
  assertBoolean(value.requireWebgpu, id, 'compat.requireWebgpu');
  assertBoolean(value.warnIfMobile, id, 'compat.warnIfMobile');
  assertFiniteNumber(value.minDeviceMemoryGB, id, 'compat.minDeviceMemoryGB');
  if (!Array.isArray(value.allowedBrowsers) || value.allowedBrowsers.length === 0) {
    bad(id, 'has no non-empty `compat.allowedBrowsers` array');
  }
  for (const browser of value.allowedBrowsers as readonly unknown[]) {
    if (!BROWSER_CLASSES.includes(browser as BrowserClass)) {
      bad(id, `has an unknown browser class ${JSON.stringify(browser)} in \`compat.allowedBrowsers\``);
    }
  }
  for (const key of [
    'requireWasmOnly', 'requireWebKitMobile', 'webkitMobileValidated',
    'cpuEpIncompatible', 'requireNoShaderF16',
  ] as const) {
    if (value[key] !== undefined) assertBoolean(value[key], id, `compat.${key}`);
  }
  if (value.minMaxBufferBytes !== undefined) {
    assertFiniteNumber(value.minMaxBufferBytes, id, 'compat.minMaxBufferBytes');
  }
}

function assertDisplay(value: unknown, id: string): void {
  if (!isRecord(value)) bad(id, 'has no `display` block');
  assertNonEmptyString(value.friendlyName, id, 'display.friendlyName');
  assertNonEmptyString(value.qualityPhrase, id, 'display.qualityPhrase');
  assertNonEmptyString(value.provider, id, 'display.provider');
  if (value.welcome === undefined) return;
  if (!isRecord(value.welcome)) bad(id, 'has a non-object `display.welcome`');
  assertNonEmptyString(value.welcome.name, id, 'display.welcome.name');
  assertNonEmptyString(value.welcome.tagline, id, 'display.welcome.tagline');
  assertFiniteNumber(value.welcome.speed, id, 'display.welcome.speed');
  assertFiniteNumber(value.welcome.depth, id, 'display.welcome.depth');
}

for (const entry of catalogData.models as readonly unknown[]) assertCatalogEntry(entry);

const ALL_ENTRIES: readonly ModelConfig[] = Object.freeze(
  (catalogData.models as ModelConfig[]).map((model) => Object.freeze(model)),
);

/**
 * True for a shipping entry. The cast is sound because `assertCatalogEntry` has
 * already thrown, at module load, for any entry with `shipping: true` that is
 * missing one of the blocks `CatalogModel` adds — so past this predicate the
 * fields really are present, not merely assumed.
 */
function isShipping(model: ModelConfig): model is CatalogModel {
  return model.shipping === true;
}

const MODELS: readonly CatalogModel[] = Object.freeze(ALL_ENTRIES.filter(isShipping));

assertTierRungsAreUnique(MODELS);

/**
 * The dev-only eval lane: every entry with `shipping: false`. Downloadable only
 * through the loopback-gated validation proxy, and — because `getCatalog()`
 * below returns `MODELS`, which this set is disjoint from — never reachable from
 * the recommendation engine, the ModelSelector, or any user-facing surface.
 */
const EVAL_LANE: readonly ModelConfig[] = Object.freeze(
  ALL_ENTRIES.filter((model) => !isShipping(model)),
);

const MODELS_BY_ID: ReadonlyMap<string, CatalogModel> = new Map(
  MODELS.map((model) => [model.id, model]),
);

/**
 * Return the shipping catalog — entries with `shipping: true`, and ONLY those.
 * catalog-data.json also holds the dev-only eval lane (`shipping: false`); this
 * filter is what keeps it out of every user-facing surface, since essentially
 * every consumer in `local-ai/` reads the catalog through this function.
 * Order matches catalog-data.json, which is the canonical source of truth.
 */
export function getCatalog(): CatalogModel[] {
  return [...MODELS];
}

/**
 * Return the non-shipping eval-lane entries. Consumers MUST gate on
 * `isValidationHarnessRequestAllowed` before serving anything derived from these
 * — in production the lane must stay invisible (403/404).
 */
export function getEvalLaneModels(): ModelConfig[] {
  return [...EVAL_LANE];
}

/**
 * Return a single model by id, or null if the id is not in the v1.0 catalog.
 * Use this for model-id lookups (e.g., resolving a stored slot assignment).
 *
 * NOTE: this only returns SHIPPING catalog models. The non-shipping eval lane
 * is not reachable through this function — `getEvalLaneModels()` is.
 */
export function getModel(id: string): CatalogModel | null {
  return MODELS_BY_ID.get(id) ?? null;
}
