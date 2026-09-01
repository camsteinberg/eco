// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Generation-profile resolution for chat-intent.
 *
 * Resolves sampling (`generationDefaults`) and the length budget
 * (`contextBudget`) for a model id.
 *
 * SHIPPING CATALOG MODELS RESOLVE FROM THE CATALOG. Their sampling rows and
 * length budgets live in `local-ai/catalog/catalog-data.json` (`generation`
 * and `maxNewTokens`), which catalog.ts validates at load — a catalog entry
 * missing either field throws rather than falling back to a house default.
 * Adding a shipping model is a one-file change.
 *
 * What is left in this file is the EVAL LANE: models that exist only for
 * benchmark and validation-harness runs (`allowValidationModel: true`) and are
 * not in the user bundle. Lookup order is catalog id → eval-lane id → eval-lane
 * family fallback → null.
 */

import { getCatalog, getModel } from '../local-ai/catalog/catalog';
import type { ModelIntent, ModelSampling } from '../local-ai/types';

// ─── Local generation/budget types ────────────────────────────────────────

type LocalGenerationSamplingDefaults = Partial<ModelSampling>;

type LocalModelFamily =
  | 'qwen2_5' | 'qwen3' | 'qwen3_5' | 'lfm2';

type LocalModelIntentFit = ModelIntent;

/**
 * Minimal shape consumed by the generation-profile lookup. Chat-intent passes
 * a ChatIntentModelSlice; the profile reader inspects `.id` first and only
 * falls back to `.family`.
 *
 * `family` and `qualityTier` are OPTIONAL because they are eval-lane-only
 * concerns: a shipping catalog model resolves by id from the catalog, so it
 * never reaches the family fallback (here) or the quality-tier baseline table
 * (chat-intent). Context length deliberately does NOT live here — the
 * catalog's `capabilities.contextTokens` is the single source of truth (see
 * local-ai/util.ts `getContextTokens`).
 */
export type ChatIntentModelSlice = {
  id: string;
  family?: LocalModelFamily;
  qualityTier?: 'fast' | 'smart' | 'experimental';
  maxNewTokens: { webgpu: number };
  generationDefaults?: LocalGenerationSamplingDefaults & {
    intentOverrides?: Partial<Record<LocalModelIntentFit, Partial<LocalGenerationSamplingDefaults>>>;
  };
};

// ─── Slim generation-profile shape ────────────────────────────────────────

type ContextBudget = {
  default: number;
  max: number;
  intentTokens: Partial<Record<LocalModelIntentFit, number>>;
};

type GenerationProfileSlice = {
  generationDefaults: LocalGenerationSamplingDefaults & {
    intentOverrides?: Partial<Record<LocalModelIntentFit, Partial<LocalGenerationSamplingDefaults>>>;
  };
  contextBudget: ContextBudget;
  /**
   * Opt this model into deterministic CJK-token suppression on non-CJK
   * conversations (runtime/cjk-suppression.ts). The worker bans every
   * CJK-script vocab token at the logits level unless the conversation itself
   * signals CJK is wanted. Set ONLY on profiles with a measured CJK-leak class
   * — each enabled model is a live surface that needs a real-WebGPU
   * verification run before shipping.
   */
  suppressCjkTokens?: boolean;
};

// ─── Catalog-backed profiles (the shipping path) ──────────────────────────

const CATALOG_SLICES = new Map<string, GenerationProfileSlice>();

function getCatalogProfileSlice(modelId: string): GenerationProfileSlice | undefined {
  const cached = CATALOG_SLICES.get(modelId);
  if (cached) return cached;

  const model = getModel(modelId);
  if (!model) return undefined;

  const { intentOverrides, suppressCjkTokens, ...sampling } = model.generation;
  const slice: GenerationProfileSlice = {
    generationDefaults: { ...sampling, intentOverrides },
    contextBudget: {
      default: model.maxNewTokens.default,
      max: model.maxNewTokens.max,
      intentTokens: model.maxNewTokens.intentTokens,
    },
    ...(suppressCjkTokens === true ? { suppressCjkTokens: true } : {}),
  };
  CATALOG_SLICES.set(modelId, slice);
  return slice;
}

// ─── Eval-lane generation profiles ────────────────────────────────────────
//
// Dev-only benchmark and validation-harness candidates. These are NOT in the
// shipping catalog and are not in the user bundle; they exist so a harness run
// exercises a real generation profile instead of a baseline fallback.
//
// ★ NO `noRepeatNgramSize` ON `writing` (and none at all on an
// instruction-tuned model). Transformers.js applies the n-gram ban across the
// FULL sequence, prompt included — verified by instantiating the real
// `NoRepeatNGramLogitsProcessor` from the pinned 4.2.0 package and calling it
// at generation step 0 with prompt tokens only, which returned -Infinity for
// the offending token. With n=4 the model can copy at most three consecutive
// tokens of the user's own text before the fourth is hard-banned, at every
// position — and `writing` is the intent that fires when someone pastes their
// own words and asks for them back changed. `repetitionPenalty` is the loop
// guard instead. The same hazard note for the shipping models lives in
// catalog-data.json `_documentation.sampling_note`.

const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  default: 1024,
  max: 4096,
  intentTokens: {
    quick: 1024,
    explain: 1536,
    deep: 2048,
    code: 2048,
    writing: 1536,
    file: 2048,
    research: 2048,
  },
};

const QWEN_GEN: GenerationProfileSlice = {
  generationDefaults: {
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    repetitionPenalty: 1.08,
    intentOverrides: {
      quick: { temperature: 0.32, topP: 0.78, repetitionPenalty: 1.06 },
      explain: { temperature: 0.42, topP: 0.84, repetitionPenalty: 1.06 },
      writing: { temperature: 0.48, topP: 0.84, repetitionPenalty: 1.09 },
      code: { temperature: 0.2, topP: 0.8 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
};

const QWEN35_GEN: GenerationProfileSlice = {
  generationDefaults: {
    // Qwen3.5 (non-thinking) vendor rec: temp 0.7 / top_p 0.8 / top_k 20 /
    // presence_penalty 1.5 / repetition_penalty 1.0. Two of those knobs are
    // unreachable here: Transformers.js 4.2.0 implements NEITHER presence_penalty
    // NOR min_p (verified against src/generation/logits_process.js +
    // configuration_utils.js in the pinned package), so we keep
    // repetitionPenalty 1.08 in lieu of the vendor's presence-penalty pairing.
    // top_p is held at 0.8 on no-regression evidence, NOT as a CJK fix — the
    // reproducible s1 leak recurred at 0.8. See the shipping 2B's entry in
    // catalog-data.json and `_documentation.sampling_note` for the full record.
    temperature: 0.6,
    topP: 0.8,
    topK: 20,
    repetitionPenalty: 1.08,
    intentOverrides: {
      quick: { temperature: 0.32, topP: 0.78, repetitionPenalty: 1.06 },
      explain: { temperature: 0.42, topP: 0.8, repetitionPenalty: 1.06 },
      writing: { temperature: 0.48, topP: 0.8, repetitionPenalty: 1.09 },
      code: { temperature: 0.2, topP: 0.8 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
  // Measured CJK leak class (s1 "甲烷" 2/2, sampling fix refuted) — the
  // deterministic suppression is the fix. Shared with the shipping 2B, whose
  // own copy of this flag lives in the catalog.
  suppressCjkTokens: true,
};

const GEMMA4_GEN: GenerationProfileSlice = {
  generationDefaults: {
    // Gemma 4 generation_config.json ships temp 1.0 / top_k 64 / top_p 0.95.
    // Full temp 1.0 is too hot for Eco's intent-routed factual asks; we keep the
    // vendor's top_k/top_p anchors and scale temperature to the house intent
    // pattern (cf. QWEN35_GEN). NO noRepeatNgramSize — TJS bans n-grams
    // across the prompt too (see the hazard note above).
    temperature: 0.6,
    topP: 0.95,
    topK: 64,
    repetitionPenalty: 1.05,
    intentOverrides: {
      quick: { temperature: 0.3, topP: 0.85 },
      explain: { temperature: 0.45, topP: 0.92 },
      writing: { temperature: 0.6, topP: 0.95, repetitionPenalty: 1.08 },
      code: { temperature: 0.2, topP: 0.85 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
};

const GEMMA4_LITERT_GEN: GenerationProfileSlice = {
  generationDefaults: {
    // LiteRT-LM Web 0.13.1 exposes sampler type / temperature / top_k / top_p
    // / seed only. It has no repetition-penalty or no-repeat-ngram controls, so
    // the LiteRT path must not inherit the generic Gemma profile's unsupported
    // loop guards. Instead, give Gemma its best fair product shot by using the
    // controls the runtime can actually honor plus tighter concise budgets.
    temperature: 0.45,
    topP: 0.9,
    topK: 64,
    intentOverrides: {
      quick: { temperature: 0.18, topP: 0.72 },
      explain: { temperature: 0.3, topP: 0.82 },
      deep: { temperature: 0.42, topP: 0.88 },
      writing: { temperature: 0.45, topP: 0.9 },
      code: { temperature: 0.18, topP: 0.8 },
    },
  },
  contextBudget: {
    default: 1024,
    max: 2048,
    intentTokens: {
      quick: 256,
      explain: 768,
      deep: 1536,
      code: 1024,
      writing: 1024,
      file: 1536,
      research: 1536,
    },
  },
};

// ─── Eval-lane lookup maps ────────────────────────────────────────────────
//
// Shipping catalog ids are deliberately ABSENT: they resolve from
// catalog-data.json. Only dev-lane candidates appear here.

const PROFILE_BY_MODEL_ID: Record<string, GenerationProfileSlice> = {
  // Phase-2 eval candidate.
  "candidate/qwen3-1.7b-onnx": QWEN_GEN,
  // Chat #7 M2 bake-off candidates. The qwen3.5-4b shares the Qwen3.5 family
  // rec, so it rides the same slice as the shipping 2B (top_p 0.8
  // tail-narrowing, CJK suppression). Gemma 4 gets its own vendor-anchored slice.
  "candidate/qwen3.5-4b-onnx": QWEN35_GEN,
  "candidate/gemma-4-e2b-onnx": GEMMA4_GEN,
  // Community QAT-q4 Gemma 4 E2B (nico-martin) — same vendor-anchored Gemma slice.
  "candidate/gemma-4-e2b-qat-q4-onnx": GEMMA4_GEN,
  // Runtime bake-off cell: Qwen3-0.6B on MLC — same qwen3 family as the
  // shipping local/qwen3-0.6b, so it rides the generic Qwen slice. NOT QWEN35_GEN.
  "candidate/qwen3-0.6b-mlc": QWEN_GEN,
  // Gemma 4 E4B via LiteRT-LM Web — the eval-only sibling of the shipping E2B
  // LiteRT entry, on the same runtime-specific slice.
  "candidate/gemma-4-e4b-litert": GEMMA4_LITERT_GEN,
};

// Partial: only the families an eval-lane model can actually land on. The
// families whose sole members graduated into the catalog (qwen2_5, lfm2) no
// longer need a fallback row — those models resolve by id from the catalog.
const FAMILY_FALLBACK: Partial<Record<LocalModelFamily, GenerationProfileSlice>> = {
  qwen3: QWEN_GEN,
  qwen3_5: QWEN35_GEN,
};

// ─── Profile lookup ───────────────────────────────────────────────────────

function getGenerationProfileSlice(
  model: ChatIntentModelSlice | null | undefined,
): GenerationProfileSlice | null {
  if (!model) return null;
  return getCatalogProfileSlice(model.id)
    ?? PROFILE_BY_MODEL_ID[model.id]
    ?? (model.family ? FAMILY_FALLBACK[model.family] : undefined)
    ?? null;
}

// ─── Public accessors ─────────────────────────────────────────────────────

export function getLocalModelGenerationDefaults(
  model: ChatIntentModelSlice | null | undefined,
  intent?: LocalModelIntentFit,
): Partial<LocalGenerationSamplingDefaults> {
  const profile = getGenerationProfileSlice(model);
  const modelDefaults = model?.generationDefaults;
  const profileDefaults = profile?.generationDefaults;
  const intentDefaults = intent
    ? {
      ...(modelDefaults?.intentOverrides?.[intent] ?? {}),
      ...(profileDefaults?.intentOverrides?.[intent] ?? {}),
    }
    : {};

  return {
    ...(modelDefaults?.temperature != null ? { temperature: modelDefaults.temperature } : {}),
    ...(modelDefaults?.topP != null ? { topP: modelDefaults.topP } : {}),
    ...(modelDefaults?.topK != null ? { topK: modelDefaults.topK } : {}),
    ...(modelDefaults?.repetitionPenalty != null ? { repetitionPenalty: modelDefaults.repetitionPenalty } : {}),
    ...(modelDefaults?.noRepeatNgramSize != null ? { noRepeatNgramSize: modelDefaults.noRepeatNgramSize } : {}),
    ...(profileDefaults?.temperature != null ? { temperature: profileDefaults.temperature } : {}),
    ...(profileDefaults?.topP != null ? { topP: profileDefaults.topP } : {}),
    ...(profileDefaults?.topK != null ? { topK: profileDefaults.topK } : {}),
    ...(profileDefaults?.repetitionPenalty != null ? { repetitionPenalty: profileDefaults.repetitionPenalty } : {}),
    ...(profileDefaults?.noRepeatNgramSize != null ? { noRepeatNgramSize: profileDefaults.noRepeatNgramSize } : {}),
    ...intentDefaults,
  };
}

export function getLocalModelContextBudget(
  model: ChatIntentModelSlice | null | undefined,
  intent?: LocalModelIntentFit,
): number | null {
  // No profile → no model-specific budget; the caller's qualityTier/baseline
  // tables take over. (The old `model.contextLength` fallback was verified
  // behavior-identical to null for every entry: the profile-less lab models
  // all have maxNewTokens.webgpu ≤ every tier budget, so the webgpu limit
  // binds either way.)
  const profile = getGenerationProfileSlice(model);
  if (!profile) return null;
  const budget = intent ? profile.contextBudget.intentTokens[intent] : undefined;
  return Math.min(budget ?? profile.contextBudget.default, profile.contextBudget.max);
}

/**
 * Whether `modelId` opts into deterministic CJK-token suppression
 * (runtime/cjk-suppression.ts). Id-based lookup ONLY — the call site
 * (transformers-adapter, at worker init) has the model id but not the
 * family. Every shipping model carries the flag in its catalog entry and
 * every eval-lane model has an explicit PROFILE_BY_MODEL_ID row, so the
 * family fallback would never legitimately fire here.
 */
export function isCjkSuppressionEnabled(modelId: string): boolean {
  const profile = getCatalogProfileSlice(modelId) ?? PROFILE_BY_MODEL_ID[modelId];
  return profile?.suppressCjkTokens === true;
}

/**
 * Test-only export — every id with an explicit (non-family-fallback) profile:
 * the shipping catalog plus the eval lane. Underscore prefix marks it as not
 * for runtime consumers.
 *
 * A function, not a const: reading the catalog at module load would break
 * every suite that mocks `catalog/catalog` with just the exports it needs.
 */
export function __profileModelIds(): string[] {
  return [...getCatalog().map((model) => model.id), ...Object.keys(PROFILE_BY_MODEL_ID)];
}
