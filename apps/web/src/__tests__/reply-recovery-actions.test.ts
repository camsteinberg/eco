// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The per-reply recovery control — "Make shorter", "Expand", "Explain simply",
 * "Continue" — and what the host actually does when one is pressed.
 *
 * WHAT THE CONTROL IS. Each menu item sends a canned USER turn through the
 * ordinary send path (`useConversationManager.handleAssistantAction`). There is
 * no separate channel: the string goes through the same intent cascade, the same
 * budget lookup and the same per-turn hint machinery as anything a person types.
 * So whatever the router makes of that string IS the feature.
 *
 * WHAT IT DOES TODAY. `shorter`, `expand` and `simplify` are the same request.
 * All three route to `explain` on all seven catalog models and receive an
 * identical budget, temperature, n-gram setting and appended hint — and that hint
 * asks the model to develop the answer. Pressing "Make shorter" on the everyday
 * default sends the model this:
 *
 *     Make your previous answer shorter and keep only the essentials.
 *
 *     Lead with a plain-language explanation, then develop the details that
 *     matter — reasons, examples, practical implications.
 *
 * The instruction that reaches the model LAST is the one telling it to elaborate.
 *
 * ★ TWO LAYERS, AND ONLY ONE OF THEM IS A JUDGEMENT — the pattern from
 * `everyday-use-routing-sweep.test.ts`, for the same reason.
 *
 *   THE FACT LAYER (`RECOVERY_ROUTING_TODAY`, `RENDERED_TURN_TODAY`,
 *   `DIRECTIVE_SUPPRESSION_TODAY`) records what happens today, per action and per
 *   model, with no opinion in it. Review a change to this feature by that diff
 *   first — it shows what moved, including for the actions the change was not
 *   aimed at.
 *
 *   THE JUDGED LAYER (`KNOWN_DEFECTS` and the tests that carry its keys) says
 *   which of those facts are wrong and why. Every entry asserts CURRENT
 *   behaviour, so fixing one FAILS this file on purpose: delete the entry, do not
 *   relax the assertion.
 *
 * ★ EACH DEFECT PIN CARRIES ITS OWN COUNTERWEIGHT, because a pin of the form
 * "these two things are equal" is satisfied by making everything equal, and a pin
 * of the form "this number is too big" is satisfied by shrinking the number it is
 * compared against. The counterweights are named at each entry. This repo has had
 * three checks quietly degenerate into constants; the guard is to write down, per
 * assertion, the cheapest change that would satisfy it without helping anyone —
 * and then make sure that change fails something.
 *
 * ★ THIS FILE DOES NOT MEASURE ANSWER QUALITY. It measures the conditions handed
 * to the model, which are deterministic, cheap to check, and currently wrong.
 * Whether a shorter answer actually comes back needs a loaded model on real
 * hardware.
 */

import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  buildHintedUserTurn,
  getGenerationProfile,
  inferTurnIntent,
  type ChatIntent,
} from "../lib/chat-intent";
import { hasExplicitFormatInstruction } from "../lib/answer-shape";
import { getCatalog } from "../local-ai/catalog/catalog";
import { PREFERRED_DEFAULT_MODEL_ID } from "../local-ai/selection/recommend";
import type { AssistantFollowUpAction } from "../components/chat/MessageActions";

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/**
 * The canned turns the menu sends, copied from
 * `useConversationManager.handleAssistantAction`.
 *
 * They are literals inside a callback there, so this is a COPY and copies rot.
 * `sends exactly the strings the app sends` below reads that file and fails if
 * any of these four drifts — which is the whole point of pinning them: a reword
 * that silently changes what the router sees must be caught by name.
 *
 * Typed as the component's own union, so adding a fifth menu action without
 * adding it here is a type error rather than a silent hole in the sweep.
 */
const ACTION_PROMPTS = {
  continue: "Continue your previous answer.",
  shorter: "Make your previous answer shorter and keep only the essentials.",
  expand: "Expand your previous answer with more useful detail and examples.",
  simplify: "Explain your previous answer more simply.",
} satisfies Record<AssistantFollowUpAction, string>;

const ACTIONS = Object.keys(ACTION_PROMPTS) as readonly AssistantFollowUpAction[];

/** Every model a user can actually be served, derived so a new one is covered. */
const CATALOG_MODEL_IDS: readonly string[] = getCatalog().map((model) => model.id);

/**
 * A recovery action is by definition a follow-up — it can only be pressed on an
 * existing reply — so the turn always has prior turns before it.
 */
const HAS_PRIOR_TURNS = true;

/** Everything the host decides for one turn on one model, as a comparable record. */
type Resolved = {
  readonly intent: ChatIntent;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly noRepeatNgramSize: number | undefined;
  /** The instruction appended to the turn; empty when none was. */
  readonly hint: string;
};

function resolveTurn(text: string, modelId: string): Resolved {
  const intent = inferTurnIntent(text, HAS_PRIOR_TURNS);
  const profile = getGenerationProfile(intent, true, modelId);
  const rendered = buildHintedUserTurn(text, intent, true, modelId);
  return {
    intent,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    noRepeatNgramSize: profile.noRepeatNgramSize,
    hint: rendered === text ? "" : rendered.slice(text.length + 2),
  };
}

function resolveAction(action: AssistantFollowUpAction, modelId: string): Resolved {
  return resolveTurn(ACTION_PROMPTS[action], modelId);
}

/** `intent:maxTokens/temperature[/nNgram]` — the compact form used by the fact matrix. */
function compact(resolved: Resolved): string {
  const ngram = resolved.noRepeatNgramSize != null ? `/n${String(resolved.noRepeatNgramSize)}` : "";
  return `${resolved.intent}:${String(resolved.maxTokens)}/${String(resolved.temperature)}${ngram}`;
}

// ---------------------------------------------------------------------------
// The fact layer: what pressing each button does today, pinned exactly.
// ---------------------------------------------------------------------------

/**
 * Every action against every model a user can be served.
 *
 * Read the three middle rows against each other: `shorter`, `expand` and
 * `simplify` are character-for-character identical. That is the defect, recorded
 * here without comment and named in `KNOWN_DEFECTS`.
 */
const RECOVERY_ROUTING_TODAY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  continue: {
    "local/phi3-mini-4k-q4f16": "quick:1024/0.2",
    "local/qwen3-0.6b": "quick:512/0.32",
    "candidate/lfm2.5-1.2b-instruct-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-350m-onnx": "quick:384/0.25/n3",
    "candidate/qwen3.5-2b-onnx": "quick:1024/0.32",
    "candidate/gemma-4-e2b-litert": "quick:256/0.18",
    "candidate/qwen2.5-0.5b-mlc": "quick:1024/0.45",
  },
  shorter: {
    "local/phi3-mini-4k-q4f16": "explain:1024/0.38",
    "local/qwen3-0.6b": "explain:512/0.42",
    "candidate/lfm2.5-1.2b-instruct-onnx": "explain:1536/0.3",
    "candidate/lfm2.5-350m-onnx": "explain:384/0.45/n3",
    "candidate/qwen3.5-2b-onnx": "explain:1536/0.42",
    "candidate/gemma-4-e2b-litert": "explain:768/0.3",
    "candidate/qwen2.5-0.5b-mlc": "explain:1536/0.55",
  },
  expand: {
    "local/phi3-mini-4k-q4f16": "explain:1024/0.38",
    "local/qwen3-0.6b": "explain:512/0.42",
    "candidate/lfm2.5-1.2b-instruct-onnx": "explain:1536/0.3",
    "candidate/lfm2.5-350m-onnx": "explain:384/0.45/n3",
    "candidate/qwen3.5-2b-onnx": "explain:1536/0.42",
    "candidate/gemma-4-e2b-litert": "explain:768/0.3",
    "candidate/qwen2.5-0.5b-mlc": "explain:1536/0.55",
  },
  simplify: {
    "local/phi3-mini-4k-q4f16": "explain:1024/0.38",
    "local/qwen3-0.6b": "explain:512/0.42",
    "candidate/lfm2.5-1.2b-instruct-onnx": "explain:1536/0.3",
    "candidate/lfm2.5-350m-onnx": "explain:384/0.45/n3",
    "candidate/qwen3.5-2b-onnx": "explain:1536/0.42",
    "candidate/gemma-4-e2b-litert": "explain:768/0.3",
    "candidate/qwen2.5-0.5b-mlc": "explain:1536/0.55",
  },
};

/**
 * The same four actions typed by a PERSON, in their own words, as the control
 * arm. Pinned so the inversion below cannot be "closed" by making the typed side
 * worse instead of the pressed side better.
 */
const TYPED_EQUIVALENT = "make it shorter";

const TYPED_ROUTING_TODAY: Readonly<Record<string, string>> = {
  "local/phi3-mini-4k-q4f16": "quick:1024/0.2",
  "local/qwen3-0.6b": "quick:512/0.32",
  "candidate/lfm2.5-1.2b-instruct-onnx": "quick:1024/0.2",
  "candidate/lfm2.5-350m-onnx": "quick:384/0.25/n3",
  "candidate/qwen3.5-2b-onnx": "quick:1024/0.32",
  "candidate/gemma-4-e2b-litert": "quick:256/0.18",
  "candidate/qwen2.5-0.5b-mlc": "quick:1024/0.45",
};

/**
 * The turn as the model receives it — the user's instruction, then ours.
 *
 * Pinned in full for the everyday default and for Gemma-LiteRT, the only model
 * whose hints differ. `emits no hint outside the pinned set` below covers the
 * remaining five by asserting the set of distinct hints, so a sixth variant
 * cannot appear unpinned.
 */
const RENDERED_TURN_TODAY: Readonly<Record<string, string>> = {
  "continue@default": "Continue your previous answer.",
  "shorter@default":
    "Make your previous answer shorter and keep only the essentials."
    + "\n\nLead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications.",
  "expand@default":
    "Expand your previous answer with more useful detail and examples."
    + "\n\nLead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications.",
  "simplify@default":
    "Explain your previous answer more simply."
    + "\n\nLead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications.",
  "continue@litert":
    "Continue your previous answer."
    + "\n\nAnswer directly and briefly. For a single factual question, give the answer first and stop. For a short follow-up, make only the requested change.",
  "shorter@litert":
    "Make your previous answer shorter and keep only the essentials."
    + "\n\nLead with the direct answer, then cover the essential details in at most three concise paragraphs or bullets. Stop when the distinction is clear.",
  "expand@litert":
    "Expand your previous answer with more useful detail and examples."
    + "\n\nLead with the direct answer, then cover the essential details in at most three concise paragraphs or bullets. Stop when the distinction is clear.",
  "simplify@litert":
    "Explain your previous answer more simply."
    + "\n\nLead with the direct answer, then cover the essential details in at most three concise paragraphs or bullets. Stop when the distinction is clear.",
};

const LITERT_MODEL_ID = "candidate/gemma-4-e2b-litert";

/**
 * ★ A LIST, NOT A COUNT, and deliberately two-sided.
 *
 * `hasExplicitFormatInstruction` is the hint-suppression detector: when it
 * returns true the per-turn hint is dropped entirely, which is the only existing
 * mechanism by which a length instruction survives to the model unopposed. Every
 * plausible fix for the actions above goes through it, either by rewording the
 * canned string until it fires or by widening the detector.
 *
 * Both outcomes appear here on purpose. A detector that degenerated to a constant
 * — always true, or always false — fails against one side or the other, which a
 * count of matches would not catch. `keeps both answers represented` below pins
 * that two-sidedness so a later trim cannot quietly re-create the degeneracy.
 *
 * The near-misses are the point: "Be concise.", "Shorter." and "Just the answer."
 * are how people actually ask, and none of them registers as an instruction,
 * while "Keep it short. Lead with the answer itself." does.
 */
const DIRECTIVE_SUPPRESSION_TODAY: Readonly<Record<string, boolean>> = {
  // ── The four canned action strings. None of them suppresses. ──────────────
  "Continue your previous answer.": false,
  "Make your previous answer shorter and keep only the essentials.": false,
  "Expand your previous answer with more useful detail and examples.": false,
  "Explain your previous answer more simply.": false,

  // ── Recognised as instructions ───────────────────────────────────────────
  "Keep it short. Lead with the answer itself.": true,
  "keep it short": true,
  "keep it brief": true,
  "keep it simple": true,
  "in one sentence": true,
  "in two sentences": true,
  "no more than 3 sentences": true,
  "at most 100 words": true,
  "bullet points only": true,
  "as a list": true,
  "answer with just the number": true,
  "nothing else": true,
  tldr: true,
  "tl;dr": true,
  briefly: true,
  "in short": true,
  "Rewrite that more briefly.": true,

  // ── NOT recognised, though a person would call every one an instruction ──
  "Be concise.": false,
  "Shorter.": false,
  "Just the answer.": false,
  "Say it in fewer words.": false,
  "Cut it down.": false,
  "Trim it.": false,
  "Shorten it.": false,
  "Too long.": false,
  "Half the length.": false,
  "Make it shorter.": false,
  "Less detail please.": false,
  "Give me the short version.": false,
  "Summarize what you just said.": false,
};

describe("reply recovery — what pressing each button does today, pinned exactly", () => {
  for (const action of ACTIONS) {
    it(`routes "${action}" unchanged on every catalog model`, () => {
      const actual: Record<string, string> = {};
      for (const modelId of CATALOG_MODEL_IDS) {
        actual[modelId] = compact(resolveAction(action, modelId));
      }
      expect(actual).toEqual(RECOVERY_ROUTING_TODAY[action]);
    });
  }

  it("routes the typed equivalent unchanged on every catalog model", () => {
    const actual: Record<string, string> = {};
    for (const modelId of CATALOG_MODEL_IDS) {
      actual[modelId] = compact(resolveTurn(TYPED_EQUIVALENT, modelId));
    }
    expect(actual).toEqual(TYPED_ROUTING_TODAY);
  });

  it("renders each turn to the model unchanged", () => {
    const actual: Record<string, string> = {};
    for (const action of ACTIONS) {
      actual[`${action}@default`] = buildHintedUserTurn(
        ACTION_PROMPTS[action],
        inferTurnIntent(ACTION_PROMPTS[action], HAS_PRIOR_TURNS),
        true,
        PREFERRED_DEFAULT_MODEL_ID,
      );
      actual[`${action}@litert`] = buildHintedUserTurn(
        ACTION_PROMPTS[action],
        inferTurnIntent(ACTION_PROMPTS[action], HAS_PRIOR_TURNS),
        true,
        LITERT_MODEL_ID,
      );
    }
    expect(actual).toEqual(RENDERED_TURN_TODAY);
  });

  it("emits no hint outside the pinned set, on any model", () => {
    // Covers the five models not rendered in full above: if any of them ever
    // produces a seventh hint variant, it shows up here instead of going
    // unmeasured.
    const distinct = new Set<string>();
    for (const action of ACTIONS) {
      for (const modelId of CATALOG_MODEL_IDS) {
        distinct.add(resolveAction(action, modelId).hint);
      }
    }
    const pinned = new Set(
      Object.values(RENDERED_TURN_TODAY).map((turn) => {
        const split = turn.indexOf("\n\n");
        return split === -1 ? "" : turn.slice(split + 2);
      }),
    );
    expect([...distinct].sort()).toEqual([...pinned].sort());
  });

  it("classifies every directive string unchanged", () => {
    const actual: Record<string, boolean> = {};
    for (const text of Object.keys(DIRECTIVE_SUPPRESSION_TODAY)) {
      actual[text] = hasExplicitFormatInstruction(text);
    }
    expect(actual).toEqual(DIRECTIVE_SUPPRESSION_TODAY);
  });
});

// ---------------------------------------------------------------------------
// Integrity — the instrument itself
// ---------------------------------------------------------------------------

describe("reply recovery — the instrument", () => {
  it("sends exactly the strings the app sends", () => {
    // The prompts above are a COPY of literals inside a callback in
    // `useConversationManager`. Without this, rewording the shipping string
    // would leave every assertion in this file green while measuring text the
    // product no longer sends — the exact way a pin becomes decoration.
    const source = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../hooks/useConversationManager.ts",
      ),
      "utf8",
    );
    for (const [action, prompt] of Object.entries(ACTION_PROMPTS)) {
      expect(
        source.includes(`${action}: ${JSON.stringify(prompt)}`),
        `useConversationManager no longer sends ${JSON.stringify(prompt)} for "${action}". `
          + `Update ACTION_PROMPTS here and re-read every pin below — the reword may have `
          + `changed what the router does with it.`,
      ).toBe(true);
    }
  });

  it("measures against models a user can actually be served", () => {
    expect(CATALOG_MODEL_IDS).toContain(PREFERRED_DEFAULT_MODEL_ID);
    expect(CATALOG_MODEL_IDS).toContain(LITERT_MODEL_ID);
    expect(CATALOG_MODEL_IDS.length).toBeGreaterThanOrEqual(6);
  });

  it("keeps both answers represented in the directive list", () => {
    // ★ THE COUNTERWEIGHT on the directive pin. `hasExplicitFormatInstruction`
    // going constant — always true, or always false — is caught only because the
    // list carries both outcomes. Trimming it to one side would make the pin
    // satisfiable by a detector that has stopped detecting.
    const values = Object.values(DIRECTIVE_SUPPRESSION_TODAY);
    expect(values.filter((v) => v).length).toBeGreaterThanOrEqual(8);
    expect(values.filter((v) => !v).length).toBeGreaterThanOrEqual(8);
  });

  it("resolves each action identically with and without prior turns", () => {
    // The shape classifier consults `hasPriorTurns`, and it is derived from a
    // position in a SLIDING window — so it can flip mid-conversation once
    // context eviction moves the window start. These four turns are insensitive
    // to it today, which is what makes every pin above stable. If that changes,
    // the pins become conditional on a state nothing here controls, and this
    // says so rather than letting the sweep quietly measure one of two worlds.
    for (const action of ACTIONS) {
      const prompt = ACTION_PROMPTS[action];
      expect(
        inferTurnIntent(prompt, false),
        `"${action}" now routes differently depending on window position`,
      ).toBe(inferTurnIntent(prompt, true));
    }
  });
});

// ---------------------------------------------------------------------------
// The judged layer. Every entry asserts CURRENT behaviour, so a fix fails here.
// ---------------------------------------------------------------------------

const KNOWN_DEFECTS = {
  "shorter-expand-simplify-are-one-request": [
    "`shorter`, `expand` and `simplify` resolve to the SAME thing on every catalog model —",
    "same intent (`explain`), same token budget, same temperature, same n-gram setting, same",
    "appended hint. Three menu items that ask for opposite outcomes are, at the point where",
    "the host decides anything, one button pressed three ways. The cause is that the cascade",
    "reads these strings as ordinary prose: none matches a task-class branch, and",
    "`inferAnswerShape` returns `uncertain` for `shorter`/`expand` and `focused` for",
    "`simplify`, all three of which `mapShapeToDepthIntent` sends to `explain`. Nothing in",
    "the pipeline knows the turn is a REVISION DIRECTIVE about the previous answer rather",
    "than a new ask, so the one axis that matters here — more or less — is never read.",
    "This is a LIVE, SHIPPED defect: the control is in the three-dot menu on every finished",
    "reply, and two of its four items cannot do what their label says.",
  ].join(" "),

  "the-hint-contradicts-the-user": [
    "The turn the model receives ends with our instruction, not the user's. `shorter` renders",
    "as 'Make your previous answer shorter and keep only the essentials.' followed by 'Lead",
    "with a plain-language explanation, then develop the details that matter — reasons,",
    "examples, practical implications.' The suppression mechanism that exists for exactly",
    "this case — `hasExplicitFormatInstruction`, which drops the hint when the user has given",
    "a format or length instruction — returns false for all four canned strings, because it",
    "matches idioms like 'keep it short' and 'in one sentence' and the canned string says",
    "'shorter and keep only the essentials'. Recency is the documented failure mode here: the",
    "Wave-2.6 measurement that put hints at the end of the turn also measured a hint beating",
    "an explicit 'in exactly one sentence' on a 1.2B. So the appended hint is not merely",
    "unhelpful on this turn, it is positioned to win.",
  ].join(" "),

  "pressing-shorter-costs-more-than-typing-it": [
    "Asking for a shorter answer through the BUTTON gets a more generous generation profile",
    "than typing the same request in your own words. 'make it shorter' routes `quick`; the",
    "canned string routes `explain`. Temperature rises on all seven catalog models, and on",
    "the four with headroom above the `quick` budget the ceiling rises too — on the everyday",
    "default from 1024 to 1536 tokens. The affordance built to recover from an answer that",
    "was too long hands the model a bigger budget and a hotter sampler than doing nothing",
    "would have. The cause is length: the canned sentence is long enough and prose-shaped",
    "enough to miss the `brief` shape that a four-word human request lands on.",
  ].join(" "),

  "expand-tells-litert-to-stop": [
    "On `candidate/gemma-4-e2b-litert` the same identity collapse runs the other way. That",
    "model overrides the `explain` hint with its own compact wording — 'Lead with the direct",
    "answer, then cover the essential details in at most three concise paragraphs or bullets.",
    "Stop when the distinction is clear.' — which is a ceiling and a stop instruction. So",
    "pressing EXPAND on Gemma appends a directive to cap the answer at three paragraphs and",
    "stop, on top of a budget of 768 tokens against the 1536 the same model gives `deep`.",
    "Worth recording separately because it survives the obvious fix: routing `shorter` to a",
    "brief treatment does nothing for `expand`, which needs a depth treatment it currently",
    "cannot reach on any model.",
  ].join(" "),
} as const;

type Defect = keyof typeof KNOWN_DEFECTS;

describe("reply recovery — known defects stay visible", () => {
  it("explains every defect it names", () => {
    for (const defect of Object.keys(KNOWN_DEFECTS) as Defect[]) {
      expect(
        KNOWN_DEFECTS[defect].length,
        `${defect} needs an explanation, not a label`,
      ).toBeGreaterThan(200);
    }
  });

  it("shorter-expand-simplify-are-one-request", () => {
    // ★ CHEAPEST SATISFYING CHANGE: make every action resolve identically, which
    // would be a pure regression. The `continue` counterweight below fails on it.
    for (const modelId of CATALOG_MODEL_IDS) {
      const shorter = resolveAction("shorter", modelId);
      expect(
        resolveAction("expand", modelId),
        `"expand" and "shorter" now differ on ${modelId}. If that was the fix, delete this `
          + `entry from KNOWN_DEFECTS and update RECOVERY_ROUTING_TODAY — do not relax it.`,
      ).toEqual(shorter);
      expect(
        resolveAction("simplify", modelId),
        `"simplify" and "shorter" now differ on ${modelId}. Same instruction as above.`,
      ).toEqual(shorter);
    }
  });

  it("still tells at least two of the four actions apart, on every model", () => {
    // ★ THE COUNTERWEIGHT. Without it, "shorter equals expand equals simplify" is
    // also satisfied by a resolver that has stopped resolving — every action
    // collapsing onto one profile would read as the defect holding steady rather
    // than as everything breaking.
    //
    // It counts DISTINCT profiles rather than naming a pair, deliberately. An
    // earlier form asserted `continue` differs from `shorter`, and a trial fix
    // that routed `shorter` to the brief treatment made those two identical for
    // an entirely good reason — so the counterweight failed with the message "the
    // measurement has gone flat" while nothing had gone flat. Pinning a specific
    // pair encodes today's grouping; pinning that a grouping EXISTS is the
    // property actually wanted, and it survives any legitimate regrouping.
    for (const modelId of CATALOG_MODEL_IDS) {
      const distinct = new Set(ACTIONS.map((action) => compact(resolveAction(action, modelId))));
      expect(
        distinct.size,
        `all four actions now resolve identically on ${modelId} (${[...distinct].join(", ")}) — `
          + `the measurement has gone flat and every identity assertion here is vacuous`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("the-hint-contradicts-the-user", () => {
    // ★ CHEAPEST SATISFYING CHANGE: none that helps — this asserts a specific
    // rendered string, so any reword of either the canned prompt or the hint
    // fails it and forces a deliberate re-read. The companion assertion is that
    // the suppression detector still declines the string, which is what a fix
    // would most likely change first.
    for (const action of ACTIONS) {
      expect(
        hasExplicitFormatInstruction(ACTION_PROMPTS[action]),
        `"${action}" now suppresses the per-turn hint. If that was the fix, delete this entry `
          + `and update DIRECTIVE_SUPPRESSION_TODAY and RENDERED_TURN_TODAY.`,
      ).toBe(false);
    }
    const rendered = buildHintedUserTurn(
      ACTION_PROMPTS.shorter,
      inferTurnIntent(ACTION_PROMPTS.shorter, HAS_PRIOR_TURNS),
      true,
      PREFERRED_DEFAULT_MODEL_ID,
    );
    expect(rendered).toBe(RENDERED_TURN_TODAY["shorter@default"]);
    // And the contradiction is positional, not merely present: ours arrives last.
    expect(rendered.indexOf("develop the details")).toBeGreaterThan(
      rendered.indexOf("keep only the essentials"),
    );
  });

  it("pressing-shorter-costs-more-than-typing-it", () => {
    // ★ CHEAPEST SATISFYING CHANGE: raise the TYPED side to match the pressed
    // side, "closing" the gap by making a person's own words route worse. That
    // fails `routes the typed equivalent unchanged` in the fact layer, which pins
    // all seven typed values at `quick`.
    for (const modelId of CATALOG_MODEL_IDS) {
      const typed = resolveTurn(TYPED_EQUIVALENT, modelId);
      const pressed = resolveAction("shorter", modelId);
      expect(
        pressed.temperature,
        `pressing "Make shorter" no longer costs more temperature than typing it on `
          + `${modelId}. If that was the fix, delete this entry from KNOWN_DEFECTS.`,
      ).toBeGreaterThan(typed.temperature);
      expect(
        pressed.maxTokens,
        `the button's budget dropped below the typed request's on ${modelId} — re-read the `
          + `fact layer before deleting anything`,
      ).toBeGreaterThanOrEqual(typed.maxTokens);
    }
    // On the everyday default the budget inversion is explicit, not just a
    // tie: 1536 against 1024. Pinned as the headline pair.
    expect(resolveAction("shorter", PREFERRED_DEFAULT_MODEL_ID).maxTokens).toBe(1536);
    expect(resolveTurn(TYPED_EQUIVALENT, PREFERRED_DEFAULT_MODEL_ID).maxTokens).toBe(1024);
  });

  it("expand-tells-litert-to-stop", () => {
    // ★ CHEAPEST SATISFYING CHANGE: none that helps — the assertion names the
    // curtailing clause in the hint the LiteRT model actually receives for
    // `expand`, so it only goes green when that turn stops being told to stop.
    const expand = resolveAction("expand", LITERT_MODEL_ID);
    expect(
      expand.hint,
      `the "Expand" action no longer receives a curtailing hint on ${LITERT_MODEL_ID}. `
        + `If that was the fix, delete this entry and update RENDERED_TURN_TODAY.`,
    ).toContain("Stop when");
    expect(expand.hint).toContain("at most three concise paragraphs");
    // And it is below what the same model gives a depth turn, so the budget is
    // pulling the same direction as the hint.
    expect(expand.maxTokens).toBeLessThan(
      getGenerationProfile("deep", true, LITERT_MODEL_ID).maxTokens,
    );
  });
});
