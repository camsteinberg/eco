// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The everyday-use routing sweep — does the router set the model up to give this
 * person the answer they came for, or the one that makes them leave?
 *
 * THE BAR. Eco is judged on whether a non-technical person can switch to it — or
 * use an assistant for the first time — without losing the use cases that make AI
 * genuinely helpful. Every other suite here asks whether a mechanism behaves as
 * designed. This one asks whether the design serves the person, using forty jobs
 * real people bring and the response that would make each of them give up
 * (`fixtures/everyday-use-corpus.ts`).
 *
 * WHAT THE HOST DECIDES before a token is generated, and what this measures:
 *
 *   1. THE HINT appended to the user's turn. "Lead with a plain-language
 *      explanation, then develop the details that matter — reasons, examples,
 *      practical implications" is good advice for a question about a concept and
 *      a description of the failure mode for someone who pasted an email and
 *      asked for it to sound less annoyed.
 *   2. THE TOKEN BUDGET. A ceiling, not a target — and on the everyday default
 *      only `quick` sits below 1536, so a budget assertion here is an intent
 *      assertion wearing a length label. Kept in budget terms because the budget
 *      is what reaches the runtime; not to be read as independent of intent.
 *   3. THE SAMPLING CONTROLS. `noRepeatNgramSize` is banned across the FULL
 *      sequence by Transformers.js, prompt included, so it forbids the model from
 *      reusing spans of the user's own text — on the exact turns whose entire
 *      requirement is reusing the user's own text.
 *   4. THE SYSTEM PROMPT, which this sweep does NOT route and cannot vary per
 *      turn. See the standing observation at the end of this file: the shipping
 *      on-device prompt carries its own development instruction on every turn, so
 *      hint-level fixes alone cannot deliver a direct posture. Anyone reading a
 *      green run as "the posture is fixed" would be wrong.
 *
 * WHAT IT DOES NOT MEASURE. Whether the generated answer is any good. That needs
 * a loaded model on real hardware. This measures the conditions we hand the model
 * — the part that is deterministic, cheap, and currently wrong.
 *
 * ★ TWO LAYERS, AND ONLY ONE OF THEM IS A JUDGEMENT.
 *
 *   THE FACT LAYER (`ROUTING_TODAY`, `MODEL_MATRIX_TODAY`) pins what the router
 *   does today, per item and per model, with no opinion in it. Judge a routing
 *   change by this diff first: it shows what the change did, including to the
 *   items it was not aimed at.
 *
 *   THE JUDGED LAYER (the four checks and `KNOWN_GAPS`) encodes our reading of
 *   what each bounce condition demands. It is arguable and meant to be argued
 *   with.
 *
 *   Each check is written to measure the property it NAMES rather than a symptom
 *   of it — because a check that can be satisfied by a change which does not help
 *   the user is not a weak check, it is a check measuring something other than
 *   what its name says. An audit found three of those here, and the repairs are
 *   worth understanding before adding a fifth check:
 *     - the elaboration check matched four substrings of two hint strings, so it
 *       measured "contains this wording", not "instructs development". Rewording
 *       a hint — for good reasons, using text that already ships in this same
 *       function — closed all twenty-five of its gaps. It now pins the
 *       classification of every hint the codebase can emit, so new wording has to
 *       be classified rather than silently pass.
 *     - the faithfulness check asked whether ANY model bans n-grams at an intent.
 *       One model bans them at every intent, so the check was a constant that no
 *       routing change could move. It now measures only the bans routing arms.
 *     - the per-item checks are all local, and the cheapest global change that
 *       satisfies them (moving turns onto `writing`) more than doubles how many
 *       turns are forbidden from quoting the user back. `NGRAM_EXPOSURE_CEILING`
 *       measures that directly; `needs-guidance` likewise catches hint-emptying,
 *       which would otherwise satisfy `no-elaboration-hint` everywhere.
 *
 * ★ WHEN IT FAILS. `KNOWN_GAPS` pins each shortfall to its mechanism at CURRENT
 * behaviour, so closing a gap fails this suite on purpose — delete the entry, do
 * not relax it. Never edit a corpus expectation to go green: the corpus is a
 * statement about people and does not change because our code changed.
 *
 * ★ MECHANISMS STACK. A gap can have two causes. Each entry therefore pins the
 * intent it fails at, so a fix that changes the cause without closing the gap
 * reads as "still failing, but now via `explain` instead of `deep`" rather than
 * as "the mechanism was misdiagnosed".
 */

import { describe, it, expect } from "vitest";

import {
  buildHintedUserTurn,
  buildTurnQualityInstruction,
  getGenerationProfile,
  inferTurnIntent,
  type ChatIntent,
} from "../lib/chat-intent";
import { inferAnswerShape, type AnswerShape } from "../lib/answer-shape";
import { getCatalog } from "../local-ai/catalog/catalog";
import { PREFERRED_DEFAULT_MODEL_ID } from "../local-ai/selection/recommend";
import { getOnDeviceSystemPrompt } from "../lib/system-prompt";
import {
  EVERYDAY_USE_CORPUS,
  ROUTING_NEEDS,
  hasPriorTurns,
  itemsNeeding,
  needsFor,
  type EverydayUseItem,
} from "./fixtures/everyday-use-corpus";

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/** Every model a user can actually be served, derived so a new one is covered. */
const CATALOG_MODEL_IDS: readonly string[] = getCatalog().map((model) => model.id);

const INTENT_ORDER: readonly ChatIntent[] = [
  "quick",
  "explain",
  "deep",
  "code",
  "writing",
  "file",
  "research",
];

/**
 * Budget assertions run against the everyday default, deliberately not against
 * every model: `local/qwen3-0.6b` caps at 512 and `candidate/lfm2.5-350m-onnx` at
 * 384 on every intent, so there the model's own ceiling settles the budget
 * question and it says nothing about routing.
 */
const BUDGET_MODEL = PREFERRED_DEFAULT_MODEL_ID;

/** The top of the direct band — `quick`, the only budget below the middle. */
const DIRECT_BAND_MAX_TOKENS = 1024;

/**
 * Phrases that instruct the model to DEVELOP rather than deliver.
 *
 * Matched against the appended HINT only, never the whole turn — the user's own
 * words are not an instruction we gave, and "tradeoffs" is an ordinary English
 * word somebody will eventually type.
 *
 * These are not free-floating: `pins every hint the codebase can emit` below
 * asserts the classification of every string `buildTurnQualityInstruction` can
 * produce, across all intents and all catalog models. That test is the point.
 * Without it this list is a fingerprint of two literals, and an audit showed the
 * whole `no-elaboration-hint` block — twenty-five gaps — closing by adopting
 * replacement wording that already ships a few lines away in the same function.
 */
const ELABORATION_MARKERS: readonly string[] = [
  "develop the details",
  "sections",
  "tradeoffs",
  "reasons, examples",
];

type Routing = {
  readonly shape: AnswerShape;
  readonly intent: ChatIntent;
  readonly maxTokens: number;
  /** The instruction appended to the turn; empty when none was. */
  readonly hint: string;
  readonly elaborationMarkers: readonly string[];
  /**
   * Catalog models where THIS INTENT arms a prompt-inclusive n-gram ban that
   * `quick` does not. Scoped that way on purpose: `candidate/lfm2.5-350m-onnx`
   * carries a base ban on all seven intents, so an unscoped check would be a
   * constant `false` that no routing change could ever satisfy — and would
   * blame routing for a model-profile decision routing cannot reach.
   */
  readonly ngramBanningModels: readonly string[];
};

function route(item: EverydayUseItem): Routing {
  const prior = hasPriorTurns(item.id);
  const intent = inferTurnIntent(item.userInput, prior);
  const rendered = buildHintedUserTurn(item.userInput, intent, true, BUDGET_MODEL);
  const hint = rendered === item.userInput ? "" : rendered.slice(item.userInput.length + 2);
  return {
    shape: inferAnswerShape(item.userInput, { hasPriorTurns: prior }),
    intent,
    maxTokens: getGenerationProfile(intent, true, BUDGET_MODEL).maxTokens,
    hint,
    elaborationMarkers: ELABORATION_MARKERS.filter((marker) =>
      hint.toLowerCase().includes(marker),
    ),
    ngramBanningModels: CATALOG_MODEL_IDS.filter(
      (modelId) =>
        getGenerationProfile(intent, true, modelId).noRepeatNgramSize != null
        && getGenerationProfile("quick", true, modelId).noRepeatNgramSize == null,
    ),
  };
}

/** The four checks, one per routing need. `null` = the need is met. */
const CHECKS = {
  "no-elaboration-hint": (r: Routing) =>
    r.elaborationMarkers.length === 0
      ? null
      : `told to elaborate (${r.elaborationMarkers.join(", ")}) via intent "${r.intent}"`,
  "direct-budget": (r: Routing) =>
    r.maxTokens <= DIRECT_BAND_MAX_TOKENS
      ? null
      : `budget ${String(r.maxTokens)} is above the direct band (${String(DIRECT_BAND_MAX_TOKENS)}) via intent "${r.intent}"`,
  "faithful-reproduction": (r: Routing) =>
    r.ngramBanningModels.length === 0
      ? null
      : `routing arms a prompt-inclusive n-gram ban on ${r.ngramBanningModels.join(", ")} via intent "${r.intent}"`,
  "needs-guidance": (r: Routing) =>
    r.hint.length > 0
      ? null
      : `turn carries no instruction at all via intent "${r.intent}"`,
} as const;

type Need = keyof typeof CHECKS;
type GapKey = `${Need}/${string}`;

function checkOf(need: Need, item: EverydayUseItem): string | null {
  return CHECKS[need](route(item));
}

/**
 * Every (turn, model) pair where routing arms a prompt-inclusive n-gram ban,
 * counted across the whole corpus and every catalog model — including the base
 * bans the per-item check deliberately excludes.
 *
 * This is the aggregate the per-item checks cannot see. An audit found that the
 * most obvious way to fix the biggest block — push everything off `explain` —
 * lands those turns on `writing`, whose hint carries no marker and whose budget
 * satisfies the rest. That change scores as an unqualified win per-item while
 * more than doubling how many turns are forbidden from quoting the user back.
 */
function ngramExposure(): number {
  let pairs = 0;
  for (const item of EVERYDAY_USE_CORPUS) {
    const intent = inferTurnIntent(item.userInput, hasPriorTurns(item.id));
    for (const modelId of CATALOG_MODEL_IDS) {
      if (getGenerationProfile(intent, true, modelId).noRepeatNgramSize != null) {
        pairs += 1;
      }
    }
  }
  return pairs;
}

/**
 * Today's exposure. A routing change may lower this; it must never raise it.
 *
 * Was 58 before the `writing` n-gram overrides came off phi3, qwen3-0.6b and the
 * shipping default. The remaining 40 are all the 350M starter, whose ban is BASE
 * and applies at every intent — see the deferred decision pinned at the end of
 * this file. No routing change can lower it further.
 */
const NGRAM_EXPOSURE_CEILING = 40;

// ---------------------------------------------------------------------------
// Where today's routing disagrees with the corpus.
//
// These failures are not individual bugs. They are a handful of mechanisms, so
// they are recorded as mechanisms: fixing one should close a block. But
// MECHANISMS STACK — dropping the >360-character rule moves five items from
// `deep` to `explain`, which still carries a marker and still budgets 1536, so
// those gaps stay red for a NEW reason. Each entry therefore pins the intent it
// fails at today, and the gap test reports when only the cause moved.
// ---------------------------------------------------------------------------

const GAP_MECHANISMS = {
  "shape-length-catchall": [
    "`inferAnswerShape` returns `teaching` for any turn longer than 360 characters",
    "(answer-shape.ts LONG_ASK_MIN_CHARS), and `mapShapeToDepthIntent` sends teaching to",
    "`deep`. So pasting anything longer than a paragraph is read as a request for a",
    "lecture and comes back with 'Use clear sections; include concrete recommendations",
    "and tradeoffs'. The length of what someone pasted says nothing about how long an",
    "answer they want — usually the reverse, since the long thing is the input.",
  ].join(" "),

  "explain-default-middle": [
    "Nothing in the cascade matches and the shape is `uncertain` or `focused`, so the",
    "turn lands on the default middle: `explain`, 1536 tokens, carrying 'Lead with a",
    "plain-language explanation, then develop the details that matter — reasons,",
    "examples, practical implications'. Good advice for a question about a concept, and",
    "a description of the failure mode for the twenty-odd items here that asked for an",
    "artifact or a verdict. Note what this bucket IS: `explain` is where turns land when",
    "nothing fired, so rewording its hint without changing what arrives there only",
    "changes the flavour of the default.",
  ].join(" "),

  // `long-form-bare-long` lived here and is deliberately gone: LONG_FORM_RE and
  // DEEP_RE no longer match bare words, so the mechanism explains no remaining
  // gap and the test below requires it to be deleted rather than kept as
  // history. What it described is now pinned as a standing net in
  // `lib/__tests__/depth-word-routing.test.ts`, against the corpus that measured
  // it: 53 of 53 ordinary turns containing a depth word routed to `deep`, now 5.

  "cascade-beats-brief-shape": [
    "`inferChatIntent` tests the task-class regexes before it consults the answer shape,",
    "so a turn the shape classifier correctly calls `brief` can still be handed a",
    "task-class budget and hint. Here a group-chat transcript ending in 'tldr' is",
    "classified `brief`, then WRITING_RE matches the word 'message' INSIDE the pasted",
    "thread and the turn gets the writing budget anyway. The classifier that read the",
    "user's ask loses to one that read their paste.",
  ].join(" "),

  "writing-budget-is-middle": [
    "The `writing` intent's budget is the 1536-token middle for every model with room",
    "for it, whatever the artifact is. A four-line poem, a three-line summary of a school",
    "letter and a full cover letter all get the same ceiling, because the intent encodes",
    "the TASK CLASS and nothing encodes the SIZE of the thing being asked for.",
  ].join(" "),

  "plurality-to-teaching": [
    "`PLURALITY_RE` treats 'ideas for', 'tips on', 'ways to' as teaching signals, so",
    "'gift ideas for my dad' routes to `deep` with the sections-and-tradeoffs hint.",
    "Asking for a list of options is not asking to be taught about the space of options",
    "— and this item's bounce condition is literally 'twenty vague options instead of",
    "eight good ones'.",
  ].join(" "),

  "brevity-misses-the-budget": [
    "The user gave an explicit brevity instruction and the per-turn hint was correctly",
    "suppressed — but nothing carried that instruction to the BUDGET.",
    "`getGenerationProfile` takes no content parameter at all, so the budget path cannot",
    "see the user's words; hint suppression and routing are two systems that do not",
    "talk. 'keep it short and dont make it weird' still gets the 1536-token middle.",
  ].join(" "),
} as const;

type GapMechanism = keyof typeof GAP_MECHANISMS;

/**
 * `need/item-id` → the mechanism, and the intent it fails at today. The intent is
 * pinned so that a fix which changes the CAUSE without closing the gap reports
 * that plainly instead of looking like a misdiagnosis.
 */
const KNOWN_GAPS: ReadonlyMap<GapKey, { mechanism: GapMechanism; intent: ChatIntent }> =
  new Map<GapKey, { mechanism: GapMechanism; intent: ChatIntent }>([
    ["no-elaboration-hint/work-email-tone-fix", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["direct-budget/work-email-tone-fix", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["no-elaboration-hint/work-followup-shorter", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/work-followup-shorter", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/rewrite-03", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["no-elaboration-hint/sw-15", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["direct-budget/sw-15", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["no-elaboration-hint/school-essay-not-ai", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["direct-budget/school-essay-not-ai", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["direct-budget/work-sick-text", { mechanism: "brevity-misses-the-budget", intent: "explain" }],
    ["direct-budget/draft-01", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/admin-gym-cancellation", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["no-elaboration-hint/family-eulogy", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/ft-06", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["no-elaboration-hint/health-blood-results", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/health-blood-results", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/health-hospital-letter", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["direct-budget/school-letter-esl-parent", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/summarise-01", { mechanism: "cascade-beats-brief-shape", intent: "writing" }],
    ["direct-budget/explain-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/school-fractions", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/school-fractions", { mechanism: "explain-default-middle", intent: "explain" }],
    // `factual-01` ("how long do you boil eggs for hard boiled") had both of its
    // needs pinned here under `long-form-bare-long`. Both CLOSED on 2026-07-27
    // when LONG_FORM_RE and DEEP_RE were narrowed off bare words: the turn now
    // routes `quick` at 1024 tokens with no hint, which is what its bounce
    // condition asked for. The mechanism went with them.
    ["no-elaboration-hint/factual-02", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/decide-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/decide-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/money-insurance-jump", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/money-insurance-jump", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/ft-14", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/money-budget-house", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/money-budget-house", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/excel-sumif", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/excel-sumif", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/sw-13", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/sw-13", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/food-fridge-dinner", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/food-fridge-dinner", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/ideas-01", { mechanism: "plurality-to-teaching", intent: "deep" }],
    ["direct-budget/ideas-01", { mechanism: "plurality-to-teaching", intent: "deep" }],
    ["no-elaboration-hint/family-text-thread", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/family-text-thread", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/company-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/company-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/company-02", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/company-02", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/translate-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/translate-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/translate-02", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["direct-budget/translate-02", { mechanism: "shape-length-catchall", intent: "deep" }],
    ["no-elaboration-hint/ft-04", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/ft-04", { mechanism: "explain-default-middle", intent: "explain" }],
    ["no-elaboration-hint/ft-13", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/ft-13", { mechanism: "explain-default-middle", intent: "explain" }],
  ]);

// ---------------------------------------------------------------------------
// The fact layer: today's routing, pinned exactly.
// ---------------------------------------------------------------------------

const ROUTING_TODAY: Readonly<
  Record<string, { intent: ChatIntent; maxTokens: number; temperature: number; hint: string }>
> = {
  "work-email-tone-fix": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
  "work-followup-shorter": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "rewrite-03": { intent: "writing", maxTokens: 1536, temperature: 0.48, hint: "Match the requested format and tone; avoid filler." },
  "sw-15": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
  "school-essay-not-ai": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
  "work-sick-text": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "" },
  "draft-01": { intent: "writing", maxTokens: 1536, temperature: 0.48, hint: "Match the requested format and tone; avoid filler." },
  "admin-gym-cancellation": { intent: "writing", maxTokens: 1536, temperature: 0.48, hint: "Match the requested format and tone; avoid filler." },
  "family-eulogy": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "ft-06": { intent: "writing", maxTokens: 1536, temperature: 0.48, hint: "Match the requested format and tone; avoid filler." },
  "health-blood-results": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "health-hospital-letter": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
  "school-letter-esl-parent": { intent: "writing", maxTokens: 1536, temperature: 0.48, hint: "Match the requested format and tone; avoid filler." },
  "legal-rent-increase": { intent: "research", maxTokens: 2048, temperature: 0.6, hint: "Distinguish supported claims from uncertain ones; cite sources only when you can back the claim." },
  "summarise-01": { intent: "writing", maxTokens: 1536, temperature: 0.48, hint: "" },
  "explain-01": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "school-fractions": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "factual-01": { intent: "quick", maxTokens: 1024, temperature: 0.32, hint: "" },
  "factual-02": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "factual-04": { intent: "quick", maxTokens: 1024, temperature: 0.32, hint: "" },
  "decide-01": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "money-insurance-jump": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "ft-14": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "money-budget-house": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "excel-sumif": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "sw-13": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "food-fridge-dinner": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "travel-lisbon-kid": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "ideas-01": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
  "family-text-thread": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "company-01": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "company-02": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "translate-01": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "translate-02": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
  "ft-01": { intent: "quick", maxTokens: 1024, temperature: 0.32, hint: "" },
  "ft-04": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "ft-08": { intent: "quick", maxTokens: 1024, temperature: 0.32, hint: "" },
  "ft-13": { intent: "explain", maxTokens: 1536, temperature: 0.42, hint: "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications." },
  "sw-12": { intent: "quick", maxTokens: 1024, temperature: 0.32, hint: "" },
  "ft-15": { intent: "quick", maxTokens: 1024, temperature: 0.32, hint: "" },
};

/**
 * The same facts per model, because the intent alone does not decide what the
 * model receives. Format: `intent:maxTokens/temperature[/nNoRepeatNgram]`.
 *
 * Two things visible here that no per-item view shows:
 *
 *   - `candidate/lfm2.5-350m-onnx` — the model every first-time user's first
 *     answer comes from — carries an n-gram ban on ALL SEVEN intents and caps
 *     every one of them at 384 tokens.
 *   - `candidate/qwen2.5-0.5b-mlc` is the one row whose temperatures are the
 *     bare per-intent defaults rather than a model profile, because it is absent
 *     from chat-intent's model registry. Its runtime forwards only max_tokens
 *     and temperature, so this row IS the whole sampling policy for that lane —
 *     which makes the default table live code, not the dead fallback it looks
 *     like. Anything that touches it changes what those users get.
 */
const MODEL_MATRIX_TODAY: Readonly<Record<string, string>> = {
  "local/phi3-mini-4k-q4f16":
    "quick:1024/0.2 explain:1024/0.38 deep:1024/0.45 code:1024/0.18 writing:1024/0.44 file:1024/0.45 research:1024/0.45",
  "local/qwen3-0.6b":
    "quick:512/0.32 explain:512/0.42 deep:512/0.6 code:512/0.2 writing:512/0.48 file:512/0.6 research:512/0.6",
  "candidate/lfm2.5-1.2b-instruct-onnx":
    "quick:1024/0.2 explain:1536/0.3 deep:2048/0.3 code:2048/0.2 writing:1536/0.4 file:2048/0.3 research:2048/0.3",
  "candidate/lfm2.5-350m-onnx":
    "quick:384/0.25/n3 explain:384/0.45/n3 deep:384/0.45/n3 code:384/0.45/n3 writing:384/0.38/n4 file:384/0.45/n3 research:384/0.45/n3",
  "candidate/qwen3.5-2b-onnx":
    "quick:1024/0.32 explain:1536/0.42 deep:2048/0.6 code:2048/0.2 writing:1536/0.48 file:2048/0.6 research:2048/0.6",
  "candidate/gemma-4-e2b-litert":
    "quick:256/0.18 explain:768/0.3 deep:1536/0.42 code:1024/0.18 writing:1024/0.45 file:1536/0.45 research:1536/0.45",
  "candidate/qwen2.5-0.5b-mlc":
    "quick:1024/0.45 explain:1536/0.55 deep:2048/0.55 code:2048/0.25 writing:1536/0.75 file:2048/0.4 research:2048/0.35",
};

describe("everyday-use sweep — today's routing, pinned exactly", () => {
  for (const item of EVERYDAY_USE_CORPUS) {
    it(`routes ${item.id} unchanged`, () => {
      const routing = route(item);
      expect({
        intent: routing.intent,
        maxTokens: routing.maxTokens,
        temperature: getGenerationProfile(routing.intent, true, BUDGET_MODEL).temperature,
        hint: routing.hint,
      }).toEqual(ROUTING_TODAY[item.id]);
    });
  }

  it("hands every catalog model the same budgets and sampling as before", () => {
    const actual: Record<string, string> = {};
    for (const modelId of CATALOG_MODEL_IDS) {
      actual[modelId] = INTENT_ORDER.map((intent) => {
        const profile = getGenerationProfile(intent, true, modelId);
        const ngram =
          profile.noRepeatNgramSize != null ? `/n${String(profile.noRepeatNgramSize)}` : "";
        return `${intent}:${String(profile.maxTokens)}/${String(profile.temperature)}${ngram}`;
      }).join(" ");
    }
    expect(actual).toEqual(MODEL_MATRIX_TODAY);
  });
});

// ---------------------------------------------------------------------------
// Integrity — the instrument itself
// ---------------------------------------------------------------------------

/**
 * Every hint string the codebase can emit, with our classification of it.
 *
 * THIS IS THE LOAD-BEARING GUARD on `no-elaboration-hint`. Without it the marker
 * list is a fingerprint of two literals: an audit closed all twenty-five gaps in
 * that block by adopting the LiteRT wording that already ships in the same
 * function — wording which still says "at most three short sections with two
 * bullets each", near-verbatim one item's own bounce condition. With this pin, a
 * reworded hint fails here and has to be classified deliberately.
 */
const HINT_CLASSIFICATION: Readonly<Record<string, boolean>> = {
  "Lead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications.":
    true,
  "Use clear sections; include concrete recommendations and tradeoffs.": true,
  "Lead with the working code or fix; keep the explanation short.": false,
  "Match the requested format and tone; avoid filler.": false,
  "Lead with the conclusion; cite specifics from the file.": false,
  "Distinguish supported claims from uncertain ones; cite sources only when you can back the claim.":
    false,
  "Answer directly and briefly. For a single factual question, give the answer first and stop. For a short follow-up, make only the requested change.":
    false,
  "Lead with the direct answer, then cover the essential details in at most three concise paragraphs or bullets. Stop when the distinction is clear.":
    false,
  "Use at most three short sections with two bullets each. Give concrete steps and a brief why for each. Finish with one short takeaway.":
    true,
};

describe("everyday-use sweep — the instrument", () => {
  it("covers forty jobs across every category the authors identified", () => {
    expect(EVERYDAY_USE_CORPUS.length).toBe(40);
    expect(new Set(EVERYDAY_USE_CORPUS.map((i) => i.category)).size).toBeGreaterThanOrEqual(9);
  });

  it("pins every hint the codebase can emit, and how we classify it", () => {
    const emitted: Record<string, boolean> = {};
    for (const modelId of [...CATALOG_MODEL_IDS, undefined]) {
      for (const intent of INTENT_ORDER) {
        const hint = buildTurnQualityInstruction(intent, true, modelId);
        if (hint.length === 0) {
          continue;
        }
        emitted[hint] = ELABORATION_MARKERS.some((m) => hint.toLowerCase().includes(m));
      }
    }
    // A reworded or new hint lands here as an unclassified key. Classify it on
    // purpose — do not delete the entry to make this pass.
    expect(emitted).toEqual(HINT_CLASSIFICATION);
  });

  it("keeps every marker earning its place in a hint we actually ship", () => {
    const shipped = Object.keys(HINT_CLASSIFICATION).join(" ").toLowerCase();
    for (const marker of ELABORATION_MARKERS) {
      expect(shipped, `marker "${marker}" matches no hint we emit`).toContain(marker);
    }
  });

  it("never reads a marker out of the user's own words", () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      for (const marker of ELABORATION_MARKERS) {
        expect(
          item.userInput.toLowerCase().includes(marker),
          `${item.id} contains "${marker}" — the check would blame us for the user's wording`,
        ).toBe(false);
      }
    }
  });

  it("derives a routing need, quoting the item, for every item", () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const entry = needsFor(item.id);
      expect(entry.needs.length, `${item.id} has no derived need`).toBeGreaterThan(0);
      // A justification has to QUOTE the item — a paraphrase is a guess wearing
      // quotation marks. Every entry must share a verbatim span with its item.
      // A quote may elide with "…"; each side of the elision must still be real.
      // A quote may elide with "…" and may carry a closing full stop the source
      // punctuates differently; the substance either appears verbatim or it does
      // not, and a paraphrase in quotation marks fails here.
      const quoted = [...entry.why.matchAll(/"([^"]{12,})"/g)]
        .flatMap((m) => (m[1] ?? "").split("…"))
        .map((span) => span.trim().replace(/[.,;:]$/, ""))
        .filter((span) => span.length >= 12);
      const source = [
        item.userInput,
        item.whatTheyActuallyWant,
        item.goodAnswerLooksLike,
        item.bounceCondition,
      ].join(" ");
      expect(
        quoted.some((span) => source.includes(span)),
        `${item.id} justification quotes nothing from the item itself`,
      ).toBe(true);
    }
    const corpusIds = new Set(EVERYDAY_USE_CORPUS.map((i) => i.id));
    for (const id of Object.keys(ROUTING_NEEDS)) {
      expect(corpusIds.has(id), `${id} is derived but not in the corpus`).toBe(true);
    }
  });

  it("pins how many need-labels exist, so removing one is a deliberate edit", () => {
    const total = EVERYDAY_USE_CORPUS.reduce((n, i) => n + needsFor(i.id).needs.length, 0);
    expect(total).toBe(86);
  });

  it("carries a counterweight, so the corpus is not satisfiable by saying less", () => {
    expect(itemsNeeding("needs-guidance").length).toBeGreaterThanOrEqual(4);
    expect(itemsNeeding("faithful-reproduction").length).toBeGreaterThanOrEqual(8);
  });

  it("measures against models a user can actually be served", () => {
    expect(CATALOG_MODEL_IDS).toContain(BUDGET_MODEL);
    expect(CATALOG_MODEL_IDS.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// The corpus-wide ceiling the per-item checks cannot see.
// ---------------------------------------------------------------------------

describe("everyday-use sweep — n-gram exposure across the corpus", () => {
  it("never arms a prompt-inclusive n-gram ban on more turns than it does today", () => {
    expect(
      ngramExposure(),
      "a routing change pushed more turns onto an intent that forbids quoting the user back",
    ).toBeLessThanOrEqual(NGRAM_EXPOSURE_CEILING);
  });

  it("records today's exposure, so a reduction is noticed too", () => {
    expect(ngramExposure()).toBe(NGRAM_EXPOSURE_CEILING);
  });
});

// ---------------------------------------------------------------------------
// The four properties
// ---------------------------------------------------------------------------

const NEED_DESCRIPTIONS: Record<Need, string> = {
  "no-elaboration-hint": "asks for an artifact or a verdict, so is not told to elaborate",
  "direct-budget": "is bounded in length, so routes inside the direct band",
  "faithful-reproduction":
    "must give the user's own words back, so routing arms no n-gram ban",
  "needs-guidance": "has a multi-part answer, so still receives an instruction",
};

for (const need of Object.keys(CHECKS) as Need[]) {
  describe(`everyday-use sweep — ${NEED_DESCRIPTIONS[need]}`, () => {
    const scoped = itemsNeeding(need);
    const live = scoped.filter((item) => !KNOWN_GAPS.has(`${need}/${item.id}`));

    if (live.length === 0) {
      it(`is failed by ALL ${String(scoped.length)} items that need it — see the pinned gaps`, () => {
        expect(scoped.length).toBeGreaterThan(0);
        for (const item of scoped) {
          expect(checkOf(need, item), `${item.id} unexpectedly passes`).not.toBeNull();
        }
      });
      return;
    }

    for (const item of live) {
      it(item.id, () => {
        expect(checkOf(need, item), needsFor(item.id).why).toBeNull();
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The gaps, pinned. Each asserts CURRENT behaviour, so closing one fails here.
// ---------------------------------------------------------------------------

describe("everyday-use sweep — known gaps stay visible", () => {
  it("names a mechanism for every gap, against an item that exists", () => {
    for (const [key, { mechanism }] of KNOWN_GAPS) {
      const [need, id] = key.split("/") as [Need, string];
      const item = EVERYDAY_USE_CORPUS.find((i) => i.id === id);
      expect(item, `${key} names an item not in the corpus`).toBeDefined();
      expect(needsFor(id).needs, `${key} pins a need the item does not carry`).toContain(need);
      expect(
        GAP_MECHANISMS[mechanism].length,
        `${mechanism} needs an explanation, not a label`,
      ).toBeGreaterThan(200);
    }
  });

  it("keeps no mechanism that no longer explains a gap", () => {
    const cited = new Set([...KNOWN_GAPS.values()].map((v) => v.mechanism));
    for (const mechanism of Object.keys(GAP_MECHANISMS) as GapMechanism[]) {
      expect(cited.has(mechanism), `${mechanism} explains nothing — delete it`).toBe(true);
    }
  });

  for (const [key, { mechanism, intent }] of KNOWN_GAPS) {
    const [need, id] = key.split("/") as [Need, string];
    const item = EVERYDAY_USE_CORPUS.find((i) => i.id === id);
    if (item === undefined) {
      continue;
    }
    it(`still fails ${need} on ${id} (gap)`, () => {
      const failure = checkOf(need, item);
      expect(
        failure,
        `This gap CLOSED. Delete the "${key}" entry from KNOWN_GAPS — do not relax the check.`,
      ).not.toBeNull();
      // The cause is pinned separately: a fix that moves a turn to a different
      // intent without closing the gap should read as progress, not as a
      // misdiagnosed mechanism.
      expect(
        route(item).intent,
        `Still failing, but the cause moved: "${key}" was pinned at intent "${intent}" under mechanism "${mechanism}". Update the pin.`,
      ).toBe(intent);
    });
  }
});

// ---------------------------------------------------------------------------
// The headline.
// ---------------------------------------------------------------------------

describe("everyday-use sweep — the headline", () => {
  it("names which of the forty are routed against their own bounce condition", () => {
    const failing = EVERYDAY_USE_CORPUS.filter((item) =>
      needsFor(item.id).needs.some((need) => checkOf(need, item) !== null),
    ).map((item) => item.id);
    // A list, not a count: a count can absorb one item fixed and another broken
    // by staying the same, and decrementing a number was a required step in every
    // way an audit found to make this suite falsely green.
    expect([...failing].sort()).toEqual([...new Set([...KNOWN_GAPS.keys()].map((k) => k.split("/")[1] ?? ""))].sort());
  });
});

// ---------------------------------------------------------------------------
// Two standing observations. Neither is asserted as correct.
// ---------------------------------------------------------------------------

/**
 * A heuristic that reads the PASTE instead of the ASK.
 *
 * The same defect class an earlier sweep found in the grounding tool, where
 * realistic inputs fired outbound lookups because a matcher read the whole turn
 * rather than the question in it. The fix there was to scope matching to the ask
 * window. The intent cascade was never given that treatment, and it sits above
 * everything else in routing.
 *
 * Derived, not hardcoded: any item whose routed intent is driven by a word that
 * appears only in the pasted body qualifies, so a third case shows up on its own.
 */
describe("everyday-use sweep — the intent cascade reads pasted content", () => {
  const CASCADE_TRIGGERS: Readonly<Record<string, readonly string[]>> = {
    research: ["research", "sources", "cite", "latest", "current", "news", "up-to-date"],
    writing: ["write", "rewrite", "draft", "tone", "copy", "email", "essay", "story", "post", "message", "headline", "recipe", "cook", "bake"],
  };

  function pasteOnlyTrigger(item: EverydayUseItem): string | null {
    const intent = route(item).intent;
    const triggers = CASCADE_TRIGGERS[intent];
    if (triggers === undefined || !item.hasPastedContent) {
      return null;
    }
    const ask = (item.userInput.split("\n")[0] ?? "").toLowerCase();
    const whole = item.userInput.toLowerCase();
    return triggers.find((word) => whole.includes(word) && !ask.includes(word)) ?? null;
  }

  it("still routes turns on words found only inside the paste", () => {
    const affected = EVERYDAY_USE_CORPUS.filter((item) => pasteOnlyTrigger(item) !== null).map(
      (item) => `${item.id}:${route(item).intent}:${pasteOnlyTrigger(item) ?? ""}`,
    );
    // Pinned as CURRENT behaviour, not asserted as correct. Scoping the cascade
    // to the ask window should empty this list.
    expect(affected.sort()).toEqual([
      // A landlord's letter contains "your current lease term", so RESEARCH_RE —
      // the highest-precedence branch in the cascade — routes the turn to the
      // research treatment on a model with no web access.
      "legal-rent-increase:research:current",
      // "Per my last email" in the pasted draft.
      "rewrite-03:writing:email",
      // The school letter's own "we write to advise".
      "school-letter-esl-parent:writing:write",
      // "ill message him" inside a group chat, overriding a correct `brief` shape.
      "summarise-01:writing:message",
    ]);
  });
});

/**
 * The instruction this sweep cannot route.
 *
 * Every turn also carries the on-device system prompt, which is not per-turn and
 * so never appears in any hint measured above. It contains its own development
 * directive. Anyone who closes every `no-elaboration-hint` gap and reads that as
 * "the posture is now direct" will be wrong, because the strongest elaboration
 * instruction we ship is in a file this sweep does not route.
 *
 * Pinned so it cannot be forgotten, and so changing it is deliberate.
 */
describe("everyday-use sweep — the system prompt is not routed", () => {
  it("still instructs development on every turn, independent of intent", () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain("add the context, reasons, or practical details");
    expect(prompt).toContain("deserves a thorough, well-developed reply");
    // And it is invisible to the marker set the per-turn checks use.
    expect(ELABORATION_MARKERS.filter((m) => prompt.toLowerCase().includes(m))).toEqual([]);
  });
});

/**
 * The n-gram ban routing cannot reach.
 *
 * `candidate/lfm2.5-350m-onnx` — the model every first-time user's first answer
 * comes from — carries `noRepeatNgramSize` as a BASE setting, so it applies on all
 * seven intents. No routing change can lift it, which is exactly why the per-item
 * faithfulness check is scoped to the bans routing arms: blaming routing for this
 * would make that check a constant no fix could ever satisfy.
 *
 * Deliberately not fixed. Removing it risks runaway repetition on the loopiest
 * model we ship, and every loop guard the pinned Transformers.js offers is
 * prompt-inclusive — there is no presence_penalty and no min_p to fall back on.
 * Settling it needs a measured A/B against a real loaded model on real hardware.
 * Pinned so the deferral stays a decision rather than an oversight.
 */
describe("everyday-use sweep — the starter model's base n-gram ban (deferred)", () => {
  it("still applies on every intent, so every first answer is copy-blocked", () => {
    const starter = "candidate/lfm2.5-350m-onnx";
    expect(CATALOG_MODEL_IDS).toContain(starter);
    for (const intent of INTENT_ORDER) {
      expect(
        getGenerationProfile(intent, true, starter).noRepeatNgramSize,
        `${intent} no longer bans n-grams on the starter — if that was measured, say so and delete this test`,
      ).not.toBeUndefined();
    }
  });
});
