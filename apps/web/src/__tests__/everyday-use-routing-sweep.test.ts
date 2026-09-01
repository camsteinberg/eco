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
 *   1. THE TOKEN BUDGET. A ceiling, not a target — and on the everyday default
 *      only `quick` sits below 1536, so a budget assertion here is an intent
 *      assertion wearing a length label. Kept in budget terms because the budget
 *      is what reaches the runtime; not to be read as independent of intent.
 *   2. THE SAMPLING CONTROLS. `noRepeatNgramSize` is banned across the FULL
 *      sequence by Transformers.js, prompt included, so it forbids the model from
 *      reusing spans of the user's own text — on the exact turns whose entire
 *      requirement is reusing the user's own text.
 *   3. THE SYSTEM PROMPT, which this sweep does NOT route and cannot vary per
 *      turn.
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
 *   what its name says.
 *
 * ★ A COUNTERWEIGHT CAN GO VACUOUS WITHOUT ANYONE TOUCHING IT. Both n-gram
 * measures here degenerated into constants not through an edit to this file but
 * because a PR elsewhere removed the last intent-specific n-gram overrides. A
 * check whose sensitivity rests on a fact about other code must PIN THAT FACT,
 * or its green means "the world stopped being measurable" rather than "we are
 * fine". `MODELS_TIGHTENING_BANS_BY_INTENT` and the two `direct-budget`
 * degeneracy pins exist for exactly that reason.
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
import { checkSourceCitations } from "./helpers/source-citations";
import { isTextRepairAsk } from "../lib/ask-text";

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


type Routing = {
  readonly shape: AnswerShape;
  readonly intent: ChatIntent;
  readonly maxTokens: number;
  /**
   * Every catalog model whose profile arms a prompt-inclusive n-gram ban at THIS
   * turn's routed intent, with the ban size — i.e. what this turn actually meets
   * on each model a user can be served.
   */
  readonly ngramBanningModels: readonly string[];
};

/**
 * The prompt-inclusive n-gram ban size this model applies at this intent, or
 * `undefined` for no ban. Smaller is stricter: with `noRepeatNgramSize` of n the
 * model may reuse at most n-1 consecutive tokens of the user's own text.
 */
function ngramSizeAt(intent: ChatIntent, modelId: string): number | undefined {
  return getGenerationProfile(intent, true, modelId).noRepeatNgramSize;
}

function route(item: EverydayUseItem): Routing {
  const prior = hasPriorTurns(item.id);
  const intent = inferTurnIntent(item.userInput, prior);
  return {
    shape: inferAnswerShape(item.userInput, { hasPriorTurns: prior }),
    intent,
    maxTokens: getGenerationProfile(intent, true, BUDGET_MODEL).maxTokens,
    ngramBanningModels: CATALOG_MODEL_IDS.filter(
      (modelId) => ngramSizeAt(intent, modelId) != null,
    ),
  };
}

/** The checks, one per routing need. `null` = the need is met. */
const CHECKS = {
  "direct-budget": (r: Routing) =>
    r.maxTokens <= DIRECT_BAND_MAX_TOKENS
      ? null
      : `budget ${String(r.maxTokens)} is above the direct band (${String(DIRECT_BAND_MAX_TOKENS)}) via intent "${r.intent}"`,
  "faithful-reproduction": (r: Routing) =>
    r.ngramBanningModels.length === 0
      ? null
      : `as routed (intent "${r.intent}") this turn meets a prompt-inclusive n-gram ban on ${r.ngramBanningModels
          .map((m) => `${m} (n=${String(ngramSizeAt(r.intent, m) ?? 0)})`)
          .join(", ")} — the model may reuse at most n-1 consecutive tokens of the user's own words`,
} as const;

type Need = keyof typeof CHECKS;
type GapKey = `${Need}/${string}`;

function checkOf(need: string, item: EverydayUseItem): string | null {
  const check = (CHECKS as Record<string, ((r: Routing) => string | null) | undefined>)[need];
  return check ? check(route(item)) : null;
}

type NgramExposure = {
  /**
   * How many corpus turns reach a prompt-inclusive n-gram ban, per model, at the
   * intent each turn is actually routed to.
   */
  readonly banned: Readonly<Record<string, number>>;
  /**
   * The part ROUTING is answerable for: `item:model` pairs where the routed
   * intent bans where `quick` would not, or bans more strictly than `quick`
   * does. `quick` is the no-treatment baseline, so this is "exposure that exists
   * because of where we sent the turn", as opposed to exposure the model applies
   * to everything regardless.
   */
  readonly armedByRouting: readonly string[];
};

/**
 * The aggregate the per-item checks cannot see, as a structure rather than a
 * count.
 *
 * IT USED TO BE ONE NUMBER, and the number was 40 under every one of the seven
 * intents — a constant wearing the word "ceiling". It was built to catch a real
 * corpus-wide harm: the cheapest way to close the biggest per-item block is to
 * push turns off `explain`, which lands them on `writing`, and `writing` used to
 * carry an n-gram override on three models. Once those overrides came off, ban
 * membership stopped varying with intent at all, so summing it produced the same
 * total no matter what routing did.
 *
 * Split in two, because those were always two different questions:
 *   - `banned` is a FACT — what the corpus meets today, per model. Keyed by
 *     model so a newly-banning model appears as a new key instead of hiding
 *     inside a total that another model's improvement cancelled out.
 *   - `armedByRouting` is the COUNTERWEIGHT, and it is a list, not a count.
 */
function ngramExposure(): NgramExposure {
  const banned: Record<string, number> = {};
  const armedByRouting: string[] = [];
  for (const item of EVERYDAY_USE_CORPUS) {
    const intent = inferTurnIntent(item.userInput, hasPriorTurns(item.id));
    for (const modelId of CATALOG_MODEL_IDS) {
      const routed = ngramSizeAt(intent, modelId);
      if (routed == null) {
        continue;
      }
      banned[modelId] = (banned[modelId] ?? 0) + 1;
      const baseline = ngramSizeAt("quick", modelId);
      if (baseline == null || routed < baseline) {
        armedByRouting.push(`${item.id}:${modelId}`);
      }
    }
  }
  return { banned, armedByRouting: armedByRouting.sort() };
}

/**
 * Today's exposure, per model. Was 58 across three models before the `writing`
 * n-gram overrides came off phi3, qwen3-0.6b and the shipping default, then 40 —
 * the starter's, whose ban was BASE and so applied at every intent.
 *
 * EMPTY IS THE REAL VALUE, not a disabled check. The starter's ban came off both
 * layers once a real-model A/B settled it, and no catalog model bans n-grams
 * anywhere now. A model that starts banning appears here as a new key.
 */
const NGRAM_EXPOSURE_TODAY: Readonly<Record<string, number>> = {};

/**
 * ★ THE PRECONDITION `armedByRouting` DEPENDS ON, pinned so it cannot quietly
 * stop holding.
 *
 * `armedByRouting` can only ever be non-empty for a model that bans n-grams more
 * strictly at some intent than it does at `quick`. No catalog model does today,
 * so the counterweight is ASLEEP: it reads green because nothing intent-specific
 * exists to catch, not because a routing change was checked and cleared.
 *
 * That is precisely how its predecessor died. Three models carried a `writing`
 * override; a PR removed all three for good reasons; the aggregate silently
 * became a constant and kept reporting green for two more PRs. Nothing in this
 * file mentioned that its sensitivity rested on a fact in
 * `local-model-generation-profiles.ts`. Now it does, in both directions — adding
 * an intent-specific ban wakes the counterweight and fails here, and removing
 * the last one puts it back to sleep and fails here too.
 */
const MODELS_TIGHTENING_BANS_BY_INTENT: readonly string[] = [];

function modelsTighteningBansByIntent(): readonly string[] {
  return CATALOG_MODEL_IDS.filter((modelId) => {
    const baseline = ngramSizeAt("quick", modelId);
    return INTENT_ORDER.some((intent) => {
      const n = ngramSizeAt(intent, modelId);
      return n != null && (baseline == null || n < baseline);
    });
  });
}

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
  // `shape-length-catchall` lived here and is deliberately gone. It described
  // `inferAnswerShape` returning `teaching` for any turn over 360 characters
  // (answer-shape.ts LONG_ASK_MIN_CHARS) and `mapShapeToDepthIntent` sending
  // teaching to `deep` — so pasting anything longer than a paragraph was read
  // as a request for a lecture and came back with "Use clear sections; include
  // concrete recommendations and tradeoffs". It explained fourteen gaps, more
  // than any other mechanism in this file.
  //
  // It explains none of them now, because the cascade no longer measures the
  // paste: `inferChatIntent` classifies `instructionParagraph` (lib/ask-text.ts),
  // so the length that reaches the shape classifier is the length of the ASK.
  // Deleted rather than kept as history, per the test below. What it described
  // is now pinned two ways — `lib/__tests__/paste-ask-routing.test.ts` for the
  // routing, and the `[]`-anchored paste-trigger block at the end of this file.
  //
  // ★ The gaps it explained did not all close. Nine did; the rest MOVED to
  // `writing-budget-is-middle` or `explain-default-middle` and are still listed
  // below at their new intents. The budget path still cannot see a length bound
  // — that was always a second mechanism stacked under the first, and removing
  // the first is what made it the only one left.

  "explain-default-middle": [
    "Nothing in the cascade matches and `inferAnswerShape` (answer-shape.ts) returns",
    "`uncertain` or `focused`, both of which `mapShapeToDepthIntent` (chat-intent.ts) maps",
    "to the default middle: `explain`, 1536 tokens. This is where turns land when",
    "nothing fired — the default bucket.",
  ].join(" "),

  // `long-form-bare-long` lived here and is deliberately gone: LONG_FORM_RE and
  // DEEP_RE no longer match bare words, so the mechanism explains no remaining
  // gap and the test below requires it to be deleted rather than kept as
  // history. What it described is now pinned as a standing net in
  // `lib/__tests__/depth-word-routing.test.ts`, against the corpus that measured
  // it: 53 of 53 ordinary turns containing a depth word routed to `deep`, now 5.

  // `cascade-beats-brief-shape` lived here and is deliberately gone. Its text
  // described WRITING_RE matching the word 'message' INSIDE a pasted group-chat
  // thread and overruling a correct `brief` shape — exactly what the WRITING_RE
  // narrowing killed. `direct-budget/summarise-01` was its only citation, and
  // that gap closed with it: the turn now routes `quick` at 1024, which is the
  // shape classifier's own reading finally reaching the budget. Deleted rather
  // than re-pointed at another item, per the test below.

  "writing-budget-is-middle": [
    "The `writing` intent's budget is the 1536-token middle for every model with room",
    "for it, whatever the artifact is — `getLocalMaxTokens` (chat-intent.ts) keys its",
    "baseline and smart tables on the intent alone. A four-line poem, a three-line summary",
    "of a school letter and a full cover letter all get the same ceiling, because the",
    "intent encodes the TASK CLASS and nothing encodes the SIZE of the thing asked for.",
  ].join(" "),

  "plurality-to-teaching": [
    "`PLURALITY_RE` treats 'ideas for', 'tips on', 'ways to' as teaching signals, so",
    "'gift ideas for my dad' routes to `deep` (2048 tokens).",
    "Asking for a list of options is not asking to be taught about the space of options",
    "— and this item's bounce condition is literally 'twenty vague options instead of",
    "eight good ones'.",
  ].join(" "),

  "brevity-misses-the-budget": [
    "The user gave an explicit brevity instruction but nothing carried it to the BUDGET.",
    "`getGenerationProfile` (chat-intent.ts) takes no content parameter at all, so the",
    "budget path cannot see the user's words. 'keep it short and dont make it weird'",
    "still gets the 1536-token middle.",
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
    ["direct-budget/work-email-tone-fix", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/work-followup-shorter", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/rewrite-03", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/sw-15", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/school-essay-not-ai", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/work-sick-text", { mechanism: "brevity-misses-the-budget", intent: "explain" }],
    ["direct-budget/draft-01", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/admin-gym-cancellation", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/ft-06", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/health-blood-results", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/school-letter-esl-parent", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/explain-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/school-fractions", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/decide-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/money-insurance-jump", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/money-budget-house", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/excel-sumif", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/sw-13", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/food-fridge-dinner", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/ideas-01", { mechanism: "plurality-to-teaching", intent: "deep" }],
    ["direct-budget/family-text-thread", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/company-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/company-02", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/translate-01", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/ft-04", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/ft-13", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/proofread-teacher-note-esl", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/proofread-birthday-caption", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/proofread-memorial-tribute", { mechanism: "explain-default-middle", intent: "explain" }],
    ["direct-budget/proofread-grandfather-letter", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/proofread-vet-application", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/proofread-crew-email", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/proofread-review-reply", { mechanism: "writing-budget-is-middle", intent: "writing" }],
    ["direct-budget/proofread-marketplace-ad", { mechanism: "brevity-misses-the-budget", intent: "writing" }],
    ["direct-budget/proofread-school-post", { mechanism: "writing-budget-is-middle", intent: "writing" }],
  ]);

// ---------------------------------------------------------------------------
// The fact layer: today's routing, pinned exactly.
// ---------------------------------------------------------------------------

const ROUTING_TODAY: Readonly<
  Record<string, { intent: ChatIntent; maxTokens: number }>
> = {
  "work-email-tone-fix": { intent: "writing", maxTokens: 1536 },
  "work-followup-shorter": { intent: "explain", maxTokens: 1536 },
  "rewrite-03": { intent: "writing", maxTokens: 1536 },
  "sw-15": { intent: "writing", maxTokens: 1536 },
  "school-essay-not-ai": { intent: "writing", maxTokens: 1536 },
  "work-sick-text": { intent: "explain", maxTokens: 1536 },
  "draft-01": { intent: "writing", maxTokens: 1536 },
  "admin-gym-cancellation": { intent: "writing", maxTokens: 1536 },
  "family-eulogy": { intent: "explain", maxTokens: 1536 },
  "ft-06": { intent: "writing", maxTokens: 1536 },
  "health-blood-results": { intent: "explain", maxTokens: 1536 },
  "health-hospital-letter": { intent: "explain", maxTokens: 1536 },
  "school-letter-esl-parent": { intent: "explain", maxTokens: 1536 },
  "legal-rent-increase": { intent: "explain", maxTokens: 1536 },
  "summarise-01": { intent: "quick", maxTokens: 1024 },
  "explain-01": { intent: "explain", maxTokens: 1536 },
  "school-fractions": { intent: "explain", maxTokens: 1536 },
  "factual-01": { intent: "quick", maxTokens: 1024 },
  "factual-02": { intent: "explain", maxTokens: 1536 },
  "factual-04": { intent: "quick", maxTokens: 1024 },
  "decide-01": { intent: "explain", maxTokens: 1536 },
  "money-insurance-jump": { intent: "explain", maxTokens: 1536 },
  "ft-14": { intent: "explain", maxTokens: 1536 },
  "money-budget-house": { intent: "explain", maxTokens: 1536 },
  "excel-sumif": { intent: "explain", maxTokens: 1536 },
  "sw-13": { intent: "explain", maxTokens: 1536 },
  "food-fridge-dinner": { intent: "explain", maxTokens: 1536 },
  "travel-lisbon-kid": { intent: "explain", maxTokens: 1536 },
  "ideas-01": { intent: "deep", maxTokens: 2048 },
  "family-text-thread": { intent: "explain", maxTokens: 1536 },
  "company-01": { intent: "explain", maxTokens: 1536 },
  "company-02": { intent: "explain", maxTokens: 1536 },
  "translate-01": { intent: "explain", maxTokens: 1536 },
  "translate-02": { intent: "quick", maxTokens: 1024 },
  "ft-01": { intent: "quick", maxTokens: 1024 },
  "ft-04": { intent: "explain", maxTokens: 1536 },
  "ft-08": { intent: "quick", maxTokens: 1024 },
  "ft-13": { intent: "explain", maxTokens: 1536 },
  "sw-12": { intent: "quick", maxTokens: 1024 },
  "ft-15": { intent: "quick", maxTokens: 1024 },
  "proofread-teacher-note-esl": { intent: "writing", maxTokens: 1536 },
  "proofread-birthday-caption": { intent: "writing", maxTokens: 1536 },
  "proofread-memorial-tribute": { intent: "explain", maxTokens: 1536 },
  "proofread-grandfather-letter": { intent: "writing", maxTokens: 1536 },
  "proofread-vet-application": { intent: "writing", maxTokens: 1536 },
  "proofread-crew-email": { intent: "writing", maxTokens: 1536 },
  "proofread-marketplace-ad": { intent: "writing", maxTokens: 1536 },
  "proofread-review-reply": { intent: "writing", maxTokens: 1536 },
  "proofread-school-post": { intent: "writing", maxTokens: 1536 },
};

/**
 * The same facts per model, because the intent alone does not decide what the
 * model receives. Format: `intent:maxTokens[/nNoRepeatNgram]`.
 */
const MODEL_MATRIX_TODAY: Readonly<Record<string, string>> = {
  "local/qwen3-0.6b":
    "quick:512 explain:512 deep:512 code:512 writing:512 file:512 research:512",
  "candidate/lfm2.5-1.2b-instruct-onnx":
    "quick:1024 explain:1536 deep:2048 code:2048 writing:1536 file:2048 research:2048",
  "candidate/lfm2.5-1.2b-instruct-q4-onnx":
    "quick:1024 explain:1536 deep:2048 code:2048 writing:1536 file:2048 research:2048",
  "candidate/lfm2.5-350m-onnx":
    "quick:384 explain:384 deep:384 code:384 writing:384 file:384 research:384",
  "candidate/qwen3.5-2b-onnx":
    "quick:1024 explain:1536 deep:2048 code:2048 writing:1536 file:2048 research:2048",
  // deep/file/research were 1536 until R3a lowered this model's generation
  // ceiling from 2048 to 1024. Its per-intent budget table is unchanged; the
  // ceiling now binds, because 2048 generation against 2048 contextTokens left
  // nothing for the system prompt or history.
  "candidate/gemma-4-e2b-litert":
    "quick:256 explain:768 deep:1024 code:1024 writing:1024 file:1024 research:1024",
  "candidate/qwen2.5-0.5b-mlc":
    "quick:1024 explain:1536 deep:2048 code:2048 writing:1536 file:2048 research:2048",
  "candidate/granite-4.0-350m-onnx":
    "quick:512 explain:512 deep:512 code:512 writing:512 file:512 research:512",
  "candidate/smollm2-360m-instruct-onnx":
    "quick:512 explain:512 deep:512 code:512 writing:512 file:512 research:512",
  "candidate/lfm2-2.6b-onnx":
    "quick:1024 explain:1536 deep:2048 code:2048 writing:1536 file:2048 research:2048",
};

describe("everyday-use sweep — today's routing, pinned exactly", () => {
  for (const item of EVERYDAY_USE_CORPUS) {
    it(`routes ${item.id} unchanged`, () => {
      const routing = route(item);
      expect({
        intent: routing.intent,
        maxTokens: routing.maxTokens,
      }).toEqual(ROUTING_TODAY[item.id]);
    });
  }

  it("hands every catalog model the same budgets as before", () => {
    const actual: Record<string, string> = {};
    for (const modelId of CATALOG_MODEL_IDS) {
      actual[modelId] = INTENT_ORDER.map((intent) => {
        const profile = getGenerationProfile(intent, true, modelId);
        const ngram =
          profile.noRepeatNgramSize != null ? `/n${String(profile.noRepeatNgramSize)}` : "";
        return `${intent}:${String(profile.maxTokens)}${ngram}`;
      }).join(" ");
    }
    expect(actual).toEqual(MODEL_MATRIX_TODAY);
  });
});

// ---------------------------------------------------------------------------
// Integrity — the instrument itself
// ---------------------------------------------------------------------------

describe("everyday-use sweep — the instrument", () => {
  it("covers forty-nine jobs across every category the authors identified", () => {
    expect(EVERYDAY_USE_CORPUS.length).toBe(49);
    expect(new Set(EVERYDAY_USE_CORPUS.map((i) => i.category)).size).toBeGreaterThanOrEqual(9);
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
    expect(total).toBe(113);
  });

  it("carries a counterweight, so the corpus is not satisfiable by saying less", () => {
    expect(itemsNeeding("faithful-reproduction").length).toBeGreaterThanOrEqual(8);
  });

  it("measures against models a user can actually be served", () => {
    expect(CATALOG_MODEL_IDS).toContain(BUDGET_MODEL);
    expect(CATALOG_MODEL_IDS.length).toBeGreaterThanOrEqual(6);
  });

  /**
   * ★ WHAT `direct-budget` ACTUALLY MEASURES. Stated in prose three places in
   * this repo and asserted in none, which is how the n-gram checks decayed. On
   * the everyday default exactly one intent sits inside the direct band, so the
   * check is today equivalent to `intent === "quick"` — a second reading of
   * intent, not an independent length signal.
   *
   * Not softened, because it is not wrong: the budget IS what reaches the
   * runtime. It is under-powered, and the honest stronger form is unreachable
   * from here — `getGenerationProfile` takes no content parameter, so the budget
   * path cannot see the length bound the corpus item states (the standing
   * `brevity-misses-the-budget` mechanism). Making it measure its name needs a
   * behaviour change, not a test change.
   */
  it("says what `direct-budget` actually measures on the model it measures", () => {
    const insideBand = INTENT_ORDER.filter(
      (intent) => getGenerationProfile(intent, true, BUDGET_MODEL).maxTokens <= DIRECT_BAND_MAX_TOKENS,
    );
    expect(
      insideBand,
      "the set of intents inside the direct band changed — `direct-budget` is no longer equivalent to `intent === \"quick\"`, so re-read what it now measures",
    ).toEqual(["quick"]);
  });

  it("names the models whose budget axis is flat, where a swept budget check would be vacuous", () => {
    // Five of ten models hand every intent the same ceiling, so on them a
    // budget assertion is satisfied by the model's own cap and says nothing
    // about routing. That is WHY budget assertions run against the everyday
    // default only — pinned so that sweeping this check across models later
    // cannot silently be half vacuous.
    const flatBudgetAxis = CATALOG_MODEL_IDS.filter(
      (modelId) =>
        new Set(INTENT_ORDER.map((intent) => getGenerationProfile(intent, true, modelId).maxTokens))
          .size === 1,
    );
    expect(flatBudgetAxis).toEqual([
      "local/qwen3-0.6b",
      "candidate/lfm2.5-350m-onnx",
      // The no-GPU int8 floor models: flat 512 budget across every intent (CPU-EP cap).
      "candidate/granite-4.0-350m-onnx",
      "candidate/smollm2-360m-instruct-onnx",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The corpus-wide ceiling the per-item checks cannot see.
// ---------------------------------------------------------------------------

describe("everyday-use sweep — n-gram exposure across the corpus", () => {
  it("records which models forbid quoting the user back, and on how many turns", () => {
    const { banned } = ngramExposure();
    expect(banned).toEqual(NGRAM_EXPOSURE_TODAY);
    // The starter was the last model here, saturated across all 49 corpus items
    // — so no count could show one turn fixed and another broken. It is gone
    // entirely now, and stated as its own assertion so re-arming reads as "the
    // starter bans again" rather than as a key appearing in a map diff.
    expect(banned["candidate/lfm2.5-350m-onnx"]).toBeUndefined();
  });

  it("arms no n-gram ban that routing itself put there", () => {
    expect(
      ngramExposure().armedByRouting,
      "a routing change sent turns to an intent that forbids quoting the user back more strictly than `quick` would",
    ).toEqual([]);
  });

  it("says out loud whether that counterweight can fire at all", () => {
    expect(
      modelsTighteningBansByIntent(),
      "the set of models with intent-specific n-gram tightening changed — `armedByRouting` just woke up or went to sleep, and either way it needs a deliberate look",
    ).toEqual(MODELS_TIGHTENING_BANS_BY_INTENT);
  });
});

// ---------------------------------------------------------------------------
// The four properties
// ---------------------------------------------------------------------------

const NEED_DESCRIPTIONS: Record<Need, string> = {
  "direct-budget": "is bounded in length, so routes inside the direct band",
  "faithful-reproduction":
    "must give the user's own words back, so the turn as routed meets no n-gram ban",
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
      expect(GAP_MECHANISMS[mechanism], `${key} names an unknown mechanism`).toBeDefined();
    }
  });

  it("points every mechanism at code that exists", () => {
    // ★ THIS REPLACED A CHARACTER COUNT — `length > 200`, asserted under the
    // claim that a mechanism "needs an explanation, not a label". Padding the
    // prose with filler satisfied it, which makes it a check measuring something
    // other than its name: exactly the defect class this file was built to find,
    // sitting in its own instrument. A citation is checkable; prose length is not.
    //
    // Second benefit the count never had: staleness. Rename `PLURALITY_RE` or
    // delete `answer-shape.ts` and every mechanism still citing them fails here
    // by name, rather than quietly describing code that no longer exists.
    //
    // ★ WHAT IT DOES NOT MEASURE. The cheapest change that satisfies it without
    // helping a reader is citing a real but IRRELEVANT file. Accepted
    // deliberately — a large improvement over a character count, unreachable by
    // prose alone, and any guard judging relevance would be a prose heuristic
    // again. A pass means "this points at real code", not "this is correct".
    //
    // Two mechanisms failed this when it was introduced — `explain-default-middle`
    // and `writing-budget-is-middle`, which described real behaviour while naming
    // only intent VALUES (`explain`, `writing`). Both were given the citation they
    // were missing (`mapShapeToDepthIntent`, `getLocalMaxTokens`); the check was
    // not weakened to admit them.
    for (const mechanism of Object.keys(GAP_MECHANISMS) as GapMechanism[]) {
      const { resolved, staleFiles } = checkSourceCitations(GAP_MECHANISMS[mechanism]);
      expect(
        staleFiles,
        `${mechanism} cites a file that does not exist — the mechanism has gone stale`,
      ).toEqual([]);
      expect(
        resolved.length,
        `${mechanism} names no file or symbol that resolves against the source tree. `
          + `Cite the code it describes — a label is not an explanation.`,
      ).toBeGreaterThan(0);
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
    // `cook` and `bake` were removed from WRITING_RE entirely on 2026-07-27, so
    // they can no longer drive routing at all — leaving them here would let the
    // instrument assert an attribution that is now impossible. The rest stay:
    // they can still participate in a writing match, just never alone.
    writing: ["write", "rewrite", "draft", "tone", "copy", "email", "essay", "story", "post", "message", "headline", "recipe"],
  };

  function pasteOnlyTrigger(item: EverydayUseItem): string | null {
    const intent = route(item).intent;
    const triggers = CASCADE_TRIGGERS[intent];
    if (triggers === undefined || !item.hasPastedContent) {
      return null;
    }
    // A repair ask reaches `writing` through `isTextRepairAsk`, which reads the
    // instruction and nothing else. Attributing those to a word in the paste
    // would be the instrument mis-crediting the cause — the failure mode this
    // block was written to catch in the first place.
    if (isTextRepairAsk(item.userInput)) {
      return null;
    }
    // Compare against the INSTRUCTION — the paragraph the user typed — and not
    // against the window the cascade happened to classify. Those differ on
    // short turns, and that difference is the defect this block exists to see:
    // a turn small enough to fall under the dominance rule still gets its
    // pasted quote classified along with the ask.
    const ask = (item.userInput.split("\n\n")[0] ?? "").toLowerCase();
    const whole = item.userInput.toLowerCase();
    return triggers.find((word) => whole.includes(word) && !ask.includes(word)) ?? null;
  }

  it("routes on words found only inside the paste in one remaining case", () => {
    const affected = EVERYDAY_USE_CORPUS.filter((item) => pasteOnlyTrigger(item) !== null).map(
      (item) => `${item.id}:${route(item).intent}:${pasteOnlyTrigger(item) ?? ""}`,
    );
    // ★ THREE OF FOUR CLOSED. This list was pinned as current behaviour with
    // the note "scoping the cascade to the ask window should empty this list";
    // the cascade now classifies `instructionParagraph`, and three went. Gone:
    //
    //   legal-rent-increase:research:current  — a landlord's letter says "your
    //     current lease term", and RESEARCH_RE is the highest-precedence branch,
    //     so the turn took the research treatment on a model with no web access.
    //   proofread-school-post:writing:email   — her ask says "fix my typos"; the
    //     post she pasted says "please email the councillor".
    //   school-letter-esl-parent:writing:write — the letter's "we write to advise".
    //
    // Two of those were routed CORRECTLY by accident (school-post wants
    // writing) — which is why this list pins the trigger word and not just the
    // intent. A right answer for a wrong reason still had to move.
    //
    // ★ THE ONE THAT REMAINS, and why it is not a rule waiting to be written.
    // `rewrite-03` is 116 characters: "does this sound rude" plus a 96-character
    // quote. The paste-dominance rule deliberately does not split a turn that
    // small — at that size the whole turn genuinely reads as the ask, and
    // splitting it changed the routing of turns that were being handled well.
    // So the quote sits inside the classified window and its "per my last
    // email" reaches WRITING_RE. The routing that results is right; the reason
    // is not. Lowering the split threshold to catch it is the obvious fix and
    // the wrong one until something measures what else it moves.
    expect(affected.sort()).toEqual(["rewrite-03:writing:email"]);
  });
});

/**
 * The instruction this sweep cannot route.
 *
 * Every turn also carries the on-device system prompt, which is not per-turn.
 * It contains its own development directive — now the direct posture
 * (open-vs-closed axis), shipped 2026-08-26 after the posture-direct A/B arm
 * was validated.
 *
 * Pinned so it cannot be forgotten, and so changing it is deliberate.
 */
describe("everyday-use sweep — the system prompt is not routed", () => {
  it("still instructs development on every turn, independent of intent", () => {
    const prompt = getOnDeviceSystemPrompt();
    expect(prompt).toContain("let the question decide");
    expect(prompt).toContain("an open question");
  });
});

/**
 * The n-gram ban that routing could not reach — CLOSED, and held closed.
 *
 * `candidate/lfm2.5-350m-onnx`, the model every first-time user's first answer
 * comes from, carried `noRepeatNgramSize` as a BASE setting plus a `writing`
 * override. Transformers.js applies the ban across the FULL sequence, prompt
 * included, so it hard-blocked reusing more than two consecutive words of the
 * user's own text — on every turn, at every intent, and no routing change could
 * lift it. All ten "give me my own words back" gaps shared that one cause.
 *
 * ★ THIS WAS THE DEFECT, NOT THE EXCUSE. An earlier reading of the same fact
 * concluded the per-item faithfulness check should be scoped AWAY from it, so as
 * not to blame routing for something routing cannot reach. The result was a check
 * that passed everywhere while all ten turns were copy-blocked. The lesson is
 * general and outlives the fix: when a check's subject turns out to be
 * unreachable from the layer the check lives in, state the defect — do not narrow
 * the check until the defect falls outside it.
 *
 * It came off both layers once a real-model A/B settled the open question
 * (`preservesUserText` past the pre-registered bar, no runaway repetition). This
 * assertion is now the standing net, inverted: it fails if the ban comes back at
 * any intent. It reads the ROUTING path against the real catalog id, which is the
 * end-to-end version of the profile-module check in
 * `lib/__tests__/local-model-generation-profiles.test.ts`.
 */
describe("everyday-use sweep — the starter model's n-gram ban stays off", () => {
  it("bans at no intent, so the user's own words can come back intact", () => {
    const starter = "candidate/lfm2.5-350m-onnx";
    expect(CATALOG_MODEL_IDS).toContain(starter);
    for (const intent of INTENT_ORDER) {
      expect(
        getGenerationProfile(intent, true, starter).noRepeatNgramSize,
        `${intent} re-arms the starter's prompt-inclusive n-gram ban — that is the copy-blocking defect an A/B removed, not a loop guard worth restoring`,
      ).toBeUndefined();
    }
  });
});
