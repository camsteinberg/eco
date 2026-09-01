// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { getModel } from "../local-ai/catalog/catalog";
import { instructionParagraph, isTextRepairAsk, isTextTransformAsk } from "./ask-text";
import {
  DEEP_RE,
  LONG_FORM_RE,
  inferAnswerShape,
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

// ─── Eval-lane model metadata for generation profiles ───────────────────
//
// SHIPPING CATALOG MODELS ARE NOT HERE. Their family, budget and sampling live
// in `local-ai/catalog/catalog-data.json` and resolve through
// `getInstructionModelWithOptions` below — adding a shipping model is a
// one-file change.
//
// What remains is the eval lane: benchmark and validation-harness candidates
// that `allowValidationModel: true` opts into. They are not in the shipping
// catalog and not in the user bundle. Their sampling resolves through the
// eval-lane maps in `local-model-generation-profiles.ts`; entries with no
// profile row and no fallback family (smollm3, bitnet) fall through to the
// quality-tier baseline budgets, which is the intended behavior.

const CHAT_INTENT_MODEL_DATA: Record<string, ChatIntentModelSlice> = {
  // Phase-2 eval candidate.
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
  // Runtime bake-off cell: Qwen3-0.6B on MLC — same qwen3 family / fast tier
  // / sampling as local/qwen3-0.6b so the runtime comparison uses the real
  // generation profile. maxNewTokens set to 512 (webgpu) matching the ONNX sibling.
  "candidate/qwen3-0.6b-mlc": {
    id: "candidate/qwen3-0.6b-mlc",
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
  // ─── Chat #7 M2 bake-off candidates (2026-06-10, dev-only lane) ───────
  // The gemma4 entries carry no `family`: it is optional on the slice and
  // exists only to reach the eval-lane family fallback, which they never use —
  // their sampling resolves from an id-keyed row in
  // local-model-generation-profiles.ts. Omitting it retires the
  // `as unknown as ChatIntentModelSlice` casts these entries used to need.
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
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  },
  "candidate/gemma-4-e2b-qat-q4-onnx": {
    id: "candidate/gemma-4-e2b-qat-q4-onnx",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  },
  // Gemma 4 E4B via LiteRT-LM Web — the eval-only sibling of the shipping E2B
  // LiteRT entry, on the same runtime-specific slice. Same 2048 ceiling as the
  // smart-tier incumbent for a fair comparison.
  "candidate/gemma-4-e4b-litert": {
    id: "candidate/gemma-4-e4b-litert",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 2048 },
  },
  // ─── Lab / validation-harness models ─────────────────────────────────
  // No profile row and no fallback family, so runtime profile lookup falls
  // through to the baseline budgets — the intended behavior.
  "local/smollm3-3b": {
    id: "local/smollm3-3b",
    qualityTier: "smart",
    maxNewTokens: { webgpu: 1024 },
  },
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
    qualityTier: "experimental",
    maxNewTokens: { webgpu: 1024 },
  },
};

function getChatIntentModel(modelId: string): ChatIntentModelSlice | undefined {
  return CHAT_INTENT_MODEL_DATA[modelId];
}

// ─── Intent inference ────────────────────────────────────────────────────

// CODE_RE, narrowed 2026-08-15. It was a bare-word list —
// `debug|bug|stack trace|typescript|javascript|python|react|sql|function|
// component|api|test|refactor` — half of which are ordinary English words.
// "whats the function of the pancreas" was a coding task, "my dog has a
// bug" was a coding task, "my son has a test at school tomorrow" was a
// coding task.
//
// Three shapes, mirroring the WRITING_RE narrowing:
//   1. a code fence — always code;
//   2. tokens that are about code whatever follows them;
//   3. an ambiguous code noun confirmed by a code context signal within the
//      same clause: a code-domain word (code, coding, script, program,
//      error, exception, endpoint, repo) or a programming language/framework
//      name (python, react) that mutually confirms the ambiguous noun.
// EVERY ambiguous arm requires a signal the previous regex did not need, so
// this is a STRICT NARROWING of the old bare-word list. Pinned in
// `lib/__tests__/code-intent-routing.test.ts`.
//
// ASSEMBLED WITH `+`, NOT TEMPLATE INTERPOLATION — same Turbopack caveat
// as WRITING_RE (see note at line 378).
const CODE_UNAMBIGUOUS_TOKENS =
  "stack trace|traceback|refactor|typescript|javascript|regexp?|regex|sql"
  + "|segfault|null pointer|syntax error|runtime error"
  + "|npm|pnpm|css|html"
  + "|git (?:commit|rebase|merge|branch|push|clone|stash)";
const CODE_AMBIGUOUS_TOKENS =
  "debug|bug|test|function|component|api|class|method|variable|array|loop|import|react|python|query|hook"
  + "|yarn|compil(?:e|er)";
const CODE_CONTEXT_SIGNALS =
  "code|coding|script|program|error|exception|endpoint|repo|python|react";
const CODE_RE = new RegExp(
  "```"
  + "|\\b(?:" + CODE_UNAMBIGUOUS_TOKENS + ")\\b"
  + "|\\b(?:" + CODE_CONTEXT_SIGNALS + ")\\b[^.?!]{0,45}?\\b(?:" + CODE_AMBIGUOUS_TOKENS + ")\\b"
  + "|\\b(?:" + CODE_AMBIGUOUS_TOKENS + ")\\b[^.?!]{0,45}?\\b(?:" + CODE_CONTEXT_SIGNALS + ")\\b",
  "i",
);

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

// RESEARCH_RE was `/\b(research|sources|cite|latest|current|news|
// 202[5-9]|up-to-date)\b/i` — retired 2026-08-15. Bare words like
// "current", "latest", "news" claimed everyday asks on a model with no
// web access. The cascade no longer tests it; only the explicit
// `options.researchMode` flag (always false in production) survives.
// Kept as a comment rather than a constant so the file compiles clean
// and the history is findable.

/**
 * Map an answer shape to the depth-family intent that delivers its treatment.
 * teaching → deep (2048 budget); brief/social → quick (1024);
 * focused/uncertain → explain (the developed middle — per the locked
 * asymmetric-cost policy, uncertainty never lectures).
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

  // RESEARCH_RE was retired 2026-08-15. Its only effect was temp 0.35 + a
  // hedging hint ("cite sources only when you can back the claim") on a
  // model with no sources. Bare words like "current", "latest", "news"
  // claimed everyday asks — "whats the latest with my order" was getting
  // the research treatment. The regex disjunct is gone; the
  // options.researchMode flag is retained for the type contract but
  // production callers all pass false (inferTurnIntent hard-codes it).
  if (options?.researchMode) return "research";
  // The file test reads `raw`: askPrefix strips file blocks by design.
  if (options?.hasFiles || /<file\b/i.test(raw)) return "file";
  if (CODE_RE.test(text)) return "code";
  if (isTextRepairAsk(raw)) return "writing";
  // A transform ask ("make this more formal", "shorten this", "summarise it")
  // wants the text back changed, not an essay about it — tested ahead of the
  // depth words so a stray "detailed"/"full" can't steal it into `deep`, and
  // ahead of the shape fallback that otherwise lands it on `explain` (measured:
  // the 1.2B then follows the explain hint and lectures instead of transforms).
  if (isTextTransformAsk(raw)) return "writing";
  if (LONG_FORM_RE.test(text)) return "deep";
  if (DEEP_RE.test(text)) return "deep";
  if (WRITING_RE.test(text)) return "writing";
  return mapShapeToDepthIntent(
    inferAnswerShape(text, { hasPriorTurns: options?.hasPriorTurns ?? false }),
  );
}

/**
 * The largest `maxNewTokens` the model could request under ANY intent —
 * i.e. the model's generation ceiling. Used by context-window selection to
 * reserve enough headroom for the generation phase without knowing the
 * specific intent yet (the divider useMemo, for instance, runs before the
 * intent is computed). Falls back to 2048 (the catalog maximum) when the
 * model is unknown — conservative, never under-reserves.
 */
export function getMaxNewTokensCeiling(
  modelId?: string,
  options: LocalGenerationProfileOptions = {},
): number {
  const model = getInstructionModelWithOptions(modelId, options);
  return model?.maxNewTokens.webgpu ?? 2048;
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
 * Resolve the model slice the generation path works from.
 *
 * Shipping catalog models come straight from catalog-data.json — the catalog
 * is the source for their generation ceiling, and `getGenerationProfileSlice`
 * reads their sampling and per-intent budgets from the same entry. Non-catalog
 * models fail closed to the baseline profile unless a benchmark or validation
 * harness opts into the eval lane.
 */
function getInstructionModelWithOptions(
  modelId: string | undefined,
  options: LocalGenerationProfileOptions = {},
): ChatIntentModelSlice | undefined {
  if (!modelId) return undefined;
  const catalogModel = getModel(modelId);
  if (catalogModel) {
    return { id: catalogModel.id, maxNewTokens: { webgpu: catalogModel.maxNewTokens.ceiling } };
  }
  if (options.allowValidationModel) {
    return getChatIntentModel(modelId);
  }
  return undefined;
}

export function getGenerationProfile(
  intent: ChatIntent,
  _isLocal: boolean,
  modelId?: string,
  options: LocalGenerationProfileOptions = {},
): GenerationProfile {
  const maxTokens = getLocalMaxTokens(intent, modelId, options);
  const modelProfile = getModelGenerationProfileWithOptions(intent, modelId, options);

  // CHOSEN fallback 0.5 — a neutral mid-range temperature. Catalog models
  // never reach it: every catalog id has a PROFILE_BY_MODEL_ID row
  // (invariant pinned in local-model-generation-profiles.test.ts
  // "has a generation profile entry for every v1 catalog model id"), so
  // modelProfile always carries a publisher-sourced temperature on the
  // production path. The fallback fires only for non-catalog ids (which
  // getInstructionModelWithOptions rejects unless allowValidationModel is
  // set) or lab models without a generationDefaults.temperature.
  // Falsifier: a catalog model whose profile omits temperature on every
  // intent — add the model to PROFILE_BY_MODEL_ID, don't change this
  // constant.
  return {
    temperature: modelProfile.temperature ?? 0.5,
    maxTokens,
    ...modelProfile,
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
 * Deterministically re-derive the intent of ONE turn from its own text and
 * position — the single inference rule used at dispatch time. `hasFiles`
 * comes from the turn's own content; research mode is retired in web v1.0.
 */
export function inferTurnIntent(content: string, hasPriorTurns: boolean): ChatIntent {
  return inferChatIntent(content, {
    hasFiles: content.includes("<file"),
    researchMode: false,
    hasPriorTurns,
  });
}
