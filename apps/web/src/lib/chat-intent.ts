// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getCatalog } from "../local-ai/catalog/catalog";
import { instructionParagraph, isTextRepairAsk } from "./ask-text";
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

// WRITING_RE, narrowed 2026-07-27. It was a list of bare words —
// `write|rewrite|draft|tone|copy|email|essay|story|post|message|headline|
// recipe|cook|bake|meal plan|ingredients?` — every one of which is an ordinary
// English word people type without asking anyone to write anything. "how long
// do i cook a 12 pound turkey" and "long story short my landlord kept my
// deposit" were both claimed as drafting tasks, and a pasted `EXPLAIN ANALYZE`
// plan was claimed as correspondence because `\bemail\b` matched inside
// `c.email`.
//
// Three shapes, each generalising past the items that happened to fail:
//   1. tokens that are about text whatever follows them;
//   2. an authoring/editing verb governing an ambiguous text noun;
//   3. `draft` as a verb, licensed only by a text object — so draft beer, a
//      draft under the door and a fantasy-football draft are not writing asks.
// EVERY arm requires a token the previous regex matched bare, so this is a
// STRICT NARROWING: it can only shrink what routes to `writing`. That is not a
// claim in a comment — `lib/__tests__/writing-intent-routing.test.ts` asserts it
// against every committed corpus string, so a future widening that admits a
// genuinely new token fails there by name.
// `(?<!\.)` rejects dot-qualified identifiers (`c.email`, `req.post`,
// `row.message`): a pasted query plan is code, not correspondence.
const WRITING_TEXT_TOKENS =
  "write|rewrite|essay|headline|email|recipe|meal plan|summarize in my voice";
const WRITING_AUTHOR_VERBS =
  "write|writes|writing|wrote|written|re-?write|re-?writes|re-?writing|re-?wrote|re-?written"
  + "|draft|drafts|drafting|drafted|redraft|compose|composes|composing|composed|pen|penned"
  + "|reword|rewords|rewording|reworded|rephrase|rephrases|rephrasing|rephrased"
  + "|edit|edits|editing|edited|revise|revises|revising|revised|proofread|proof read"
  + "|type up|typing up|ghost ?write";
const WRITING_AMBIGUOUS_NOUNS = "email|message|post|story|copy|tone|draft|headline|essay|recipe";
const WRITING_DRAFT_OBJECTS =
  "email|e-mail|message|letter|note|post|reply|response|caption|bio|statement|essay|speech"
  + "|text|paragraph|copy|blurb|memo|announcement|invite|invitation|description|listing"
  + "|profile|summary|toast|eulogy|vows|poem|story|article|headline|resume|cv|obituary"
  + "|newsletter|card|apology|complaint|pitch|proposal|brief|script|comment|review";

// NOTE: `meal plan` is currently UNREACHABLE here — the narrowed DEEP_RE claims
// it one branch earlier (`\b(?:meal|training|…)\s+plans?\b`), so a meal-plan ask
// routes `deep` and never reaches this line. It is kept deliberately, not left
// as dead code: it is the fallback that decides the case if DEEP_RE's modifier
// list is ever narrowed, and a lookup that resolves to nothing today is still
// live policy for whatever stops matching upstream tomorrow.
//
// ASSEMBLED WITH `+`, NOT TEMPLATE INTERPOLATION — deliberate, do not "tidy".
// Written as `` `…(?:${WRITING_TEXT_TOKENS})\\b` `` the production build emits a
// BROKEN pattern: Turbopack's constant folding inlines an interpolated simple
// string const and drops the `)\b` that follows it, producing "Unterminated
// group" at page-data collection. It bit alternatives 1 and 2 (whose parts are
// single literals) and not 3 (whose part is a `+` expression, which is not
// folded). Nothing catches this upstream — type-check, lint and the full unit
// suite all pass, because vitest's transform folds correctly. Only `next build`
// fails.
const WRITING_RE = new RegExp(
  "(?<!\\.)\\b(?:" + WRITING_TEXT_TOKENS + ")\\b"
  + "|(?<!\\.)\\b(?:" + WRITING_AUTHOR_VERBS + ")\\b[^.?!]{0,45}?\\b(?:" + WRITING_AMBIGUOUS_NOUNS + ")\\b"
  + "|(?<!\\.)\\bdraft\\b[^.?!]{0,45}?\\b(?:" + WRITING_DRAFT_OBJECTS + ")\\b"
  + "|(?<!\\.)\\b(?:ad|advert|advertising|marketing|web|website|landing[- ]page|sales|product|homepage|body|email) copy\\b",
  "i",
);

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
 * The cascade ORDER is the pre-Stage-1 one and has not moved: research → file
 * → code → explicit depth words (LONG_FORM_RE/DEEP_RE) → writing → shape. What
 * those depth words MATCH has. They were narrowed on 2026-07-27 from bare word
 * lists to idioms and adjective-plus-deliverable pairs, so a turn that merely
 * CONTAINS "long" or "plan" — "how long do you boil eggs", "my phone plan is 90
 * dollars a month" — now falls through to the shape classifier instead of
 * taking the 2048-token deep budget, while a turn that genuinely asks for depth
 * still short-circuits here ahead of WRITING_RE ("give me a detailed dinner
 * recipe" stays deep). See lib/answer-shape.ts for the shape of each constant
 * and lib/__tests__/depth-word-routing.test.ts for the corpus that pins it.
 *
 * The shape classifier replaces ONLY the old EXPLAIN_RE + length catch-all,
 * which Stage 0 measured at a 68% misroute rate (teaching-shaped asks never
 * reached deep; single facts rode the explain padding register). See the
 * Stage-0 shape-routing measurements for that evidence.
 *
 * ★ EVERY TEST BELOW READS THE ASK, NOT THE PASTE. A turn that pastes a
 * document is fifteen words of instruction and four hundred of subject, and a
 * cascade run over the whole turn classifies the SUBJECT. Measured on the
 * everyday-use corpus before this changed: eleven of the twelve paste-heavy
 * turns — every proofread ask in the corpus — landed on `deep`, whose turn
 * hint is "Use clear sections; include concrete recommendations and
 * tradeoffs". Replies duly came back with a "Concrete Recommendations &
 * Tradeoffs" section instead of the corrected text, and `deliversUnburied`
 * averaged 0.42 on `deep` against 0.91 on `writing`. `askPrefix` returns ""
 * when a long turn has no credible instruction paragraph, and the cascade then
 * falls back to the whole turn — silence is the fail-safe direction.
 *
 * ★ A REPAIR ASK IS A WRITING ASK, and is tested ahead of the depth words so a
 * stray "full"/"complete" in the instruction cannot steal it. "Fix my typos"
 * wants text back, not an essay about the text; WRITING_RE already encodes
 * that category for text that is being CREATED (write, draft) and this
 * completes it for text being REPAIRED. See lib/ask-text.ts for what the
 * category deliberately excludes.
 */
export function inferChatIntent(content: string, options?: InferChatIntentOptions): ChatIntent {
  const raw = content.trim();
  const text = instructionParagraph(raw);

  if (options?.researchMode || RESEARCH_RE.test(text)) return "research";
  // The file test reads `raw`: askPrefix strips file blocks by design.
  if (options?.hasFiles || /<file\b/i.test(raw)) return "file";
  if (CODE_RE.test(text)) return "code";
  if (isTextRepairAsk(raw)) return "writing";
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
    // ⚠ TWO ADDITIONS WERE TRIED HERE AND BOTH MEASURED WORSE. Left as-is on
    // evidence, not inertia.
    //
    // The failure they were aimed at is real: asked to hand back an email it had
    // drafted five turns earlier, the shipping 2B answers "I can't resend the
    // email. I can't send attachments or messages" — while quoting the two dates
    // from that draft in the same sentence, so the context was never the problem.
    //
    // Measured on `candidate/qwen3.5-2b-onnx`, greedy, over the four multi-turn
    // conversation probes that gate the history-recall dims:
    //
    //   "… Put the finished text itself in this reply."
    //     teacher-email preservesHistoryFacts 0.67 → 0 (told to produce an
    //     artifact it thought it had no source for, it demanded the source:
    //     "I don't have the original message. Please send me the exact dates").
    //   "… Use what the conversation already gives you instead of asking for it
    //   again."
    //     teacher-email 0.67 → 0 AND it began inventing ("I already sent it with
    //     the days spelled out"); budget-list 0.78 → 0.11, the printed list
    //     replaced by a looping arithmetic fragment.
    //
    // Read together: this refusal is a model-level reflex on the word "resend",
    // not a gap in what the turn is told, and pushing on it from the end of the
    // user turn — where recency makes a hint strongest — moves the reply further
    // from the ask rather than closer. Anything tried next needs a different
    // lever and its own before/after run.
    //
    // ⚠ A THIRD LEVER WAS SCOPED AND NOT BUILT, because measuring the thing it
    // targeted showed the target was mis-described. Recorded so the next attempt
    // starts from the numbers rather than from the anecdote.
    //
    // The brief was: `convo-four-day-budget-list` drops "car tax" from the
    // printed list in 3 of 3 replications, so surface its monthly equivalent in
    // context (a context-construction lever, not another hint). The drop is real
    // and common — but the mechanism and the rate were both wrong, and the fact
    // worth chasing is a different one.
    //
    //   1. THERE IS NOTHING TO SURFACE, AND NO ARITHMETIC TO DO. The converted
    //      figure is ALREADY in the replayed history — assistant turn 6 says
    //      "car tax £245/yr = £21 a month" verbatim — and nothing truncates
    //      history on this path (`getLocalModelContextBudget` caps OUTPUT tokens
    //      only). When the model gets it right it writes "| Car Tax | £21 |
    //      Annual payment (£245) |", so the conversion was never the barrier.
    //      When it gets it wrong it omits the row, or misattaches the unit
    //      elsewhere ("Council Tax | £142 | Yearly payment, £11.83/month").
    //   2. IT IS NOT 3-OF-3. Measured over 18 real generations (17 sampled on the
    //      production profile + 1 greedy; the token cap never bound — longest
    //      completion 749): the car-tax row is present in 5/18 and carries a
    //      correct monthly figure in 4/18. The best-powered single config
    //      (sampled, 1536, n=10) puts it at 2/10, both correct. Two n=3 runs at
    //      the SAME config split 0/3 and 2/3 — so n=3 cannot resolve this effect
    //      and no before/after at that size is evidence either way.
    //
    // What IS reproducible is a different fact: the income £2,180 — the number
    // the whole conversation exists to test ("does 4 days a week work?") — is
    // absent from 18 of 18. Replies instead say "roughly £1,750/month coming in"
    // (the outgoings relabelled) or "Income Available: £0". The survival pattern
    // is recall distance, not units: what the probed turn re-names itself
    // survives (rent £790 18/18) and what only exists in earlier turns does not
    // (income, turn 1: 0/18; water £31, turn 3: 8/18; car tax, turn 5: 5/18).
    // So the honest target is earlier-turn recall generally, not one bill's unit
    // conversion — and anything aimed at it needs n≈10 per arm (a generation
    // here costs ~20-35s, so that is affordable).
    //
    // ⚠ TWO ADDITIONS TO THE `writing` HINT WERE BUILT, MEASURED ON THE REAL
    // MODEL, AND REVERTED. Left as-is on evidence, not on inertia. Anything
    // tried next should start from these numbers rather than from the anecdote.
    //
    // THE FAILURE THEY WERE AIMED AT IS REAL. Asked part-way through a
    // conversation to write the message she will paste into a family group
    // chat — the `convo-birthday-lunch-message` conversation in
    // `__tests__/fixtures/everyday-conversation-corpus.ts`, probed at turn 6 —
    // the shipping 2B hands back an invitation with the specifics missing.
    // Measured over 10 real generations (`candidate/qwen3.5-2b-onnx`, sampled,
    // maxTokens 1536, production user-turn hints), against a conversation that
    // has already settled the venue, the date, the price and the back room:
    //
    //   venue named at all              1/10   (6/10 wrote "[Restaurant Name]")
    //   date right (Sunday 8th March)   5/10
    //   a WRONG weekday or date         5/10   (Saturday x3 — the day the
    //                                           conversation explicitly moved
    //                                           OFF, which the corpus names as
    //                                           its bounce condition)
    //   £25 a head present              5/10
    //   everything above, in one reply  1/10
    //
    // ★ IT IS NOT A CONTEXT PROBLEM, which is what makes it interesting.
    // Nothing truncates: the whole conversation is in the prompt, the assistant
    // turn immediately above restates both the date and the £25, and one sample
    // in ten does reproduce every specific. What the conversation never does is
    // give the restaurant a NAME — it is "an italian on bridgford road weve
    // been to before, not il pescatore thats the fish one, the other one". The
    // model wants a name for the invitation slot, does not accept the
    // description as one, and brackets or drops it.
    //
    // BOTH ATTEMPTS ADDED A CLAUSE ONLY TO MID-CONVERSATION ASKS FOR
    // CORRESPONDENCE (an author verb governing message/email/letter/invite,
    // with prior turns) — deliberately NOT to the hint below, which fires on
    // every writing turn in the product. The gate was unit-tested to leave the
    // whole single-turn corpus and the other three multi-turn conversations
    // byte-identical, and the clause was confirmed present in the production
    // bundle. Each arm is n=10 at the config above:
    //
    //   "Use the specifics this conversation already gave you, in the words
    //    they were given in — no placeholders in brackets, and nothing invented
    //    to fill a gap."
    //     Placeholders 7/10 -> 4/10, but by DELETION rather than recall: replies
    //     got 24% shorter and £25 fell 5/10 -> 2/10. Clean replies 1/10 -> 0/10.
    //     ★ And "in the words they were given in" resurrected the SUPERSEDED
    //     date: the 7th of March, corrected away early in the conversation,
    //     went 1/10 -> 5/10. Telling a small model to reuse the user's own
    //     wording makes it likelier to reuse wording that was later corrected.
    //
    //   "Write it ready to send as it stands, with the details this
    //    conversation has settled already in it."
    //     Worse across the board: venue 0/10, date right 5/10 -> 2/10, back room
    //     8/10 -> 2/10, placeholders back to 7/10, clean 0/10. One reply was a
    //     nine-placeholder blank template — the bounce condition verbatim.
    //
    // READ TOGETHER: this defect does not respond to an instruction at the end
    // of the user turn, in either direction. Pushing on form moved which failure
    // appeared, never the failure rate. The facts are present but not salient,
    // and two different families of clause both failed to make them salient. The
    // next lever to try is CONTEXT CONSTRUCTION — restating the settled details
    // near the ask, the way `lib/figure-recap.ts` does for money-shaped figures,
    // extended to the facts that are not numbers. That is a bigger build than a
    // hint and it needs its own before/after run; it is not attempted here.
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
