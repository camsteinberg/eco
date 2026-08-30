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
  | 'qwen3' | 'qwen3_5' | 'bonsai' | 'lfm2';

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
//
// ★ NO `noRepeatNgramSize` ON `writing`. Transformers.js applies the n-gram ban
// across the FULL sequence, prompt included — verified by instantiating the real
// `NoRepeatNGramLogitsProcessor` from the pinned 4.2.0 package and calling it at
// generation step 0 with prompt tokens only, which returned -Infinity for the
// offending token. With n=4 the model can copy at most three consecutive tokens
// of the user's own text before the fourth is hard-banned, at every position.
//
// `writing` is the intent that fires when someone pastes their own words and asks
// for them back changed — "fix the spelling but don't change my voice", "make this
// shorter", "put this in a table". Banning reuse of the user's phrasing on exactly
// those turns is backwards, and the visible result is the corruption class an
// earlier quality audit recorded: mangled figures and run-together words.
//
// This was already understood: LFM25_1_2B_GEN and GEMMA4_GEN each refuse the guard
// with a comment naming this hazard. A 2026-06-09 fix removed it from one model's
// BASE setting and missed every per-intent override, so it survived here for seven
// weeks. `repetitionPenalty` remains the loop guard on these instruction-tuned
// models.
//
// The 350M starter was the last holdout, and its ban came off at both layers once a
// real-model A/B settled the question — see LFM25_350M_GEN. Bonsai still bans: it is
// not instruction-tuned, and it is an eval-lane seam rather than a catalog model.

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
      writing: { temperature: 0.48, topP: 0.8, repetitionPenalty: 1.09 },
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
    // No authoritative sampling recs from Liquid AI; generation_config.json has no
    // sampling params.
    //
    // ★ NO `noRepeatNgramSize`, base or per-intent. The A/B this profile used to ask
    // for ran against the real loaded model (n=10, 490 generations per arm): dropping
    // the ban moved `preservesUserText` well past the pre-registered bar, and the
    // feared runaway repetition never appeared — the measured cost was two replies
    // that repeated a bullet header, a mild templated tic rather than a loop.
    //
    // It had to come off at BOTH layers. The `writing` override carried its own n=4,
    // and `writing` is the intent that fires when someone pastes their own words and
    // asks for them back changed — leaving it would have kept the ban exactly where
    // it does the most harm. That is also what the arm measured: it drops the
    // RESOLVED value, so no intent kept a ban.
    //
    // `repetitionPenalty` is the loop guard, as on every other profile here.
    temperature: 0.45,
    topP: 0.86,
    topK: 30,
    repetitionPenalty: 1.08,
    intentOverrides: {
      quick: { temperature: 0.25, topP: 0.78, repetitionPenalty: 1.06 },
      writing: { temperature: 0.38, topP: 0.82, repetitionPenalty: 1.1 },
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
    // pattern (cf. QWEN35_GEN). NO noRepeatNgramSize — TJS bans n-grams
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
  // Bonsai q4 retired from the catalog 2026-07-11; its profile lives on via
  // `bonsaiGenerationProfile` + `FAMILY_FALLBACK.bonsai` for the eval-lane
  // q1/q2/q8 dev seams (see chat-intent.ts), so no PROFILE_BY_MODEL_ID row.
  "local/qwen3-0.6b": QWEN_GEN,
  "candidate/lfm2.5-350m-onnx": LFM25_350M_GEN,
  // Fast / low-memory fallback: graduated from the eval lane into the catalog,
  // now intentionally behind Qwen3.5-2B for everyday/default selection.
  "candidate/lfm2.5-1.2b-instruct-onnx": LFM25_1_2B_GEN,
  // The f16-less plain-int4 (onnx-q4) build of the SAME 1.2B (PR #137) — shares its
  // q4f16 sibling's generation slice. (Was missing here, silently falling through to
  // the lfm2 family fallback = the 350M's slice; restored to the correct 1.2B slice.)
  "candidate/lfm2.5-1.2b-instruct-q4-onnx": LFM25_1_2B_GEN,
  // Shipping smart pick (chat #7, graduated 2026-06-11). Moved off the shared
  // QWEN_GEN slice onto the dedicated QWEN35_GEN: the winning bake-off run
  // (`eval-mq8s89xp-1xeys0c7`) surfaced a reproducible CJK token leak (s1 "甲烷"
  // 2/2), and the Qwen3.5 family's own non-thinking rec narrows top_p to 0.8 —
  // QWEN35_GEN applies that tail-narrowing as the fix (see its in-code note).
  "candidate/qwen3.5-2b-onnx": QWEN35_GEN,
  // Shipping deeper/eco-smart pick (graduated 2026-08-10). Shares the LFM2-family
  // sampling with the 1.2B fast default (LFM25_1_2B_GEN).
  "candidate/lfm2-2.6b-onnx": LFM25_1_2B_GEN,
  // Phase-2 eval candidates (dev-only lane; not in the shipping catalog).
  "candidate/qwen3-1.7b-onnx": QWEN_GEN,
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
  // WebKit-mobile pick (Qwen2.5-0.5B via WebLLM/MLC). A small Qwen instruct model,
  // so it rides the shared generic Qwen slice (same as qwen3-0.6b) — deliberately
  // NOT QWEN35_GEN, which carries the Qwen3.5-family-only CJK-token suppression.
  "candidate/qwen2.5-0.5b-mlc": QWEN_GEN,
  // Runtime bake-off cell: Qwen3-0.6B on MLC — same qwen3 family as local/qwen3-0.6b,
  // so it rides the same generic Qwen slice. NOT QWEN35_GEN.
  "candidate/qwen3-0.6b-mlc": QWEN_GEN,
  // No-GPU (WASM/CPU-EP) floor models: the lightest int8 SmolLM2 (fast floor) and the
  // deeper q4 Granite. Both are small instruct models with no vendor-specific sampling
  // rec, so they ride the generic small-instruct Qwen slice (moderate temperature plus a
  // repetitionPenalty loop guard a sub-1B model benefits from) — the same slice as the
  // Qwen2.5-0.5B-mlc sibling. NOT QWEN35_GEN (that carries the Qwen3.5-family-only
  // CJK-token suppression). Granite/SmolLM2 are different families but have no
  // vendor-specific sampling rec, so the generic slice is the honest default.
  "candidate/granite-4.0-350m-onnx": QWEN_GEN,
  "candidate/smollm2-360m-instruct-onnx": QWEN_GEN,
  "candidate/gemma-4-e4b-litert": GEMMA4_LITERT_GEN,
};

const FAMILY_FALLBACK: Record<LocalModelFamily, GenerationProfileSlice> = {
  qwen3: QWEN_GEN,
  qwen3_5: QWEN35_GEN,
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
