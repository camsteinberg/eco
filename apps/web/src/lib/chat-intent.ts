// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getCatalog } from "../local-ai/catalog/catalog";
import {
  DEEP_RE,
  LONG_FORM_RE,
  hasExplicitFormatInstruction,
  inferAnswerShape,
  isSocialTurn,
  type AnswerShape,
} from "./answer-shape";
import {
  getLocalModelContextBudget,
  getLocalModelGenerationDefaults,
  type ChatIntentModelSlice,
} from "./local-model-generation-profiles";

export type ChatIntent =
  | "quick"
  | "explain"
  | "deep"
  | "code"
  | "writing"
  | "file"
  | "research";

export type GenerationProfile = {
  temperature: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  noRepeatNgramSize?: number;
};

type LocalGenerationProfileOptions = {
  allowValidationModel?: boolean;
};

const GEMMA4_LITERT_MODEL_IDS = new Set([
  "candidate/gemma-4-e2b-litert",
  "candidate/gemma-4-e4b-litert",
]);

function isGemma4LiteRtModel(modelId: string | undefined): boolean {
  return modelId != null && GEMMA4_LITERT_MODEL_IDS.has(modelId);
}

// ─── Model metadata for generation profiles ──────────────────────────────
//
// The generation-profile path needs family, qualityTier, maxNewTokens, and
// generationDefaults — fields that live on the legacy LocalModelConfig but
// not on the v1 ModelConfig. This inline map provides the exact values that
// the legacy catalog carried for each v1 model.

const CHAT_INTENT_MODEL_DATA: Record<string, ChatIntentModelSlice> = {
  "local/qwen3-0.6b": {
    id: "local/qwen3-0.6b",
    family: "qwen3",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 512 },
    generationDefaults: {
      topP: 0.95,
      topK: 20,
      repetitionPenalty: 1.08,
      intentOverrides: {
        writing: { topP: 0.92 },
      },
    },
  },
  "local/phi3-mini-4k-q4f16": {
    id: "local/phi3-mini-4k-q4f16",
    family: "phi",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 1024 },
  },
  "candidate/lfm2.5-1.2b-instruct-onnx": {
    id: "candidate/lfm2.5-1.2b-instruct-onnx",
    family: "lfm2",
    qualityTier: "fast",
    // Default model. 2048 (chat #7) so explain/deep/code get their designed
    // per-intent budgets instead of being flattened to 1024; the headroom
    // clamp in useChat keeps long conversations from tripping the
    // context-safety refusal. EOS ends normal replies well before the cap.
    maxNewTokens: { webgpu: 2048 },
  },
  "candidate/lfm2.5-350m-onnx": {
    id: "candidate/lfm2.5-350m-onnx",
    family: "lfm2",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 384 },
  },
  // Shipping smart pick (chat #7, graduated 2026-06-11). 2048 webgpu ceiling
  // — depth is what this model graduated FOR (339-word open-ask floor in the
  // bake-off); clamping to the legacy smart-tier 1024 would flatten the
  // designed deep/code budgets exactly like the pre-Wave-1 default did. The
  // per-intent contextBudget still shapes quick/explain below the ceiling,
  // and useChat's context-headroom clamp guards long conversations.
  "candidate/qwen3.5-2b-onnx": {
    id: "candidate/qwen3.5-2b-onnx",
    family: "qwen3_5",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  },
  // ─── Lab / validation-harness models (not in v1 catalog) ─────────────
  // These entries exist so allowValidationModel: true resolves generation
  // profiles during benchmark and eval harness runs. Their family strings
  // (smollm3, bitnet) are outside the v1 LocalModelFamily union,
  // so they cast to ChatIntentModelSlice — runtime profile lookup falls
  // through to the baseline budgets, which is the intended behavior.
  //
  // The remaining Phase-2 eval candidate (qwen3 family) IS in the
  // LocalModelFamily union, so it is a plain typed entry (no cast).
  "candidate/qwen3-1.7b-onnx": {
    id: "candidate/qwen3-1.7b-onnx",
    family: "qwen3",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 512 },
    generationDefaults: {
      topP: 0.95,
      topK: 20,
      repetitionPenalty: 1.08,
    },
  },
  // A-3 load-peak cell (2026-07-16): the shipping Qwen3-0.6B in the fp32-initializer
  // q4 build. Same qwen3 family / fast tier / sampling as local/qwen3-0.6b so the
  // measurement runs the real generation profile, not the baseline fallback.
  "candidate/qwen3-0.6b-q4": {
    id: "candidate/qwen3-0.6b-q4",
    family: "qwen3",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 512 },
    generationDefaults: {
      topP: 0.95,
      topK: 20,
      repetitionPenalty: 1.08,
      intentOverrides: {
        writing: { topP: 0.92 },
      },
    },
  },
  // A-3 single-file baseline (retained at the 2026-07-17 external-data
  // graduation): the pre-graduation single-file q4f16 build — identical sampling
  // to local/qwen3-0.6b so the paired A/B measurement cells run the real profile.
  "candidate/qwen3-0.6b-q4f16-single": {
    id: "candidate/qwen3-0.6b-q4f16-single",
    family: "qwen3",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 512 },
    generationDefaults: {
      topP: 0.95,
      topK: 20,
      repetitionPenalty: 1.08,
      intentOverrides: {
        writing: { topP: 0.92 },
      },
    },
  },
  // Smart-tier eval candidate (#4 Phase 2 follow-up); lfm2 family is in the union.
  "candidate/lfm2-2.6b-onnx": {
    id: "candidate/lfm2-2.6b-onnx",
    family: "lfm2",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 1024 },
  },
  // ─── Chat #7 M2 bake-off candidates (2026-06-10, dev-only lane) ───────
  // The gemma4 family is outside the v1 LocalModelFamily union, so that entry
  // casts to ChatIntentModelSlice (same pattern as smollm3/bitnet above);
  // sampling resolves via id-keyed PROFILE_BY_MODEL_ID entries in
  // local-model-generation-profiles.ts, never the family fallback.
  // (qwen3_5 joined the union when Qwen3.5-2B graduated, so the 4B is a
  // plain typed entry.)
  "candidate/qwen3.5-4b-onnx": {
    id: "candidate/qwen3.5-4b-onnx",
    family: "qwen3_5",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 1024 },
  },
  // 2048 webgpu ceiling for both Gemma bake-off entries: the smart-tier incumbent
  // Qwen3.5-2B has a 2048 ceiling, so the Gemma candidates get the same ceiling for
  // a fair depth/richness comparison (1024 vs 2048 could otherwise cap Gemma's
  // answers below the incumbent's).
  "candidate/gemma-4-e2b-onnx": {
    id: "candidate/gemma-4-e2b-onnx",
    family: "gemma4",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  } as unknown as ChatIntentModelSlice,
  "candidate/gemma-4-e2b-qat-q4-onnx": {
    id: "candidate/gemma-4-e2b-qat-q4-onnx",
    family: "gemma4",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  } as unknown as ChatIntentModelSlice,
  // Gemma 4 via LiteRT-LM Web — same 2048 ceiling as the smart-tier
  // incumbent Qwen3.5-2B for a fair depth/richness comparison. Eval-only;
  // not shipping catalog/default entries.
  "candidate/gemma-4-e2b-litert": {
    id: "candidate/gemma-4-e2b-litert",
    family: "gemma4",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  } as unknown as ChatIntentModelSlice,
  "candidate/gemma-4-e4b-litert": {
    id: "candidate/gemma-4-e4b-litert",
    family: "gemma4",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  } as unknown as ChatIntentModelSlice,
  "local/smollm3-3b": {
    id: "local/smollm3-3b",
    family: "smollm3",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 1024 },
  } as unknown as ChatIntentModelSlice,
  "local/bonsai-1.7b-q1": {
    id: "local/bonsai-1.7b-q1",
    family: "bonsai",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 1024 },
    generationDefaults: {
      topP: 0.92,
      topK: 40,
      repetitionPenalty: 1.05,
      intentOverrides: {
        writing: { topP: 0.92 },
      },
    },
  },
  "local/bonsai-1.7b-q2": {
    id: "local/bonsai-1.7b-q2",
    family: "bonsai",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 1024 },
    generationDefaults: {
      topP: 0.92,
      topK: 40,
      repetitionPenalty: 1.05,
      intentOverrides: {
        writing: { topP: 0.92 },
      },
    },
  },
  "local/bonsai-1.7b-q8": {
    id: "local/bonsai-1.7b-q8",
    family: "bonsai",
    qualityTier: "fast",
    maxNewTokens: { webgpu: 1024 },
    generationDefaults: {
      topP: 0.92,
      topK: 40,
      repetitionPenalty: 1.05,
      intentOverrides: {
        writing: { topP: 0.92 },
      },
    },
  },
  "candidate/bitnet-b158": {
    id: "candidate/bitnet-b158",
    family: "bitnet",
    qualityTier: "experimental",
    maxNewTokens: { webgpu: 1024 },
  } as unknown as ChatIntentModelSlice,
};

function getChatIntentModel(modelId: string): ChatIntentModelSlice | undefined {
  return CHAT_INTENT_MODEL_DATA[modelId];
}

// ─── v1 catalog model ID set (replaces getRoutableLocalModels) ───────────

let _catalogIds: Set<string> | null = null;
function getCatalogIds(): Set<string> {
  if (!_catalogIds) {
    _catalogIds = new Set(getCatalog().map((m) => m.id));
  }
  return _catalogIds;
}

// ─── Intent inference ────────────────────────────────────────────────────

const CODE_RE = /```|\b(debug|bug|stack trace|typescript|javascript|python|react|sql|function|component|api|test|refactor)\b/i;
const WRITING_RE = /\b(write|rewrite|draft|tone|copy|email|essay|story|post|message|headline|summarize in my voice|recipe|cook|bake|meal plan|ingredients?)\b/i;
const RESEARCH_RE = /\b(research|sources|cite|latest|current|news|202[5-9]|up-to-date)\b/i;

/**
 * Map an answer shape to the depth-family intent that delivers its treatment.
 * teaching → deep (2048 + the strongest scaffold); brief/social → quick (low
 * temp, 1024, no scaffold — social additionally suppresses the per-turn hint
 * in buildHintedUserTurn); focused/uncertain → explain (the developed middle —
 * per the locked asymmetric-cost policy, uncertainty never lectures).
 */
function mapShapeToDepthIntent(shape: AnswerShape): ChatIntent {
  if (shape === "teaching") return "deep";
  if (shape === "brief" || shape === "social") return "quick";
  return "explain";
}

export type InferChatIntentOptions = {
  hasFiles?: boolean;
  researchMode?: boolean;
  /** Whether earlier conversation turns precede this one (shape context). */
  hasPriorTurns?: boolean;
};

/**
 * Task-class cascade + answer-shape depth arbitration (Wave 2.6 Stage 1).
 *
 * Task classes (research/file/code/writing) and the explicit depth words
 * (LONG_FORM_RE/DEEP_RE) keep their exact pre-Stage-1 precedence — explicit
 * asks behave byte-identically. The shape classifier replaces ONLY the old
 * EXPLAIN_RE + length catch-all, which Stage 0 measured at a 68% misroute
 * rate (teaching-shaped asks never reached deep; single facts rode the
 * explain padding register). See lib/answer-shape.ts for the signal set and
 * the Stage-0 shape-routing measurements for the evidence.
 */
export function inferChatIntent(content: string, options?: InferChatIntentOptions): ChatIntent {
  const text = content.trim();

  if (options?.researchMode || RESEARCH_RE.test(text)) return "research";
  if (options?.hasFiles || /<file\b/i.test(text)) return "file";
  if (CODE_RE.test(text)) return "code";
  if (LONG_FORM_RE.test(text)) return "deep";
  if (DEEP_RE.test(text)) return "deep";
  if (WRITING_RE.test(text)) return "writing";
  return mapShapeToDepthIntent(
    inferAnswerShape(text, { hasPriorTurns: options?.hasPriorTurns ?? false }),
  );
}

function getLocalMaxTokens(
  intent: ChatIntent,
  modelId?: string,
  options: LocalGenerationProfileOptions = {},
): number {
  const baseline = {
    quick: 1024,
    explain: 1536,
    deep: 2048,
    code: 2048,
    writing: 1536,
    file: 2048,
    research: 2048,
  } satisfies Record<ChatIntent, number>;

  const model = getInstructionModelWithOptions(modelId, options);
  const modelWebGpuLimit = model?.maxNewTokens.webgpu ?? 2048;
  const modelBudget = getLocalModelContextBudget(model, intent as ChatIntent);
  if (typeof modelBudget === "number" && Number.isFinite(modelBudget)) {
    return Math.min(modelBudget, modelWebGpuLimit);
  }

  if (model?.qualityTier === "smart") {
    const smartBudget = {
      quick: 1024,
      explain: 1536,
      deep: 2048,
      code: 2048,
      writing: 1536,
      file: 2048,
      research: 2048,
    } satisfies Record<ChatIntent, number>;
    return Math.min(smartBudget[intent], modelWebGpuLimit);
  }

  return Math.min(baseline[intent], modelWebGpuLimit);
}

/**
 * Check whether a model is in the v1 catalog (replaces the legacy
 * getRoutableLocalModels + getSettingsOptInDownloadableLocalModels check).
 */
function isCatalogModel(modelId: string): boolean {
  return getCatalogIds().has(modelId);
}

function getInstructionModelWithOptions(
  modelId: string | undefined,
  options: LocalGenerationProfileOptions = {},
): ChatIntentModelSlice | undefined {
  if (!modelId) return undefined;
  // Benchmark/validation harnesses opt in to all known models.
  if (options.allowValidationModel) {
    return getChatIntentModel(modelId);
  }
  // Production path: only v1 catalog models get model-specific generation
  // profiles. Non-catalog models fail closed to the baseline profile.
  if (isCatalogModel(modelId)) {
    return getChatIntentModel(modelId);
  }
  return undefined;
}

export function getGenerationProfile(
  intent: ChatIntent,
  isLocal: boolean,
  modelId?: string,
  options: LocalGenerationProfileOptions = {},
): GenerationProfile {
  const networkMaxTokens = {
    quick: 700,
    explain: 1200,
    deep: 1800,
    code: 1800,
    writing: 1400,
    file: 1800,
    research: 2200,
  } satisfies Record<ChatIntent, number>;

  const temperature = {
    quick: 0.45,
    explain: 0.55,
    deep: 0.55,
    code: 0.25,
    writing: 0.75,
    file: 0.4,
    research: 0.35,
  } satisfies Record<ChatIntent, number>;

  const profile: GenerationProfile = {
    temperature: temperature[intent],
    maxTokens: isLocal ? getLocalMaxTokens(intent, modelId, options) : networkMaxTokens[intent],
  };

  if (!isLocal) return profile;

  return {
    ...profile,
    ...getModelGenerationProfileWithOptions(intent, modelId, options),
  };
}

function getModelGenerationProfileWithOptions(
  intent: ChatIntent,
  modelId: string | undefined,
  options: LocalGenerationProfileOptions,
): Partial<GenerationProfile> {
  const model = getInstructionModelWithOptions(modelId, options);
  if (!model) return {};
  const defaults = getLocalModelGenerationDefaults(model, intent as ChatIntent);
  if (Object.keys(defaults).length === 0) {
    return {
      topP: 0.9,
      repetitionPenalty: 1.06,
    };
  }

  return {
    ...(defaults.temperature != null && { temperature: defaults.temperature }),
    ...(defaults.topP != null && { topP: defaults.topP }),
    ...(defaults.topK != null && { topK: defaults.topK }),
    ...(defaults.repetitionPenalty != null && {
      repetitionPenalty: defaults.repetitionPenalty,
    }),
    ...(defaults.noRepeatNgramSize != null && {
      noRepeatNgramSize: defaults.noRepeatNgramSize,
    }),
  };
}

/**
 * Returns a tight per-intent style hint. Intentionally minimal — the system
 * prompt is the single source of truth; turn-level scaffolding leaks as content
 * on sub-2B models (see feedback_tiny_model_system_prompts.md).
 */
export function buildTurnQualityInstruction(
  intent: ChatIntent,
  isLocal: boolean,
  modelId?: string,
  _options: LocalGenerationProfileOptions = {},
): string {
  if (isLocal && isGemma4LiteRtModel(modelId)) {
    const gemmaLiteRt: Partial<Record<ChatIntent, string>> = {
      quick:
        "Answer directly and briefly. For a single factual question, give the answer first and stop. For a short follow-up, make only the requested change.",
      explain:
        "Lead with the direct answer, then cover the essential details in at most three concise paragraphs or bullets. Stop when the distinction is clear.",
      deep:
        "Use at most three short sections with two bullets each. Give concrete steps and a brief why for each. Finish with one short takeaway.",
    };
    const compact = gemmaLiteRt[intent];
    if (compact) return compact;
  }

  const perIntent: Record<ChatIntent, string> = {
    quick: "",
    // NOTE (chat #7): no brevity clause here — a 1.2B can't scope conditionals
    // ("single-fact questions stay brief" compressed ALL explain turns in live
    // probes). The system prompt's depth-matching clause arbitrates brevity.
    explain: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications.",
    deep: "Use clear sections; include concrete recommendations and tradeoffs.",
    code: "Lead with the working code or fix; keep the explanation short.",
    writing: "Match the requested format and tone; avoid filler.",
    file: "Lead with the conclusion; cite specifics from the file.",
    research: "Distinguish supported claims from uncertain ones; cite sources only when you can back the claim.",
  };
  return perIntent[intent];
}

/**
 * LEGACY system-front composition: "base system prompt + per-intent hint"
 * joined into the system message. This was production until Wave 2.6 Stage 1;
 * the Stage-0 placement A/B measured it recovering only 9% (LFM) / 29% (Qwen)
 * of the explicit-phrasing delta vs 35% / 68% for the user-turn placement —
 * AND it rewrote the prompt FRONT on every intent change, defeating
 * strict-prefix KV reuse (#151 front-of-prompt variance).
 *
 * Production now places hints at the end of the user turn (see
 * `buildHintedUserTurn` / `applyTurnHints`). This function remains ONLY as
 * the eval harness's `hintPlacement: 'system'` research composition (the
 * counterfactual arm) — do not reintroduce it on the dispatch path.
 */
export function composeQualitySystemPrompt(
  baseSystemPrompt: string,
  intent: ChatIntent,
  isLocal: boolean,
  modelId?: string,
): string {
  return [baseSystemPrompt, buildTurnQualityInstruction(intent, isLocal, modelId)].join("\n\n");
}

// ─── User-turn hint placement (Wave 2.6 Stage 1) ──────────────────────────
//
// Hints ride the END of the user turn, not the system front. Measured double
// win (Stage 0): stronger conditioning on both models (the 1.2B produces the
// sectioned premium structure it ignores in the system front) AND a stable
// prompt front across intent changes — strict-prefix KV reuse holds (#151).
//
// KV CONTRACT: the hint enters the model's cached sequence as part of the
// user turn, so every later history re-render MUST reproduce it byte-
// identically or the prefix breaks at that turn (the exact miss class the
// Qwen think-block asymmetry caused — see PR #151). `applyTurnHints` re-
// derives each user turn's hint deterministically from that turn's own text
// and position, so a past turn always re-renders exactly as it was sent.

export type ChatTurnMessage = { role: "user" | "assistant" | "system"; content: string };

/**
 * Append the per-intent hint to one user turn (no-op for empty hints).
 *
 * SUPPRESSED in two turn-text-only cases (both preserve the KV re-render
 * contract — the decision derives purely from the turn's own bytes):
 *   1. an explicit format/length instruction — the hint sits AFTER the user's
 *      words, so on a small model it wins by recency (measured breaking
 *      "answer in exactly one sentence" into six; wave26-stage1-gates if3/LFM).
 *      The user's instruction is inviolable; the hint always yields.
 *   2. a purely social turn (greeting/thanks/ack/farewell) — no task exists to
 *      apply an instruction to, so any hint is nonsense. On Gemma-LiteRT the
 *      non-empty quick hint made the model parrot the instruction on "Hello"
 *      (root cause #1, prompt-persona-quality-pass-2026-07-03). Suppressed for
 *      EVERY model.
 */
export function buildHintedUserTurn(
  content: string,
  intent: ChatIntent,
  isLocal: boolean,
  modelId?: string,
): string {
  if (hasExplicitFormatInstruction(content) || isSocialTurn(content)) return content;
  const hint = buildTurnQualityInstruction(intent, isLocal, modelId);
  return hint.length > 0 ? `${content}\n\n${hint}` : content;
}

/**
 * Deterministically re-derive the intent of ONE turn from its own text and
 * position — the single inference rule used at dispatch time AND on every
 * history re-render (KV contract above). `hasFiles` comes from the turn's
 * own content; research mode is retired in web v1.0.
 */
export function inferTurnIntent(content: string, hasPriorTurns: boolean): ChatIntent {
  return inferChatIntent(content, {
    hasFiles: content.includes("<file"),
    researchMode: false,
    hasPriorTurns,
  });
}

/**
 * Map every USER turn in a message list through `buildHintedUserTurn`,
 * re-deriving each turn's intent via `inferTurnIntent`. Assistant/system
 * turns pass through untouched. Pure — shared by useChat (dispatch) and the
 * eval harness (probe history), so the rendered bytes can never drift.
 */
export function applyTurnHints(
  messages: readonly ChatTurnMessage[],
  isLocal: boolean,
  modelId?: string,
): ChatTurnMessage[] {
  return messages.map((message, index) => {
    if (message.role !== "user") return message;
    const intent = inferTurnIntent(message.content, index > 0);
    const hinted = buildHintedUserTurn(message.content, intent, isLocal, modelId);
    return hinted === message.content ? message : { ...message, content: hinted };
  });
}
