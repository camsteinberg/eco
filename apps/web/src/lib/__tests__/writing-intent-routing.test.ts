// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The standing net under `WRITING_RE`, and the record of what narrowing it cost.
 *
 * WHAT CHANGED. `WRITING_RE` was a list of bare words — `write|rewrite|draft|
 * tone|copy|email|essay|story|post|message|headline|recipe|cook|bake|meal plan|
 * ingredients?`. Every one of them is an ordinary English word people type
 * without asking anyone to write anything, so "how long do i cook a 12 pound
 * turkey" was a drafting task, "long story short my landlord kept my deposit"
 * was a drafting task, and a pasted `EXPLAIN ANALYZE` plan was correspondence
 * because `\bemail\b` matched inside `c.email`.
 *
 * On 2026-07-27 the constant became three shapes: tokens that are about text
 * whatever follows them; an authoring verb governing an ambiguous text noun;
 * and `draft` licensed only by a text object. `cook`, `bake` and `ingredients`
 * were deleted outright. Every arm still requires a token the old form matched
 * bare, which makes this a STRICT NARROWING — asserted below, not assumed.
 *
 * ★ THIS FILE EXISTS MOSTLY TO RECORD A REGRESSION. See the final block. The
 * sweep that would otherwise have caught it asserts nothing about intent, so
 * without this pin the change reads as an unqualified win and the cost is
 * recorded nowhere. It is a real cost paid by a real person: someone asking
 * whether their apology to a friend sounds sincere is now told to produce
 * sections and tradeoffs.
 *
 * ★ NEVER close that regression by reintroducing a bare `story` token. The
 * tests here fail if you do, on purpose.
 */

import { describe, expect, it } from "vitest";

import {
  getGenerationProfile,
  inferChatIntent,
} from "../chat-intent";
import { DEEP_RE, LONG_FORM_RE, inferAnswerShape } from "../answer-shape";
import { isTextRepairAsk, isTextTransformAsk } from "../ask-text";
import { tierDefaultModelId } from "../../local-ai/selection/recommend";
import { REALISTIC_INPUTS } from "../../__tests__/fixtures/realistic-inputs";
import { EVERYDAY_USE_CORPUS } from "../../__tests__/fixtures/everyday-use-corpus";
import {
  GENUINE_DEPTH_INPUTS,
  HELD_OUT_DEPTH_INPUTS,
  INNOCENT_DEPTH_WORD_INPUTS,
} from "../../__tests__/fixtures/depth-word-inputs";

/**
 * `WRITING_RE` exactly as it read before 2026-07-27. Kept as a historical
 * constant so the strict-narrowing property can be asserted rather than
 * asserted-in-a-comment. Do not edit it — it is a record, not a config.
 */
const WRITING_RE_BEFORE_NARROWING =
  /\b(write|rewrite|draft|tone|copy|email|essay|story|post|message|headline|summarize in my voice|recipe|cook|bake|meal plan|ingredients?)\b/i;

describe("writing intent — words that were deleted outright", () => {
  it("no longer reads cooking and baking as drafting tasks", () => {
    // `cook`, `bake` and `ingredients` are gone from the constant entirely.
    // These were claimed as `writing` — the 1536-token middle plus "Match the
    // requested format and tone" — for asking about a turkey.
    expect(inferChatIntent("how long do i cook a 12 pound turkey")).toBe("quick");
    expect(inferChatIntent("i need to bake a cake for saturday")).not.toBe("writing");
    expect(inferChatIntent("what ingredients do i need for pancakes")).not.toBe("writing");
  });
});

describe("writing intent — words demoted from bare tokens to governed nouns", () => {
  it("does not route an ambiguous text noun standing on its own", () => {
    // Each of these contains a word the old constant matched bare.
    expect(inferChatIntent("long story short my landlord kept my deposit, what do i do")).toBe(
      "explain",
    );
    expect(inferChatIntent("did you see her post about the wedding")).not.toBe("writing");
    expect(inferChatIntent("his tone was really off at dinner")).not.toBe("writing");
    expect(inferChatIntent("theres a draft under the door")).not.toBe("writing");
    expect(inferChatIntent("draft beer is on tap tonight")).not.toBe("writing");
    expect(inferChatIntent("my fantasy football draft is tuesday")).not.toBe("writing");
  });

  it("still routes the same nouns when an authoring verb governs them", () => {
    // The counterweight: the test above is satisfiable by deleting the arm.
    expect(inferChatIntent("can you rewrite this email to sound warmer")).toBe("writing");
    expect(inferChatIntent("edit the tone of this post")).toBe("writing");
    expect(inferChatIntent("help me draft a message to my boss")).toBe("writing");
    expect(inferChatIntent("reword this message so it sounds friendlier")).toBe("writing");
    expect(inferChatIntent("write me a poem")).toBe("writing");
  });

  it("does not read a dot-qualified identifier as correspondence", () => {
    // `(?<!\.)` — a pasted query plan is code, not an email.
    expect(
      inferChatIntent("SELECT c.email FROM customers c JOIN orders o ON o.customer_id = c.id"),
    ).not.toBe("writing");
  });
});

describe("writing intent — the narrowing is subtractive apart from two named widenings", () => {
  /**
   * ★ THE WIDENINGS, named as this block demanded any widening be named.
   *
   * This assertion read `toEqual([])` and was described as strictly
   * subtractive, with the note that a future widening "lands here as a named
   * string rather than as a silent behaviour change, and has to be justified on
   * its own evidence". There are now two, each a sibling predicate in
   * `lib/ask-text.ts`, each routing the ASK (not the paste) to `writing`:
   *
   * 1. `isTextRepairAsk` — the original widening. Measured over two live
   *    batches on the shipping 2B, `deliversUnburied` averaged 0.42 across the
   *    turns routed `deep` and 0.91 across those routed `writing`, and every one
   *    of these five was landing on `deep` — collecting "include concrete
   *    recommendations and tradeoffs" in reply to "fix my spelling".
   *
   * 2. `isTextTransformAsk` — the transform family ("make this more formal",
   *    "summarize this", "make it sound less passive aggressive"). Measured on
   *    the shipping 1.2B (headed WebGPU, two batches): these fell through to
   *    `explain` and the model followed the explain hint verbatim — "**Plain-
   *    language explanation:** you want the message to sound…" — instead of
   *    returning the rewrite. Routing them to `writing` removes the hint that
   *    was causing the deferral.
   *
   * Each entry below is a repair ask OR a transform ask and nothing else. That
   * property is the one worth guarding: the check asserts not just that the
   * lists match, but that every entry is one or the other, so a widening that
   * let a third category through could not hide inside an updated list.
   */
  const NEWLY_WRITING_REPAIR_ASKS: readonly string[] = [
    "fix the spelling and grammar but dont change my voice",
    "hi can you check this for mistakes please.",
    "Could you please fix my spelling in this letter to my granddaughter.",
    "can you fix the typos and grammar.",
    "can someone proofread this before i send it to my crew, just typos and grammar.",
  ];

  const NEWLY_WRITING_TRANSFORM_ASKS: readonly string[] = [
    "can you summarize this? too long",
    "can you make this less angry?",
    "can u make this sound less passive aggressive",
    "can you make this better but dont make it sound like ai",
  ];

  it("routes nothing new to writing except text-repair and text-transform asks", () => {
    const corpus: readonly string[] = [
      ...REALISTIC_INPUTS.map((sample) => sample.text),
      ...EVERYDAY_USE_CORPUS.map((item) => item.userInput),
      ...INNOCENT_DEPTH_WORD_INPUTS,
      ...GENUINE_DEPTH_INPUTS,
      ...HELD_OUT_DEPTH_INPUTS,
    ];
    const newlyWriting = corpus.filter(
      (text) => inferChatIntent(text) === "writing" && !WRITING_RE_BEFORE_NARROWING.test(text),
    );

    // Every newly-routed turn is a repair ask or a transform ask — no other
    // category slipped in.
    expect(
      newlyWriting.filter((text) => !isTextRepairAsk(text) && !isTextTransformAsk(text)),
    ).toEqual([]);

    // And it is exactly these nine, identified by the instruction each opens with.
    const namedFragments = [...NEWLY_WRITING_REPAIR_ASKS, ...NEWLY_WRITING_TRANSFORM_ASKS];
    expect(newlyWriting.length).toBe(namedFragments.length);
    for (const fragment of namedFragments) {
      expect(
        newlyWriting.some((text) => text.includes(fragment)),
        `no newly-writing turn contains "${fragment}"`,
      ).toBe(true);
    }
  });
});

describe("writing intent — the transform family routes to writing, not explain", () => {
  // Each of these fell through the cascade to `explain` before the
  // `isTextTransformAsk` widening; the explain hint then made the 1.2B lecture
  // about the text instead of returning it transformed (measured, headed WebGPU).
  it("routes 'make this more formal' to writing", () => {
    expect(
      inferChatIntent("make this more formal: 'hey can u send me that file whenever, no rush thx'"),
    ).toBe("writing");
  });

  it("routes 'shorten this into a text message' to writing", () => {
    expect(
      inferChatIntent("shorten this into a text message: 'i am running about fifteen minutes late'"),
    ).toBe("writing");
  });

  it("routes 'summarize this in one sentence' to writing", () => {
    expect(
      inferChatIntent("summarize this in one sentence: 'the museum closes early on friday'"),
    ).toBe("writing");
  });

  // TR-1 widening (2026-08-16): the natural phrasings PR #154 missed — measured
  // on the real 1.2B, these ALSO fell through to explain and were lectured at
  // (make-it-shorter came back several times LONGER, with "Why this matters"
  // sections; polish leaked "Plain-language explanation:" verbatim).
  it("routes the TR-1 transform phrasings to writing", () => {
    for (const ask of [
      "make this shorter: 'the meeting moved to thursday at ten, please update your calendars'",
      "make this punchier: 'our app helps you keep track of your daily tasks'",
      "tidy this up: 'so basically i went to the store and the bank'",
      "polish this: 'thanks, looks fine, lets go with it'",
      "soften this: 'send me the report today'",
      "bullet point this: 'book the hotel, rent a car, get insurance'",
      "translate this to spanish: 'what time does the meeting start'",
    ]) {
      expect(inferChatIntent(ask), ask).toBe("writing");
    }
  });

  it("leaves explain-overlap comparatives on their non-writing route", () => {
    expect(inferChatIntent("make it easier for me to understand recursion")).not.toBe("writing");
    expect(inferChatIntent("make it clearer")).not.toBe("writing");
  });

  it("does not pull a plain 'make <a noun>' creation ask into writing", () => {
    expect(inferChatIntent("please make a study guide for calc 1")).not.toBe("writing");
    expect(inferChatIntent("turn this into a grocery list: spaghetti for 4")).not.toBe("writing");
  });
});

// ---------------------------------------------------------------------------
// ★ THE KNOWN REGRESSION. Recorded because nothing else records it.
// ---------------------------------------------------------------------------

/**
 * `personal-writing/friend-apology-message` — a person pastes the apology they
 * wrote to a friend whose wedding they missed and asks "Does it sound sincere
 * or does it sound like I'm making excuses?".
 *
 * BEFORE: `writing`, 1536 tokens, "Match the requested format and tone; avoid
 * filler." Right for the wrong reason — it matched the bare word `story` inside
 * the pasted apology ("I'm not going to pretend the flight thing was the whole
 * story"), i.e. it read the paste, not the ask.
 *
 * AFTER: `deep`, 2048 tokens, "Use clear sections; include concrete
 * recommendations and tradeoffs." Someone asking whether an apology to a friend
 * sounds sincere is instructed to produce sections and tradeoffs.
 *
 * THE TRUE MECHANISM IS NOT `WRITING_RE`. The turn carries no depth word at all
 * — both depth constants decline it, asserted below. It landed `deep` purely
 * because the pasted apology is longer than 360 characters and
 * `inferAnswerShape`'s length catch-all read any long turn as a request for a
 * lecture. The narrowing did not create this; it removed an accidental shield
 * that a paste-reading bug was providing. Closing the length catch-all is what
 * fixes it — the answer is never to re-add a bare `story` token, which would
 * restore the correct budget by restoring the bug that produced it.
 *
 * ★ NOW: `explain`, 1536 tokens. The length catch-all was closed the way this
 * note said it should be — `inferChatIntent` measures the INSTRUCTION and not
 * the paste (lib/ask-text.ts), so the apology's length no longer reaches the
 * shape classifier at all. The lecture instruction is gone and the budget is
 * back to the middle.
 *
 * ★ IT IS NOT FULLY RECOVERED, and the remaining half is recorded rather than
 * rounded up. `explain` still carries "develop the details that matter", which
 * is not what someone wants when they ask whether an apology sounds sincere;
 * the right home is `writing`. The repair-verb arm does not reach it — "I've
 * rewritten this like nine times" is a report, not a request, and the arm
 * (correctly) declines it. Recovering the rest means a rule for gut-check asks
 * ("does this sound X"), which is a different family and needs its own evidence.
 *
 * ★ THE W5 WIDENING WILL NOT RECOVER THIS ITEM EITHER. The ask line is "I've
 * rewritten this like nine times." — an authoring verb with no text noun after
 * it before the sentence ends, and the author arm requires the noun. W5's
 * author arm additionally covers `wrote|written|drafted` but not `re-?written`,
 * so it does not reach this line at all. If W5 intends to recover it, extending
 * that arm is the candidate change, and it needs its own false-positive
 * evidence before it ships.
 */
const APOLOGY_ITEM_ID = "personal-writing/friend-apology-message";

describe("writing intent — the apology regression, half recovered", () => {
  function apologyText(): string {
    const item = REALISTIC_INPUTS.find((sample) => sample.id === APOLOGY_ITEM_ID);
    if (item === undefined) {
      throw new Error(`${APOLOGY_ITEM_ID} is missing from the realistic-input corpus`);
    }
    return item.text;
  }

  it("no longer takes the lecture treatment, but has not reached writing", () => {
    const text = apologyText();
    const intent = inferChatIntent(text);
    expect({
      intent,
      maxTokens: getGenerationProfile(intent, true, tierDefaultModelId("eco-fast", "capable")!).maxTokens,
    }).toEqual({
      intent: "explain",
      maxTokens: 1536,
    });
  });

  it("gets there through the length catch-all, not through any depth word", () => {
    // The attribution, asserted rather than described: neither depth constant
    // claims this turn, so `teaching` can only be coming from the length rule.
    const text = apologyText();
    expect(LONG_FORM_RE.test(text)).toBe(false);
    expect(DEEP_RE.test(text)).toBe(false);
    expect(inferAnswerShape(text)).toBe("teaching");
  });

  it("stops being deep once the same words fall under the length threshold", () => {
    // The positive half of the attribution: same text, same words, truncated
    // below the 360-character catch-all — and the turn is no longer `teaching`.
    // That is what identifies the length rule as the cause.
    const truncated = apologyText().slice(0, 300);
    expect(inferAnswerShape(truncated)).not.toBe("teaching");
    expect(inferChatIntent(truncated)).not.toBe("deep");
  });

  it("is not repaired by putting a bare story token back", () => {
    // If someone "fixes" the budget by restoring bare `story` to WRITING_RE,
    // this fails — and so does the ask-line check below, which is the point:
    // the user's QUESTION contains no writing token at all, so any repair that
    // works must be reading the ask rather than the paste.
    const askLine = apologyText().split("\n")[0] ?? "";
    expect(askLine).toContain("rewritten");
    expect(WRITING_RE_BEFORE_NARROWING.test(askLine)).toBe(false);
    expect(inferChatIntent(askLine)).not.toBe("writing");
  });
});
