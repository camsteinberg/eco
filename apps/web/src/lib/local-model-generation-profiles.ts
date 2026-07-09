// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Per-model generation profiles for the v1 local-AI catalog.
 *
 * Resolves `generationDefaults` (sampling) and `contextBudget` (max-new-tokens)
 * for chat-intent. Lookup priority: model id → family fallback → null. Entries
 * here MUST stay in sync with `apps/web/src/local-ai/catalog/catalog-data.json`;
 * an invariant test in `__tests__/local-model-generation-profiles.test.ts`
 * guards that contract.
 */

// ─── Local generation/budget types (inlined, see catalog for model ids) ──

type LocalGenerationSamplingDefaults = {
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  noRepeatNgramSize?: number;
};

type LocalModelFamily =
  | 'qwen3' | 'qwen3_5' | 'smollm2' | 'bonsai' | 'phi' | 'lfm2';

type LocalModelIntentFit =
  | 'quick' | 'explain' | 'deep' | 'code' | 'writing' | 'file' | 'research';

/**
 * Minimal shape consumed by the generation-profile lookup. Chat-intent
 * passes a ChatIntentModelSlice; the profile reader only inspects .id,
 * .family, and .generationDefaults. Context length deliberately does NOT
 * live here — the catalog's `capabilities.contextTokens` is the single
 * source of truth (see local-ai/util.ts `getContextTokens`).
 */
export type ChatIntentModelSlice = {
  id: string;
  family: LocalModelFamily;
  qualityTier: 'fast' | 'smart' | 'experimental';
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

// ─── Shared budget constants ──────────────────────────────────────────────

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

// ─── Per-model generation profiles ────────────────────────────────────────

const QWEN_GEN: GenerationProfileSlice = {
  generationDefaults: {
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    repetitionPenalty: 1.08,
    intentOverrides: {
      quick: { temperature: 0.32, topP: 0.78, repetitionPenalty: 1.06 },
      explain: { temperature: 0.42, topP: 0.84, repetitionPenalty: 1.06 },
      writing: { temperature: 0.48, topP: 0.84, repetitionPenalty: 1.09, noRepeatNgramSize: 4 },
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
    // configuration_utils.js in the pinned package — only temperature, top_p,
    // top_k, repetition_penalty, and no_repeat_ngram are available). So we keep
    // repetitionPenalty 1.08 in lieu of the vendor's presence-penalty pairing
    // rather than dropping to 1.0 and risking loops with no presence guard.
    // top_p is held at 0.8 (the vendor non-thinking ceiling) on no-regression
    // evidence — NOT as a CJK fix. We tried it as the fix: a real-WebGPU A/B on
    // 2026-06-11 (runs wave25-cjk-fix-r1/r2, full 19-probe battery, 0 errors)
    // tested whether 0.95 → 0.8 removes the reproducible s1 CJK leak (probe s1
    // emitted "甲烷" — methane). Result: the leak is NOT fixed by sampling — it
    // recurred at 0.8 (r2 leaked the SAME token in the SAME slot; 1/2 post-change
    // vs 2/2 pre-change, n too small to claim even a reduction). The token is
    // HIGH-probability in that slot for this multilingual model (a translation of
    // "methane", not tail noise), so no top_p/tail tweak deterministically removes
    // it. We keep 0.8 anyway because the A/B showed no quality regression at it
    // (strict sentinels if1/if2/st1 clean both runs; richness 303–364 words;
    // honesty u1/u2 intact) and it matches the vendor rec. temperature stays 0.6
    // — the measured bake-off value. The real fix is `suppressCjkTokens` below:
    // deterministic logits-level CJK suppression for non-CJK conversations
    // (runtime/cjk-suppression.ts).
    temperature: 0.6,
    topP: 0.8,
    topK: 20,
    repetitionPenalty: 1.08,
    intentOverrides: {
      quick: { temperature: 0.32, topP: 0.78, repetitionPenalty: 1.06 },
      explain: { temperature: 0.42, topP: 0.8, repetitionPenalty: 1.06 },
      writing: { temperature: 0.48, topP: 0.8, repetitionPenalty: 1.09, noRepeatNgramSize: 4 },
      code: { temperature: 0.2, topP: 0.8 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
  // Measured CJK leak class (s1 "甲烷" 2/2, sampling fix refuted) — the
  // deterministic suppression is the fix. QWEN_GEN (Qwen3 gen) shares the
  // multilingual-vocab risk but has no measured leak; it can adopt the flag
  // after its own gated run.
  suppressCjkTokens: true,
};

const LFM25_350M_GEN: GenerationProfileSlice = {
  generationDefaults: {
    temperature: 0.45,
    topP: 0.86,
    topK: 30,
    repetitionPenalty: 1.08,
    // 350M model is extremely loop-prone; base n-gram guard prevents runaway repetition.
    // No authoritative sampling recs from Liquid AI; generation_config.json has no sampling params.
    noRepeatNgramSize: 3,
    intentOverrides: {
      quick: { temperature: 0.25, topP: 0.78, repetitionPenalty: 1.06 },
      writing: { temperature: 0.38, topP: 0.82, repetitionPenalty: 1.1, noRepeatNgramSize: 4 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
};

const LFM25_1_2B_GEN: GenerationProfileSlice = {
  generationDefaults: {
    // LFM2 instruct: low-temp factual bias, per Liquid's published recs (temp 0.3, rep 1.05).
    // NO noRepeatNgramSize here: TJS bans n-grams across the FULL sequence INCLUDING the
    // prompt, so a 3-gram guard forbids restating tool results, entities, or any phrase from
    // earlier turns — the proven cause of corrupted numbers/words ("332,026", "Nobel Award",
    // "capital ofFrance"; proven by the chat-experience quality audit).
    // repetitionPenalty alone is the loop guard for this instruction-tuned model.
    temperature: 0.3,
    topP: 0.9,
    topK: 40,
    repetitionPenalty: 1.05,
    intentOverrides: {
      quick: { temperature: 0.2, topP: 0.8 },
      explain: { temperature: 0.3, topP: 0.88 },
      writing: { temperature: 0.4, topP: 0.9, repetitionPenalty: 1.08 },
      code: { temperature: 0.2, topP: 0.85 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
};

const PHI3_MINI_GEN: GenerationProfileSlice = {
  generationDefaults: {
    // Phi-3 model card recommends temp 0.0 (greedy); we use 0.45 for chat variety.
    // Bumped repetition_penalty from 1.04 → 1.1 to compensate for sampling divergence.
    temperature: 0.45,
    topP: 0.9,
    repetitionPenalty: 1.1,
    intentOverrides: {
      quick: { temperature: 0.2, topP: 0.72, repetitionPenalty: 1.1 },
      explain: { temperature: 0.38, topP: 0.88 },
      writing: { temperature: 0.44, topP: 0.88, repetitionPenalty: 1.1, noRepeatNgramSize: 4 },
      code: { temperature: 0.18, topP: 0.82 },
    },
  },
  contextBudget: {
    ...DEFAULT_CONTEXT_BUDGET,
  },
};

const SMOLLM2_WEBLLM_GEN: GenerationProfileSlice = {
  generationDefaults: {
    temperature: 0.45,
    topP: 0.9,
    topK: 40,
    repetitionPenalty: 1.04,
    intentOverrides: {
      quick: { temperature: 0.28, topP: 0.84 },
      explain: { temperature: 0.38, topP: 0.88 },
      writing: { temperature: 0.44, topP: 0.88, repetitionPenalty: 1.06, noRepeatNgramSize: 4 },
      code: { temperature: 0.18, topP: 0.82 },
    },
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET,
};

function bonsaiGenerationProfile(quantization: "q1" | "q2" | "q4" | "q8"): GenerationProfileSlice {
  const q1 = quantization === "q1";
  const q8 = quantization === "q8";
  const intentTokens = q8
    ? {
      quick: 256,
      explain: 384,
      deep: 512,
      code: 512,
      writing: 512,
      file: 512,
      research: 512,
    }
    : {
      quick: 256,
      explain: 512,
      deep: 768,
      code: 512,
      writing: 512,
      file: 768,
      research: 768,
    };
  return {
    generationDefaults: {
      // Bonsai generation_config.json: temp 0.5, topP 0.85, topK 20, rep_penalty 1.0.
      // Not instruction-tuned — very loop-prone at small quant levels.
      // Added base noRepeatNgramSize: 3 for all quants to guard against repetition loops.
      temperature: q1 ? 0.45 : q8 ? 0.42 : 0.5,
      topP: q1 ? 0.82 : q8 ? 0.78 : 0.85,
      topK: 20,
      repetitionPenalty: q1 ? 1.06 : q8 ? 1.08 : 1.06,
      noRepeatNgramSize: q8 ? 4 : 3,
      intentOverrides: {
        quick: { temperature: 0.3, topP: 0.78, topK: 20 },
        explain: q8
          ? { temperature: 0.32, topP: 0.72, topK: 20, repetitionPenalty: 1.12, noRepeatNgramSize: 4 }
          : { temperature: 0.38, topP: 0.8, topK: 20 },
        writing: q8
          ? { temperature: 0.28, topP: 0.7, topK: 20, repetitionPenalty: 1.12, noRepeatNgramSize: 4 }
          : { temperature: 0.35, topP: 0.8, topK: 20, repetitionPenalty: 1.07, noRepeatNgramSize: 4 },
        code: { temperature: 0.2, topP: 0.8, topK: 20 },
      },
    },
    contextBudget: {
      default: 768,
      max: 4096,
      intentTokens,
    },
  };
}

const GEMMA4_GEN: GenerationProfileSlice = {
  generationDefaults: {
    // Gemma 4 generation_config.json ships temp 1.0 / top_k 64 / top_p 0.95.
    // Full temp 1.0 is too hot for Eco's intent-routed factual asks; we keep the
    // vendor's top_k/top_p anchors and scale temperature to the house intent
    // pattern (cf. PHI3_MINI_GEN). NO noRepeatNgramSize — TJS bans n-grams
    // across the prompt too (see LFM25_1_2B_GEN note / chat-experience audit).
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

// ─── Lookup maps ──────────────────────────────────────────────────────────

const PROFILE_BY_MODEL_ID: Record<string, GenerationProfileSlice> = {
  "local/bonsai-1.7b-q4": bonsaiGenerationProfile("q4"),
  "local/smollm2-1.7b-webllm-q4f16": SMOLLM2_WEBLLM_GEN,
  "local/phi3-mini-4k-q4f16": PHI3_MINI_GEN,
  "local/qwen3-0.6b": QWEN_GEN,
  "candidate/lfm2.5-350m-onnx": LFM25_350M_GEN,
  // Fast / low-memory fallback: graduated from the eval lane into the catalog,
  // now intentionally behind Qwen3.5-2B for everyday/default selection.
  "candidate/lfm2.5-1.2b-instruct-onnx": LFM25_1_2B_GEN,
  // Shipping smart pick (chat #7, graduated 2026-06-11). Moved off the shared
  // QWEN_GEN slice onto the dedicated QWEN35_GEN: the winning bake-off run
  // (`eval-mq8s89xp-1xeys0c7`) surfaced a reproducible CJK token leak (s1 "甲烷"
  // 2/2), and the Qwen3.5 family's own non-thinking rec narrows top_p to 0.8 —
  // QWEN35_GEN applies that tail-narrowing as the fix (see its in-code note).
  "candidate/qwen3.5-2b-onnx": QWEN35_GEN,
  // Phase-2 eval candidates (dev-only lane; not in the shipping catalog).
  "candidate/qwen3-1.7b-onnx": QWEN_GEN,
  "candidate/lfm2-2.6b-onnx": LFM25_1_2B_GEN,
  // Chat #7 M2 bake-off candidates (dev-only lane). The qwen3.5-4b shares the
  // Qwen3.5 family rec, so it rides the same QWEN35_GEN slice as the shipping 2B
  // (top_p 0.8 tail-narrowing). Gemma 4 gets its own vendor-anchored slice.
  "candidate/qwen3.5-4b-onnx": QWEN35_GEN,
  "candidate/gemma-4-e2b-onnx": GEMMA4_GEN,
  // Community QAT-q4 Gemma 4 E2B (nico-martin) — same vendor-anchored Gemma slice.
  "candidate/gemma-4-e2b-qat-q4-onnx": GEMMA4_GEN,
  // Gemma 4 via LiteRT-LM Web runtime — runtime-specific slice because LiteRT
  // cannot honor repetition/no-repeat-ngram controls from the generic Gemma
  // profile, and concise product-path testing needs tighter caps. These remain
  // eval-only validation candidates, not shipping catalog/default entries.
  "candidate/gemma-4-e2b-litert": GEMMA4_LITERT_GEN,
  "candidate/gemma-4-e4b-litert": GEMMA4_LITERT_GEN,
};

const FAMILY_FALLBACK: Record<LocalModelFamily, GenerationProfileSlice> = {
  qwen3: QWEN_GEN,
  qwen3_5: QWEN35_GEN,
  smollm2: SMOLLM2_WEBLLM_GEN,
  phi: PHI3_MINI_GEN,
  lfm2: LFM25_350M_GEN,
  bonsai: bonsaiGenerationProfile("q4"),
};

// ─── Profile lookup ───────────────────────────────────────────────────────

function getGenerationProfileSlice(
  model: ChatIntentModelSlice | null | undefined,
): GenerationProfileSlice | null {
  if (!model) return null;
  return PROFILE_BY_MODEL_ID[model.id] ?? FAMILY_FALLBACK[model.family] ?? null;
}

// ─── Public accessors (same semantics as local-model-optimization.ts) ─────

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
 * family, and every catalog + eval-lane model has an explicit
 * PROFILE_BY_MODEL_ID row (the invariant test pins that), so the family
 * fallback would never legitimately fire here.
 */
export function isCjkSuppressionEnabled(modelId: string): boolean {
  return PROFILE_BY_MODEL_ID[modelId]?.suppressCjkTokens === true;
}

/**
 * Test-only export — list of profile-covered catalog IDs. Underscore prefix
 * marks it as not for runtime consumers.
 */
export const __profileModelIds = Object.keys(PROFILE_BY_MODEL_ID);
