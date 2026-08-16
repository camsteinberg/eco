// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The per-reply controls — "Make shorter", "Expand", "Explain simply",
 * "Continue" — and what the host actually asks the model for when one is
 * pressed.
 *
 * WHAT THE CONTROL IS NOW. Three of the four REGENERATE the reply they are
 * pressed on, as a sibling, with a forced intent and a model-facing directive
 * riding the end of that one generation's user turn
 * (`useConversationManager.handleAssistantAction` → `regenerateMessage`).
 * `continue` still sends a canned turn, because continuing needs the partial
 * reply in the history and true assistant-prefix continuation does not exist
 * here.
 *
 * WHAT IT USED TO DO, and why this file exists. Every control sent a canned
 * USER turn through the ordinary send path, so whatever the router made of that
 * sentence WAS the feature. `shorter`, `expand` and `simplify` all read as
 * ordinary prose, all routed to `explain`, and all received the same budget,
 * temperature and appended hint — a hint asking the model to develop the
 * answer, arriving after the user's instruction and winning by recency.
 * Pressing "Make shorter" cost MORE budget and a hotter sampler than typing the
 * same request. Those pins were deleted by the change that fixed them; the
 * fixed-behaviour assertions that replaced them are in
 * `reply recovery — what the fix changed` below, and they are the reason a
 * regression cannot come back quietly.
 *
 * ★ TWO LAYERS, AND ONLY ONE OF THEM IS A JUDGEMENT — the pattern from
 * `everyday-use-routing-sweep.test.ts`, for the same reason.
 *
 *   THE FACT LAYER (`CONTROL_SAMPLING_TODAY`, `TYPED_ROUTING_TODAY`,
 *   `RENDERED_TURN_TODAY`, `DIRECTIVE_SUPPRESSION_TODAY`, `DEEPENABLE_TODAY`)
 *   records what happens today, per control and per model, with no opinion in
 *   it. Review a change to this feature by that diff first — it shows what
 *   moved, including for the controls the change was not aimed at.
 *
 *   THE JUDGED LAYER (`KNOWN_DEFECTS` and the tests that carry its keys) says
 *   which of those facts are still wrong and why. Every entry asserts CURRENT
 *   behaviour, so fixing one FAILS this file on purpose: delete the entry, do
 *   not relax the assertion.
 *
 * ★ EACH PIN CARRIES ITS OWN COUNTERWEIGHT, because a pin of the form "these
 * two things differ" is satisfied by breaking one of them, and a pin of the
 * form "no hint is appended" is satisfied by a hint pipeline that has stopped
 * appending hints at all. The counterweights are named at each entry. This repo
 * has had three checks quietly degenerate into constants; the guard is to write
 * down, per assertion, the cheapest change that would satisfy it without
 * helping anyone — and then make sure that change fails something.
 *
 * ★ THIS FILE DOES NOT MEASURE ANSWER QUALITY. It measures the conditions
 * handed to the model, which are deterministic and cheap to check. Whether a
 * shorter answer actually comes back needs a loaded model on real hardware.
 * What reaches the model through the live hook — call shape, directive
 * placement, the gates — is measured in
 * `hooks/__tests__/useConversationManager.reply-controls.test.tsx` and
 * `hooks/__tests__/useChat.recovery-seam.test.tsx`.
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
import {
  canDeepen,
  REPLY_CONTROL_TREATMENTS,
  type ReplyRegenerateControl,
} from "../lib/reply-controls";
import { getCatalog } from "../local-ai/catalog/catalog";
import { PREFERRED_DEFAULT_MODEL_ID } from "../local-ai/selection/recommend";
import type { AssistantReplyControl } from "../components/chat/MessageActions";
import { checkSourceCitations } from "./helpers/source-citations";

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/**
 * The canned turn `continue` still sends, copied from
 * `useConversationManager`. It is a literal in that module, so this is a COPY
 * and copies rot — `sends exactly the strings the app sends` below reads the
 * file and fails if it drifts.
 */
const CONTINUE_TURN = "Continue your previous answer.";

/**
 * The three regenerating controls, derived from the shipping treatment table
 * rather than listed. A fourth control added there without a row in the fact
 * tables below fails the sweeps by name instead of going unmeasured.
 */
const REGENERATE_CONTROLS = Object.keys(
  REPLY_CONTROL_TREATMENTS,
) as readonly ReplyRegenerateControl[];

/** All four, in menu order. Typed so a fifth control is a type error here. */
const CONTROLS: readonly AssistantReplyControl[] = ["continue", ...REGENERATE_CONTROLS];

/** Every model a user can actually be served, derived so a new one is covered. */
const CATALOG_MODEL_IDS: readonly string[] = getCatalog().map((model) => model.id);

/**
 * A control is by definition a follow-up — it can only be pressed on an
 * existing reply — so the turn always has prior turns before it.
 */
const HAS_PRIOR_TURNS = true;

/**
 * The question a control is pressed on, in the fixtures below.
 *
 * It is an ordinary everyday ask that carries a non-empty per-intent hint of
 * its own (asserted in `the example ask carries a hint of its own`), which is
 * what makes the suppression assertions measure something rather than nothing.
 */
const EXAMPLE_ASK = "why do leaves change colour in the autumn";

const LITERT_MODEL_ID = "candidate/gemma-4-e2b-litert";

/** Everything the host decides for one generation on one model, as a record. */
type Resolved = {
  readonly intent: ChatIntent;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly noRepeatNgramSize: number | undefined;
};

function resolveIntent(intent: ChatIntent, modelId: string): Resolved {
  const profile = getGenerationProfile(intent, true, modelId);
  return {
    intent,
    maxTokens: profile.maxTokens,
    temperature: profile.temperature,
    noRepeatNgramSize: profile.noRepeatNgramSize,
  };
}

/** What a turn TYPED by a person resolves to — the control arm. */
function resolveTypedTurn(text: string, modelId: string): Resolved {
  return resolveIntent(inferTurnIntent(text, HAS_PRIOR_TURNS), modelId);
}

/**
 * What PRESSING a control resolves to. The three regenerating controls force
 * their intent at the options layer (`RegenerateOverrides.intent`); `continue`
 * has no forced intent, so its sampling is whatever its canned turn routes to.
 */
function resolveControl(control: AssistantReplyControl, modelId: string): Resolved {
  return control === "continue"
    ? resolveTypedTurn(CONTINUE_TURN, modelId)
    : resolveIntent(REPLY_CONTROL_TREATMENTS[control].intent, modelId);
}

/** The text of the final user turn for one control, before hinting. */
function composedTurn(control: AssistantReplyControl): string {
  // `continue` sends its canned turn as the whole message; the other three
  // append their directive to the END of the user's own turn, which is what
  // `appendTurnDirective` does inside `buildPrompt`.
  return control === "continue"
    ? CONTINUE_TURN
    : `${EXAMPLE_ASK}\n\n${REPLY_CONTROL_TREATMENTS[control].directive}`;
}

/** The turn the model receives for one control on one model. */
function renderControlTurn(control: AssistantReplyControl, modelId: string): string {
  const composed = composedTurn(control);
  // Hints are re-derived from the COMPOSED text, never from the forced intent —
  // the classifiers keep their strict-prefix purity contract.
  return buildHintedUserTurn(composed, inferTurnIntent(composed, HAS_PRIOR_TURNS), true, modelId);
}

/** The hint appended to a control's turn; empty when none was. */
function hintFor(control: AssistantReplyControl, modelId: string): string {
  const composed = composedTurn(control);
  const rendered = renderControlTurn(control, modelId);
  return rendered === composed ? "" : rendered.slice(composed.length + 2);
}

/** `intent:maxTokens/temperature[/nNgram]` — the compact form used by the fact matrix. */
function compact(resolved: Resolved): string {
  const ngram = resolved.noRepeatNgramSize != null ? `/n${String(resolved.noRepeatNgramSize)}` : "";
  return `${resolved.intent}:${String(resolved.maxTokens)}/${String(resolved.temperature)}${ngram}`;
}

// ---------------------------------------------------------------------------
// The fact layer: what pressing each control does today, pinned exactly.
// ---------------------------------------------------------------------------

/**
 * Every control against every model a user can be served.
 *
 * Read `expand` against the rest: it is the only row that reaches a `deep`
 * budget, and on the three models whose ladder is flat it buys temperature and
 * nothing else — which is exactly why `canDeepen` gates it (`DEEPENABLE_TODAY`).
 * `shorter` and `simplify` share a row on purpose: both force `quick`, and what
 * separates them is the directive, not the sampling.
 */
const CONTROL_SAMPLING_TODAY: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  continue: {
    "local/qwen3-0.6b": "quick:512/0.32",
    "candidate/lfm2.5-1.2b-instruct-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-1.2b-instruct-q4-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-350m-onnx": "quick:384/0.25",
    "candidate/qwen3.5-2b-onnx": "quick:1024/0.32",
    "candidate/gemma-4-e2b-litert": "quick:256/0.18",
    "candidate/qwen2.5-0.5b-mlc": "quick:1024/0.45",
    "candidate/qwen2.5-0.5b-instruct-onnx": "quick:512/0.32",
    "candidate/smollm2-360m-instruct-onnx": "quick:512/0.32",
    "candidate/lfm2-2.6b-onnx": "quick:1024/0.2",
  },
  shorter: {
    "local/qwen3-0.6b": "quick:512/0.32",
    "candidate/lfm2.5-1.2b-instruct-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-1.2b-instruct-q4-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-350m-onnx": "quick:384/0.25",
    "candidate/qwen3.5-2b-onnx": "quick:1024/0.32",
    "candidate/gemma-4-e2b-litert": "quick:256/0.18",
    "candidate/qwen2.5-0.5b-mlc": "quick:1024/0.45",
    "candidate/qwen2.5-0.5b-instruct-onnx": "quick:512/0.32",
    "candidate/smollm2-360m-instruct-onnx": "quick:512/0.32",
    "candidate/lfm2-2.6b-onnx": "quick:1024/0.2",
  },
  expand: {
    "local/qwen3-0.6b": "deep:512/0.6",
    "candidate/lfm2.5-1.2b-instruct-onnx": "deep:2048/0.3",
    "candidate/lfm2.5-1.2b-instruct-q4-onnx": "deep:2048/0.3",
    "candidate/lfm2.5-350m-onnx": "deep:384/0.45",
    "candidate/qwen3.5-2b-onnx": "deep:2048/0.6",
    "candidate/gemma-4-e2b-litert": "deep:1536/0.42",
    "candidate/qwen2.5-0.5b-mlc": "deep:2048/0.55",
    "candidate/qwen2.5-0.5b-instruct-onnx": "deep:512/0.6",
    "candidate/smollm2-360m-instruct-onnx": "deep:512/0.6",
    "candidate/lfm2-2.6b-onnx": "deep:2048/0.3",
  },
  simplify: {
    "local/qwen3-0.6b": "quick:512/0.32",
    "candidate/lfm2.5-1.2b-instruct-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-1.2b-instruct-q4-onnx": "quick:1024/0.2",
    "candidate/lfm2.5-350m-onnx": "quick:384/0.25",
    "candidate/qwen3.5-2b-onnx": "quick:1024/0.32",
    "candidate/gemma-4-e2b-litert": "quick:256/0.18",
    "candidate/qwen2.5-0.5b-mlc": "quick:1024/0.45",
    "candidate/qwen2.5-0.5b-instruct-onnx": "quick:512/0.32",
    "candidate/smollm2-360m-instruct-onnx": "quick:512/0.32",
    "candidate/lfm2-2.6b-onnx": "quick:1024/0.2",
  },
};

/**
 * The same request typed by a PERSON, in their own words, as the control arm.
 * Pinned so `no longer costs more to press shorter than to type it` cannot be
 * "held" by making a person's own words route worse.
 */
const TYPED_EQUIVALENT = "make it shorter";

const TYPED_ROUTING_TODAY: Readonly<Record<string, string>> = {
  "local/qwen3-0.6b": "quick:512/0.32",
  "candidate/lfm2.5-1.2b-instruct-onnx": "quick:1024/0.2",
  "candidate/lfm2.5-1.2b-instruct-q4-onnx": "quick:1024/0.2",
  "candidate/lfm2.5-350m-onnx": "quick:384/0.25",
  "candidate/qwen3.5-2b-onnx": "quick:1024/0.32",
  "candidate/gemma-4-e2b-litert": "quick:256/0.18",
  "candidate/qwen2.5-0.5b-mlc": "quick:1024/0.45",
  "candidate/qwen2.5-0.5b-instruct-onnx": "quick:512/0.32",
  "candidate/smollm2-360m-instruct-onnx": "quick:512/0.32",
  "candidate/lfm2-2.6b-onnx": "quick:1024/0.2",
};

/**
 * ★ THE CAPABILITY GATE, AS A LIST OF MODELS — never a count, and never a
 * hardcoded list in the shipping code.
 *
 * `canDeepen` asks the real generation profile whether a `deep` turn is allowed
 * more room than a `quick` one. Where it is not, "Expand" would be a promise
 * the model cannot keep, so the control is a no-op there. Pinned per model so
 * raising a flat model's ceiling — or flattening a ladder one — shows up here
 * by name, and so a predicate that degenerated to `true` or `false` fails
 * against one side or the other.
 */
const DEEPENABLE_TODAY: Readonly<Record<string, boolean>> = {
  "local/qwen3-0.6b": false,
  "candidate/lfm2.5-1.2b-instruct-onnx": true,
  "candidate/lfm2.5-1.2b-instruct-q4-onnx": true,
  "candidate/lfm2.5-350m-onnx": false,
  "candidate/qwen3.5-2b-onnx": true,
  "candidate/gemma-4-e2b-litert": true,
  "candidate/qwen2.5-0.5b-mlc": true,
  // Flat 512 CPU-EP budget (quick == deep), so "Expand" has no headroom — like qwen3-0.6b.
  "candidate/qwen2.5-0.5b-instruct-onnx": false,
  "candidate/smollm2-360m-instruct-onnx": false,
  // LFM2-2.6B — webgpu 2048 ceiling gives deep real headroom over quick, so canDeepen.
  "candidate/lfm2-2.6b-onnx": true,
};

/**
 * The turn as the model receives it — the user's own question, then our
 * directive, then whatever hint survives.
 *
 * Pinned in full for the everyday default and for Gemma-LiteRT, the only model
 * whose hints differ. `emits no hint outside the pinned set` below covers the
 * remaining five by asserting the SET of distinct hints, so a further variant
 * cannot appear unpinned.
 *
 * Read `shorter` and `simplify` against `expand`: the two closed-direction
 * directives end the turn, because they trip `hasExplicitFormatInstruction` and
 * the hint is dropped. `expand`'s does not, so a hint still lands after it —
 * and on LiteRT that hint is still a stop instruction (`KNOWN_DEFECTS`).
 */
const RENDERED_TURN_TODAY: Readonly<Record<string, string>> = {
  "continue@default": "Continue your previous answer.",
  "continue@litert":
    "Continue your previous answer."
    + "\n\nAnswer directly and briefly. For a single factual question, give the answer first and stop. For a short follow-up, make only the requested change.",
  "shorter@default":
    "why do leaves change colour in the autumn"
    + "\n\nKeep it short. Lead with the answer itself.",
  "shorter@litert":
    "why do leaves change colour in the autumn"
    + "\n\nKeep it short. Lead with the answer itself.",
  "expand@default":
    "why do leaves change colour in the autumn"
    + "\n\nGo deeper — cover what this is actually like in practice, not just the definition."
    + "\n\nLead with a plain-language explanation, then develop the details that matter — reasons, examples, practical implications.",
  "expand@litert":
    "why do leaves change colour in the autumn"
    + "\n\nGo deeper — cover what this is actually like in practice, not just the definition."
    + "\n\nLead with the direct answer, then cover the essential details in at most three concise paragraphs or bullets. Stop when the distinction is clear.",
  "simplify@default":
    "why do leaves change colour in the autumn"
    + "\n\nKeep it simple. Explain it in plain, everyday language.",
  "simplify@litert":
    "why do leaves change colour in the autumn"
    + "\n\nKeep it simple. Explain it in plain, everyday language.",
};

/**
 * ★ A LIST, NOT A COUNT, and deliberately two-sided.
 *
 * `hasExplicitFormatInstruction` is the hint-suppression detector: when it
 * returns true the per-turn hint is dropped entirely. That is the ONLY
 * mechanism by which a closed-direction directive survives to the model
 * unopposed — there is no directive-aware special case anywhere in the
 * pipeline — so the two shipped closed directives are chosen AGAINST this
 * detector and pinned here by exact bytes.
 *
 * Both outcomes appear on purpose. A detector that degenerated to a constant —
 * always true, or always false — fails against one side or the other, which a
 * count of matches would not catch. `keeps both answers represented` below pins
 * that two-sidedness so a later trim cannot quietly re-create the degeneracy.
 *
 * The near-misses are the point: "Be concise.", "Shorter." and "Just the
 * answer." are how people actually ask, and none of them registers as an
 * instruction. Neither does "Explain it in plain, everyday language." on its
 * own — which is why the shipped `simplify` directive leads with "Keep it
 * simple.", and why rewording it for tone silently re-creates the defect.
 */
const DIRECTIVE_SUPPRESSION_TODAY: Readonly<Record<string, boolean>> = {
  // ── The three shipped directives, pinned by exact bytes. ─────────────────
  "Keep it short. Lead with the answer itself.": true,
  "Keep it simple. Explain it in plain, everyday language.": true,
  "Go deeper — cover what this is actually like in practice, not just the definition.": false,

  // ── The canned turn `continue` still sends. ──────────────────────────────
  "Continue your previous answer.": false,

  // ── Recognised as instructions ───────────────────────────────────────────
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
  "Explain it in plain, everyday language.": false,
  "Say it in fewer words.": false,
  "Cut it down.": false,
  "Trim it.": false,
  "Shorten it.": false,
  "Too long.": false,
  "Half the length.": false,
  "Make it shorter.": false,
  "Less detail please.": false,
  "Give me the short version.": false,
};

describe("reply recovery — what pressing each control does today, pinned exactly", () => {
  for (const control of CONTROLS) {
    it(`samples "${control}" unchanged on every catalog model`, () => {
      const actual: Record<string, string> = {};
      for (const modelId of CATALOG_MODEL_IDS) {
        actual[modelId] = compact(resolveControl(control, modelId));
      }
      expect(actual).toEqual(CONTROL_SAMPLING_TODAY[control]);
    });
  }

  it("routes the typed equivalent unchanged on every catalog model", () => {
    const actual: Record<string, string> = {};
    for (const modelId of CATALOG_MODEL_IDS) {
      actual[modelId] = compact(resolveTypedTurn(TYPED_EQUIVALENT, modelId));
    }
    expect(actual).toEqual(TYPED_ROUTING_TODAY);
  });

  it("admits exactly these models to the open direction", () => {
    const actual: Record<string, boolean> = {};
    for (const modelId of CATALOG_MODEL_IDS) {
      actual[modelId] = canDeepen(modelId);
    }
    expect(actual).toEqual(DEEPENABLE_TODAY);
  });

  it("renders each turn to the model unchanged", () => {
    const actual: Record<string, string> = {};
    for (const control of CONTROLS) {
      actual[`${control}@default`] = renderControlTurn(control, PREFERRED_DEFAULT_MODEL_ID);
      actual[`${control}@litert`] = renderControlTurn(control, LITERT_MODEL_ID);
    }
    expect(actual).toEqual(RENDERED_TURN_TODAY);
  });

  it("emits no hint outside the pinned set, on any model", () => {
    // Covers the five models not rendered in full above: if any of them ever
    // produces a further hint variant, it shows up here instead of going
    // unmeasured.
    const distinct = new Set<string>();
    for (const control of CONTROLS) {
      for (const modelId of CATALOG_MODEL_IDS) {
        distinct.add(hintFor(control, modelId));
      }
    }
    const pinned = new Set(
      Object.entries(RENDERED_TURN_TODAY).map(([key, turn]) => {
        const composed = composedTurn(key.split("@")[0] as AssistantReplyControl);
        return turn === composed ? "" : turn.slice(composed.length + 2);
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
    // The strings above are COPIES of literals in the shipping modules. Without
    // this, rewording a shipping string would leave every assertion in this file
    // green while measuring text the product no longer sends — the exact way a
    // pin becomes decoration.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const treatments = readFileSync(path.resolve(here, "../lib/reply-controls.ts"), "utf8");
    for (const control of REGENERATE_CONTROLS) {
      const { directive } = REPLY_CONTROL_TREATMENTS[control];
      expect(
        treatments.includes(directive),
        `lib/reply-controls no longer ships ${JSON.stringify(directive)} for "${control}". `
          + `A directive is chosen against hasExplicitFormatInstruction, never reworded for `
          + `tone — re-read DIRECTIVE_SUPPRESSION_TODAY before changing anything here.`,
      ).toBe(true);
    }
    const manager = readFileSync(path.resolve(here, "../hooks/useConversationManager.ts"), "utf8");
    expect(
      manager.includes(`const CONTINUE_TURN = ${JSON.stringify(CONTINUE_TURN)}`),
      `useConversationManager no longer sends ${JSON.stringify(CONTINUE_TURN)} for "continue". `
        + `Update CONTINUE_TURN here and re-read every pin below.`,
    ).toBe(true);
  });

  it("measures against models a user can actually be served", () => {
    expect(CATALOG_MODEL_IDS).toContain(PREFERRED_DEFAULT_MODEL_ID);
    expect(CATALOG_MODEL_IDS).toContain(LITERT_MODEL_ID);
    expect(CATALOG_MODEL_IDS.length).toBeGreaterThanOrEqual(6);
  });

  it("covers every regenerating control the app ships", () => {
    // Derived from the shipping table, so a fourth treatment cannot be added
    // without the fact tables above noticing.
    expect([...REGENERATE_CONTROLS].sort()).toEqual(["expand", "shorter", "simplify"]);
  });

  it("the example ask carries a hint of its own", () => {
    // ★ THE COUNTERWEIGHT on every suppression assertion below. If routing ever
    // stopped appending a hint to an ordinary everyday ask, "the closed
    // directives suppress the hint" would pass while measuring nothing.
    const bare = buildHintedUserTurn(
      EXAMPLE_ASK,
      inferTurnIntent(EXAMPLE_ASK, HAS_PRIOR_TURNS),
      true,
      PREFERRED_DEFAULT_MODEL_ID,
    );
    expect(bare.startsWith(`${EXAMPLE_ASK}\n\n`)).toBe(true);
    expect(bare.length).toBeGreaterThan(EXAMPLE_ASK.length + 2);
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

  it("resolves every control identically with and without prior turns", () => {
    // The shape classifier consults `hasPriorTurns`, and it is derived from a
    // position in a SLIDING window — so it can flip mid-conversation once
    // context eviction moves the window start. These turns are insensitive to it
    // today, which is what makes every pin above stable. If that changes, the
    // pins become conditional on a state nothing here controls, and this says so
    // rather than letting the sweep quietly measure one of two worlds.
    for (const control of CONTROLS) {
      const composed = composedTurn(control);
      expect(
        inferTurnIntent(composed, false),
        `"${control}" now renders differently depending on window position`,
      ).toBe(inferTurnIntent(composed, true));
    }
  });
});

// ---------------------------------------------------------------------------
// What the fix changed. These replaced deleted KNOWN_DEFECTS entries, and they
// assert the FIXED behaviour — a regression fails them by name.
// ---------------------------------------------------------------------------

describe("reply recovery — what the fix changed", () => {
  it("no longer makes shorter, expand and simplify one request", () => {
    // ★ REPLACES the `shorter-expand-simplify-are-one-request` defect entry.
    //
    // What separates them is the TREATMENT — a forced intent plus a directive —
    // not the sampling alone: `shorter` and `simplify` both force `quick` and so
    // share a profile, and on a model with a flat ladder `expand` differs from
    // them only by temperature. Comparing profiles would therefore understate
    // the fix on some models; comparing treatments is the property wanted.
    //
    // ★ CHEAPEST SATISFYING CHANGE: three directives that differ only
    // cosmetically. `classifies every directive string unchanged` pins each
    // one's detector verdict by exact bytes, and the two closed directives must
    // land on the opposite side from `expand`'s, so a cosmetic split fails there.
    const treatments = REGENERATE_CONTROLS.map((control) => {
      const { intent, directive } = REPLY_CONTROL_TREATMENTS[control];
      return `${intent} ${directive}`;
    });
    expect(new Set(treatments).size).toBe(REGENERATE_CONTROLS.length);
    // And the open direction really does reach a different budget wherever the
    // model has one — which is the part `shorter`/`simplify` cannot fake.
    for (const modelId of CATALOG_MODEL_IDS.filter((id) => canDeepen(id))) {
      expect(
        resolveControl("expand", modelId).maxTokens,
        `"expand" no longer reaches a bigger budget than "shorter" on ${modelId}`,
      ).toBeGreaterThan(resolveControl("shorter", modelId).maxTokens);
    }
  });

  it("no longer contradicts the user on the closed direction", () => {
    // ★ REPLACES the `the-hint-contradicts-the-user` defect entry.
    //
    // The turn used to end with our instruction to develop the answer, arriving
    // after the user's request for a shorter one and winning by recency. Both
    // closed directives now trip the existing suppression detector, so the turn
    // ends with the directive on every model we ship.
    //
    // ★ CHEAPEST SATISFYING CHANGE: a hint pipeline that appends nothing at all.
    // `the example ask carries a hint of its own` fails on it.
    for (const control of ["shorter", "simplify"] as const) {
      const { directive } = REPLY_CONTROL_TREATMENTS[control];
      expect(
        hasExplicitFormatInstruction(directive),
        `the "${control}" directive no longer suppresses the per-turn hint — the hint would `
          + `land after it and win by recency, which is the defect this replaced.`,
      ).toBe(true);
      for (const modelId of CATALOG_MODEL_IDS) {
        expect(
          renderControlTurn(control, modelId),
          `"${control}" now carries a hint after its directive on ${modelId}`,
        ).toBe(`${EXAMPLE_ASK}\n\n${directive}`);
      }
    }
  });

  it("no longer costs more to press shorter than to type it", () => {
    // ★ REPLACES the `pressing-shorter-costs-more-than-typing-it` defect entry.
    //
    // The button used to route `explain` while a person's own words routed
    // `quick` — a hotter sampler on all seven models and, on the four with
    // headroom, a bigger ceiling too. Forcing the intent removes the gap
    // entirely rather than narrowing it.
    //
    // ★ CHEAPEST SATISFYING CHANGE: raise the TYPED side to match the pressed
    // side. `routes the typed equivalent unchanged` pins all seven typed values
    // at `quick` and fails on it.
    for (const modelId of CATALOG_MODEL_IDS) {
      expect(
        resolveControl("shorter", modelId),
        `pressing "Make shorter" no longer matches typing it on ${modelId}`,
      ).toEqual(resolveTypedTurn(TYPED_EQUIVALENT, modelId));
    }
    expect(resolveControl("shorter", PREFERRED_DEFAULT_MODEL_ID).maxTokens).toBe(1024);
  });

  it("no longer hands expand a budget below the model's own depth ceiling", () => {
    // ★ REPLACES the budget half of `expand-tells-litert-to-stop`. The hint half
    // is still live and stays in KNOWN_DEFECTS below.
    for (const modelId of CATALOG_MODEL_IDS) {
      expect(
        resolveControl("expand", modelId).maxTokens,
        `"expand" is below the depth ceiling on ${modelId}`,
      ).toBe(getGenerationProfile("deep", true, modelId).maxTokens);
    }
    // On LiteRT specifically, that is 1536 where the control used to get 768.
    expect(resolveControl("expand", LITERT_MODEL_ID).maxTokens).toBe(1536);
  });
});

// ---------------------------------------------------------------------------
// The judged layer. Every entry asserts CURRENT behaviour, so a fix fails here.
// ---------------------------------------------------------------------------

const KNOWN_DEFECTS = {
  "expand-still-appends-a-stop-hint-on-litert": [
    "The open direction cannot suppress the per-turn hint, and on",
    "`candidate/gemma-4-e2b-litert` that hint is a stop instruction. Suppression is",
    "`hasExplicitFormatInstruction` (answer-shape.ts) reading the turn's own bytes, and it",
    "detects brevity and format instructions — so the two closed directives trip it while no",
    "honest way of asking for MORE depth does. The hint that lands after the `expand`",
    "directive is therefore whatever the composed turn routes to, and on LiteRT",
    "`buildTurnQualityInstruction` (chat-intent.ts) branches on `isGemma4LiteRtModel` and",
    "overrides the `explain` hint with its own compact wording — 'at most three concise",
    "paragraphs or bullets. Stop when the distinction is clear.' That arrives AFTER our",
    "directive to go deeper, where the Wave-2.6 recency measurement says it wins. The budget",
    "half of this defect is fixed: forcing `deep` moves the ceiling from 768 to 1536 on that",
    "model. The wording half needs either a LiteRT depth hint that does not curtail, or an",
    "open-direction suppression path that does not exist today.",
  ].join(" "),
} as const;

type Defect = keyof typeof KNOWN_DEFECTS;

describe("reply recovery — known defects stay visible", () => {
  it("points every defect it names at code that exists", () => {
    // ★ THIS REPLACED A CHARACTER COUNT. The old form asserted `length > 200`
    // under the name "explains every defect it names" — satisfiable by padding
    // the prose with filler, which is the same defect this suite exists to
    // catch, sitting in its own instrument. A citation is checkable; prose
    // length is not.
    //
    // It also catches staleness, which the count never could: rename a symbol or
    // delete `answer-shape.ts` and every mechanism still citing them fails here
    // by name instead of quietly describing code that no longer exists.
    //
    // ★ WHAT IT DOES NOT MEASURE. The cheapest change that satisfies it without
    // helping a reader is to cite a real but IRRELEVANT file. That is accepted
    // deliberately — it is a large improvement over a character count, it cannot
    // be reached by prose alone, and any guard that tried to judge relevance
    // would be a prose heuristic again. Read a pass as "this points at real
    // code", never as "this is correct".
    for (const defect of Object.keys(KNOWN_DEFECTS) as Defect[]) {
      const { resolved, staleFiles } = checkSourceCitations(KNOWN_DEFECTS[defect]);
      expect(
        staleFiles,
        `${defect} cites a file that does not exist — the mechanism has gone stale`,
      ).toEqual([]);
      expect(
        resolved.length,
        `${defect} names no file or symbol that resolves against the source tree. `
          + `Cite the code it describes — a label is not an explanation.`,
      ).toBeGreaterThan(0);
    }
  });

  it("expand-still-appends-a-stop-hint-on-litert", () => {
    // ★ CHEAPEST SATISFYING CHANGE: none that helps — the assertion names the
    // curtailing clause in the hint the LiteRT model actually receives for
    // `expand`, so it only goes green when that turn stops being told to stop.
    const hint = hintFor("expand", LITERT_MODEL_ID);
    expect(
      hint,
      `"Expand" no longer receives a curtailing hint on ${LITERT_MODEL_ID}. If that was the `
        + `fix, delete this entry and update RENDERED_TURN_TODAY — do not relax it.`,
    ).toContain("Stop when");
    expect(hint).toContain("at most three concise paragraphs");
    // And it arrives after our directive, which is what makes it a contradiction
    // rather than merely unhelpful.
    const turn = renderControlTurn("expand", LITERT_MODEL_ID);
    expect(turn.indexOf("Stop when")).toBeGreaterThan(turn.indexOf("Go deeper"));
  });

  it("still suppresses the hint somewhere, so the defect is specific", () => {
    // ★ THE COUNTERWEIGHT. "expand still gets a curtailing hint on LiteRT" is
    // also satisfied by a suppression detector that has stopped suppressing
    // anywhere — a far bigger regression, reading as this defect holding steady.
    // The closed direction on the same model is the control.
    expect(renderControlTurn("shorter", LITERT_MODEL_ID)).not.toContain("Stop when");
  });
});
