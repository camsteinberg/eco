// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The everyday-use routing sweep — does the router set the model up to give this
 * person the answer they came for, or the one that makes them leave?
 *
 * THE BAR. Eco is judged on whether a non-technical person can switch to it —
 * or use an assistant for the first time — without losing the use cases that make
 * AI genuinely helpful. Every other suite in this repo asks whether a mechanism
 * behaves as designed. This one asks whether the design serves the person, using
 * forty jobs real people bring and the response that would make each of them give
 * up (`fixtures/everyday-use-corpus.ts`).
 *
 * WHAT IT MEASURES. The host decides three things before a token is generated,
 * and each maps to a whole class of bounce condition:
 *
 *   1. THE HINT appended to the user's turn. "Lead with a plain-language
 *      explanation, then develop the details that matter — reasons, examples,
 *      practical implications" is good advice for a question about a concept and
 *      a description of the failure mode for someone who pasted an email and
 *      asked for it to sound less annoyed.
 *   2. THE TOKEN BUDGET. A ceiling, not a target — but it is the only hard lever
 *      the host holds, and a one-word follow-up granted two thousand tokens is a
 *      statement about what we think they asked for.
 *   3. THE SAMPLING CONTROLS. `noRepeatNgramSize` is banned across the FULL
 *      sequence by Transformers.js, prompt included, so it forbids the model from
 *      reusing spans of the user's own text — on the exact turns whose entire
 *      requirement is reusing the user's own text.
 *
 * WHAT IT DOES NOT MEASURE. Whether the generated answer is any good. That needs
 * a loaded model on real hardware. This sweep measures the conditions we hand the
 * model, which is the part that is deterministic, cheap, and currently wrong.
 *
 * ★ HOW TO USE IT WHEN IT FAILS. `KNOWN_GAPS` records where today's routing
 * disagrees with the corpus, each entry pinned to the CURRENT value. A gap
 * closing fails this test on purpose — delete the entry, do not relax it. And
 * never edit a corpus expectation to go green: the corpus is a statement about
 * people, and it does not change because our code changed.
 */

import { describe, it, expect } from "vitest";

import {
  buildHintedUserTurn,
  getGenerationProfile,
  inferTurnIntent,
  type ChatIntent,
} from "../lib/chat-intent";
import { inferAnswerShape, type AnswerShape } from "../lib/answer-shape";
import { getCatalog } from "../local-ai/catalog/catalog";
import { PREFERRED_DEFAULT_MODEL_ID } from "../local-ai/selection/recommend";
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

/**
 * Budget assertions run against the everyday default. They are deliberately NOT
 * run against every model: `local/qwen3-0.6b` caps at 512 and
 * `candidate/lfm2.5-350m-onnx` at 384 for every intent, so on those the budget
 * question is settled by the model's own ceiling and tells us nothing about
 * routing. Faithfulness IS checked on every model, because that defect varies by
 * model and the starter is where every first-time user lands.
 */
const BUDGET_MODEL = PREFERRED_DEFAULT_MODEL_ID;

/** The top of the direct band — the `quick` budget, the only band below the middle. */
const DIRECT_BAND_MAX_TOKENS = 1024;

/**
 * Phrases that instruct the model to DEVELOP rather than deliver. Matched against
 * the rendered turn rather than against an intent name, so the assertion survives
 * both re-routing and re-wording of the hints: what matters is whether the person
 * asking for a rewritten email is told to include sections and tradeoffs, not
 * which enum member carried the instruction.
 */
const ELABORATION_MARKERS: readonly string[] = [
  "develop the details",
  "clear sections",
  "tradeoffs",
  "reasons, examples",
];

type Routing = {
  readonly shape: AnswerShape;
  readonly intent: ChatIntent;
  readonly maxTokens: number;
  readonly renderedTurn: string;
  /** The elaboration markers present in the rendered turn. Empty is the goal. */
  readonly elaborationMarkers: readonly string[];
  /** Catalog models that apply a prompt-inclusive n-gram ban at this intent. */
  readonly ngramBanningModels: readonly string[];
};

function route(item: EverydayUseItem): Routing {
  const prior = hasPriorTurns(item.id);
  const intent = inferTurnIntent(item.userInput, prior);
  const renderedTurn = buildHintedUserTurn(item.userInput, intent, true, BUDGET_MODEL);
  return {
    shape: inferAnswerShape(item.userInput, { hasPriorTurns: prior }),
    intent,
    maxTokens: getGenerationProfile(intent, true, BUDGET_MODEL).maxTokens,
    renderedTurn,
    elaborationMarkers: ELABORATION_MARKERS.filter((marker) =>
      renderedTurn.toLowerCase().includes(marker),
    ),
    ngramBanningModels: CATALOG_MODEL_IDS.filter(
      (modelId) => getGenerationProfile(intent, true, modelId).noRepeatNgramSize != null,
    ),
  };
}

/** The four checks, one per routing need. `null` = the need is met. */
const CHECKS = {
  "no-elaboration-hint": (r: Routing) =>
    r.elaborationMarkers.length === 0
      ? null
      : `rendered turn instructs elaboration (${r.elaborationMarkers.join(", ")}) via intent "${r.intent}"`,
  "direct-budget": (r: Routing) =>
    r.maxTokens <= DIRECT_BAND_MAX_TOKENS
      ? null
      : `budget ${String(r.maxTokens)} is above the direct band (${String(DIRECT_BAND_MAX_TOKENS)}) via intent "${r.intent}"`,
  "faithful-reproduction": (r: Routing) =>
    r.ngramBanningModels.length === 0
      ? null
      : `prompt-inclusive n-gram ban applies on ${r.ngramBanningModels.join(", ")} at intent "${r.intent}"`,
  "allows-development": (r: Routing) =>
    r.maxTokens > DIRECT_BAND_MAX_TOKENS
      ? null
      : `budget ${String(r.maxTokens)} flattens a multi-part answer into the brief register via intent "${r.intent}"`,
} as const;

/** `need/item-id`. */
type GapKey = `${keyof typeof CHECKS}/${string}`;

function checkOf(need: keyof typeof CHECKS, item: EverydayUseItem): string | null {
  return CHECKS[need](route(item));
}

// ---------------------------------------------------------------------------
// Where today's routing disagrees with the corpus.
//
// The fifty-two failures below are not fifty-two bugs. They are eight mechanisms,
// so they are recorded as eight mechanisms — that is what makes the list
// actionable: fixing one closes a whole block, and a block that does not close
// means the mechanism was misdiagnosed.
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
    "examples, practical implications'. That is good advice for a question about a",
    "concept, and a description of the failure mode for the twenty-odd items here that",
    "asked for an artifact or a verdict. This is the posture flip, and it is the single",
    "biggest block on the list.",
  ].join(" "),

  "long-form-bare-long": [
    "`LONG_FORM_RE` (answer-shape.ts) matches the bare word 'long', and `inferChatIntent`",
    "tests it before consulting the shape, so 'how long do you boil eggs' is read as a",
    "request for a long answer and routed to `deep` at 2048 tokens with the sections-and-",
    "tradeoffs hint. The shape classifier had it right — it called this `brief` — and was",
    "overruled by a one-word regex.",
  ].join(" "),

  "cascade-beats-brief-shape": [
    "`inferChatIntent` tests the task-class regexes (RESEARCH_RE, CODE_RE, WRITING_RE,",
    "LONG_FORM_RE, DEEP_RE) BEFORE it consults the answer shape, so a turn the shape",
    "classifier correctly calls `brief` can still be handed a task-class budget and hint.",
    "Here a group-chat transcript ending in 'tldr' is classified `brief`, then WRITING_RE",
    "matches the word 'message' INSIDE the pasted thread and the turn gets the writing",
    "budget anyway. The classifier that read the user's ask loses to one that read their",
    "paste.",
  ].join(" "),

  "writing-budget-is-middle": [
    "The `writing` intent's budget is the 1536-token middle for every model that has",
    "room for it, whatever the artifact is. A four-line poem, a three-line summary of a",
    "school letter and a full cover letter all get the same ceiling, because the intent",
    "encodes the TASK CLASS and nothing encodes the SIZE of the thing being asked for.",
  ].join(" "),

  "writing-ngram-ban": [
    "★ The `writing` intent sets `noRepeatNgramSize: 4` in its per-intent override on",
    "phi3, qwen3-0.6b, qwen3.5-2b and the 350M starter, and Transformers.js bans n-grams",
    "across the FULL sequence including the prompt. So on the one task class whose entire",
    "requirement is faithfulness, the model is forbidden from reusing any four-token span",
    "of the user's own text. A 2026-06-09 audit removed this from the base setting of one",
    "model and missed every per-intent override — the documented corruption class",
    "('332,026', 'capital ofFrance') is what the user sees when it fires.",
  ].join(" "),

  "starter-base-ngram-DEFERRED": [
    "The 350M starter carries `noRepeatNgramSize: 3` as a BASE setting, so it applies on",
    "every intent — and every first-time user's first answer comes from that model. This",
    "one is deliberately NOT fixed here. Removing it risks runaway repetition on the",
    "loopiest model we ship, and the only loop guards available in the pinned",
    "Transformers.js are prompt-inclusive: there is no presence_penalty and no min_p to",
    "fall back on. Settling it needs a measured A/B against a real loaded model on real",
    "hardware. Until that runs, this block stays pinned deliberately.",
  ].join(" "),

  "plurality-to-teaching": [
    "`PLURALITY_RE` treats 'ideas for', 'tips on', 'ways to' as teaching signals, so",
    "'gift ideas for my dad' routes to `deep` with the sections-and-tradeoffs hint. Asking",
    "for a list of options is not asking to be taught about the space of options — and",
    "this item's bounce condition is literally 'twenty vague options instead of eight",
    "good ones'.",
  ].join(" "),
} as const;

type GapMechanism = keyof typeof GAP_MECHANISMS;

const KNOWN_GAPS: ReadonlyMap<GapKey, GapMechanism> = new Map<GapKey, GapMechanism>([
  ["no-elaboration-hint/work-email-tone-fix", "shape-length-catchall"],
  ["faithful-reproduction/work-email-tone-fix", "starter-base-ngram-DEFERRED"],
  ["no-elaboration-hint/work-followup-shorter", "explain-default-middle"],
  ["direct-budget/work-followup-shorter", "explain-default-middle"],
  ["faithful-reproduction/work-followup-shorter", "starter-base-ngram-DEFERRED"],
  ["direct-budget/rewrite-03", "writing-budget-is-middle"],
  ["faithful-reproduction/rewrite-03", "writing-ngram-ban"],
  ["no-elaboration-hint/sw-15", "shape-length-catchall"],
  ["faithful-reproduction/sw-15", "starter-base-ngram-DEFERRED"],
  ["no-elaboration-hint/school-essay-not-ai", "shape-length-catchall"],
  ["faithful-reproduction/school-essay-not-ai", "starter-base-ngram-DEFERRED"],
  ["direct-budget/work-sick-text", "explain-default-middle"],
  ["no-elaboration-hint/family-eulogy", "explain-default-middle"],
  ["direct-budget/ft-06", "writing-budget-is-middle"],
  ["no-elaboration-hint/health-blood-results", "explain-default-middle"],
  ["direct-budget/health-blood-results", "explain-default-middle"],
  ["no-elaboration-hint/health-hospital-letter", "shape-length-catchall"],
  ["faithful-reproduction/health-hospital-letter", "starter-base-ngram-DEFERRED"],
  ["direct-budget/school-letter-esl-parent", "writing-budget-is-middle"],
  ["faithful-reproduction/school-letter-esl-parent", "writing-ngram-ban"],
  ["faithful-reproduction/legal-rent-increase", "starter-base-ngram-DEFERRED"],
  ["direct-budget/summarise-01", "cascade-beats-brief-shape"],
  ["faithful-reproduction/summarise-01", "writing-ngram-ban"],
  ["no-elaboration-hint/school-fractions", "explain-default-middle"],
  ["direct-budget/school-fractions", "explain-default-middle"],
  ["no-elaboration-hint/factual-01", "long-form-bare-long"],
  ["direct-budget/factual-01", "long-form-bare-long"],
  ["no-elaboration-hint/factual-02", "explain-default-middle"],
  ["no-elaboration-hint/decide-01", "explain-default-middle"],
  ["no-elaboration-hint/money-insurance-jump", "explain-default-middle"],
  ["no-elaboration-hint/ft-14", "explain-default-middle"],
  ["no-elaboration-hint/money-budget-house", "explain-default-middle"],
  ["no-elaboration-hint/excel-sumif", "explain-default-middle"],
  ["direct-budget/excel-sumif", "explain-default-middle"],
  ["no-elaboration-hint/sw-13", "explain-default-middle"],
  ["faithful-reproduction/sw-13", "starter-base-ngram-DEFERRED"],
  ["no-elaboration-hint/food-fridge-dinner", "explain-default-middle"],
  ["no-elaboration-hint/ideas-01", "plurality-to-teaching"],
  ["no-elaboration-hint/family-text-thread", "explain-default-middle"],
  ["direct-budget/family-text-thread", "explain-default-middle"],
  ["no-elaboration-hint/company-01", "explain-default-middle"],
  ["direct-budget/company-01", "explain-default-middle"],
  ["no-elaboration-hint/company-02", "explain-default-middle"],
  ["direct-budget/company-02", "explain-default-middle"],
  ["no-elaboration-hint/translate-01", "explain-default-middle"],
  ["direct-budget/translate-01", "explain-default-middle"],
  ["no-elaboration-hint/translate-02", "shape-length-catchall"],
  ["direct-budget/translate-02", "shape-length-catchall"],
  ["no-elaboration-hint/ft-04", "explain-default-middle"],
  ["direct-budget/ft-04", "explain-default-middle"],
  ["no-elaboration-hint/ft-13", "explain-default-middle"],
  ["direct-budget/ft-13", "explain-default-middle"],
]);

// ---------------------------------------------------------------------------
// Integrity — the instrument itself
// ---------------------------------------------------------------------------

describe("everyday-use sweep — the instrument", () => {
  it("covers forty jobs across every category the authors identified", () => {
    expect(EVERYDAY_USE_CORPUS.length).toBe(40);
    expect(new Set(EVERYDAY_USE_CORPUS.map((i) => i.category)).size).toBeGreaterThanOrEqual(9);
  });

  it("derives a routing need, with its justification, for every item", () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const entry = needsFor(item.id);
      expect(entry.needs.length, `${item.id} has no derived need`).toBeGreaterThan(0);
      // A justification has to quote the item; a one-liner is a guess.
      expect(entry.why.length, `${item.id} justification is too thin`).toBeGreaterThan(60);
    }
    // No orphans in the derived layer.
    const corpusIds = new Set(EVERYDAY_USE_CORPUS.map((i) => i.id));
    for (const id of Object.keys(ROUTING_NEEDS)) {
      expect(corpusIds.has(id), `${id} is derived but not in the corpus`).toBe(true);
    }
  });

  it("keeps the two budget needs mutually exclusive", () => {
    for (const item of EVERYDAY_USE_CORPUS) {
      const { needs } = needsFor(item.id);
      expect(
        needs.includes("direct-budget") && needs.includes("allows-development"),
        `${item.id} cannot be both direct and developed`,
      ).toBe(false);
    }
  });

  it("carries a real counterweight, so the corpus is not satisfiable by shortening everything", () => {
    expect(itemsNeeding("allows-development").length).toBeGreaterThanOrEqual(5);
    expect(itemsNeeding("faithful-reproduction").length).toBeGreaterThanOrEqual(8);
  });

  it("measures against models a user can actually be served", () => {
    expect(CATALOG_MODEL_IDS).toContain(BUDGET_MODEL);
    expect(CATALOG_MODEL_IDS.length).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// The fact layer: today's routing, pinned exactly.
// ---------------------------------------------------------------------------

/**
 * Everything above this point rests on a judgement — our reading of what each
 * bounce condition demands. That reading is arguable, which is exactly why it
 * lives in its own layer. But a yardstick made only of judgements can be moved
 * by changing the judgement, so the two snapshots below contain none.
 *
 * They are simply what the router does today, recorded so that any behaviour
 * change shows up as a readable diff naming the rows that moved. Use them when
 * reviewing a routing change: the checks above say whether a fix helped; these
 * say what it actually DID — including to the thirty-nine items it was not
 * aimed at. A moved row is not a failure. It is a change someone has to look at.
 */
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
  "factual-01": { intent: "deep", maxTokens: 2048, temperature: 0.6, hint: "Use clear sections; include concrete recommendations and tradeoffs." },
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
    "quick:1024/0.2 explain:1024/0.38 deep:1024/0.45 code:1024/0.18 writing:1024/0.44/n4 file:1024/0.45 research:1024/0.45",
  "local/qwen3-0.6b":
    "quick:512/0.32 explain:512/0.42 deep:512/0.6 code:512/0.2 writing:512/0.48/n4 file:512/0.6 research:512/0.6",
  "candidate/lfm2.5-1.2b-instruct-onnx":
    "quick:1024/0.2 explain:1536/0.3 deep:2048/0.3 code:2048/0.2 writing:1536/0.4 file:2048/0.3 research:2048/0.3",
  "candidate/lfm2.5-350m-onnx":
    "quick:384/0.25/n3 explain:384/0.45/n3 deep:384/0.45/n3 code:384/0.45/n3 writing:384/0.38/n4 file:384/0.45/n3 research:384/0.45/n3",
  "candidate/qwen3.5-2b-onnx":
    "quick:1024/0.32 explain:1536/0.42 deep:2048/0.6 code:2048/0.2 writing:1536/0.48/n4 file:2048/0.6 research:2048/0.6",
  "candidate/gemma-4-e2b-litert":
    "quick:256/0.18 explain:768/0.3 deep:1536/0.42 code:1024/0.18 writing:1024/0.45 file:1536/0.45 research:1536/0.45",
  "candidate/qwen2.5-0.5b-mlc":
    "quick:1024/0.45 explain:1536/0.55 deep:2048/0.55 code:2048/0.25 writing:1536/0.75 file:2048/0.4 research:2048/0.35",
};

const INTENT_ORDER: readonly ChatIntent[] = [
  "quick",
  "explain",
  "deep",
  "code",
  "writing",
  "file",
  "research",
];

describe("everyday-use sweep — today's routing, pinned exactly", () => {
  for (const item of EVERYDAY_USE_CORPUS) {
    it(`routes ${item.id} unchanged`, () => {
      const routing = route(item);
      const hint =
        routing.renderedTurn === item.userInput
          ? ""
          : routing.renderedTurn.slice(item.userInput.length + 2);
      expect({
        intent: routing.intent,
        maxTokens: routing.maxTokens,
        temperature: getGenerationProfile(routing.intent, true, BUDGET_MODEL).temperature,
        hint,
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
// The four properties
// ---------------------------------------------------------------------------

const NEED_DESCRIPTIONS: Record<keyof typeof CHECKS, string> = {
  "no-elaboration-hint": "asks for an artifact or a verdict, so is not told to elaborate",
  "direct-budget": "is bounded in length, so routes inside the direct band",
  "faithful-reproduction":
    "must give the user's own words back, so carries no prompt-inclusive n-gram ban",
  "allows-development": "has a multi-part answer, so keeps room above the direct band",
};

for (const need of Object.keys(CHECKS) as (keyof typeof CHECKS)[]) {
  describe(`everyday-use sweep — ${NEED_DESCRIPTIONS[need]}`, () => {
    const scoped = itemsNeeding(need);
    const live = scoped.filter((item) => !KNOWN_GAPS.has(`${need}/${item.id}`));

    if (live.length === 0) {
      // Every item carrying this need is currently pinned as a gap. Say so out
      // loud rather than presenting an empty block as a clean bill of health —
      // and keep the count, so the first item to be fixed shows up here.
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
    for (const [key, mechanism] of KNOWN_GAPS) {
      const [need, id] = key.split("/") as [keyof typeof CHECKS, string];
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
    const cited = new Set(KNOWN_GAPS.values());
    for (const mechanism of Object.keys(GAP_MECHANISMS) as GapMechanism[]) {
      expect(cited.has(mechanism), `${mechanism} explains nothing — delete it`).toBe(true);
    }
  });

  for (const [key] of KNOWN_GAPS) {
    const [need, id] = key.split("/") as [keyof typeof CHECKS, string];
    const item = EVERYDAY_USE_CORPUS.find((i) => i.id === id);
    if (item === undefined) {
      continue;
    }
    // Pinned to today's behaviour, which is the OPPOSITE of what the corpus asks.
    // If this fails, a gap closed: delete the entry rather than "fix" the test.
    it(`still fails ${need} on ${id} (gap)`, () => {
      expect(checkOf(need, item)).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// The headline. One number, so the direction of travel is visible in a diff.
// ---------------------------------------------------------------------------

describe("everyday-use sweep — the headline", () => {
  it("records how many of the forty are routed against their own bounce condition", () => {
    const failing = EVERYDAY_USE_CORPUS.filter((item) =>
      needsFor(item.id).needs.some((need) => checkOf(need, item) !== null),
    );
    // Pinned at today's measurement. Moving this number is the whole point of the
    // routing work: lower it and this test fails, which is the signal to update it
    // deliberately rather than let an improvement pass unremarked.
    expect(failing.length).toBe(31);
  });
});

// ---------------------------------------------------------------------------
// One more thing the sweep found, which none of the four checks catches.
// ---------------------------------------------------------------------------

/**
 * A heuristic that reads the PASTE instead of the ASK.
 *
 * This is the same defect class an earlier sweep found in the grounding tool,
 * where eleven of thirty-three realistic inputs fired an outbound lookup because
 * a matcher read the whole turn rather than the question in it. The fix there was
 * to scope matching to the ask window. The intent cascade was never given that
 * treatment, and it sits at the top of routing.
 *
 * Two live instances, both from the corpus:
 *   - a landlord's rent-increase letter contains "your current lease term", so
 *     RESEARCH_RE matches "current" and the turn is routed `research` — the
 *     highest-precedence branch in the cascade — on a model with no web access.
 *   - a group-chat transcript contains "ill message him", so WRITING_RE matches
 *     "message" and overrides a correct `brief` shape.
 *
 * Pinned as current behaviour, not asserted as correct. It is recorded here so
 * that scoping the cascade to the ask window has a test waiting for it.
 */
describe("everyday-use sweep — the intent cascade reads pasted content", () => {
  const cases = [
    { id: "legal-rent-increase", intent: "research", word: "current" },
    { id: "summarise-01", intent: "writing", word: "message" },
  ] as const;

  for (const { id, intent, word } of cases) {
    const item = EVERYDAY_USE_CORPUS.find((i) => i.id === id);
    if (item === undefined) {
      continue;
    }
    it(`still routes ${id} on "${word}" found inside the paste`, () => {
      // The matched word is in the pasted body, not in what the user asked.
      const ask = item.userInput.split("\n")[0] ?? "";
      expect(item.userInput.toLowerCase()).toContain(word);
      expect(ask.toLowerCase()).not.toContain(word);
      expect(route(item).intent).toBe(intent);
    });
  }

  it("covers both cases (guards the lookup above)", () => {
    const found = cases.filter(({ id }) => EVERYDAY_USE_CORPUS.some((i) => i.id === id));
    expect(found.length).toBe(cases.length);
  });
});
