// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The standing net under LONG_FORM_RE and DEEP_RE.
 *
 * WHAT THIS EXISTS TO PREVENT. Both constants were once bare word lists —
 * `/\b(long|detailed|full|complete|comprehensive|…)\b/` and
 * `/\b(analyze|compare|evaluate|strategy|plan|deep|…)\b/`. They read as
 * obviously right and were measurably wrong: on a corpus of 53 ordinary
 * everyday turns that merely CONTAIN one of those words — "how long do you
 * boil eggs", "my phone plan is 90 dollars a month", "is deep frying a turkey
 * actually dangerous" — all 53 routed to `deep`, taking the 2048-token budget
 * and the instruction "Use clear sections; include concrete recommendations
 * and tradeoffs". A hundred percent false-positive rate on the phrasings that
 * dominate real usage. They also under-fired, missing "explain in detail …".
 *
 * The bare-word form is the attractor here: it is shorter, it looks cleaner,
 * and every future reader will be tempted to collapse the shipped constants
 * back into one. This file is what makes that a failing test instead of a
 * silent regression, so the corpora it reads
 * (`__tests__/fixtures/depth-word-inputs.ts`) are the point, not decoration.
 *
 * ★ ASSERTED AT TWO LAYERS ON PURPOSE.
 *   - Claims about the REGEXES (near-misses must match nothing, verb-clause
 *     phrasings must all match) are asserted against `LONG_FORM_RE` /
 *     `DEEP_RE` directly. Routing them through `inferChatIntent` would let an
 *     unrelated cascade branch mask a regex regression.
 *   - Claims about ROUTING (which everyday turns end up at `deep`) are
 *     asserted against the real `inferChatIntent`, because that is what
 *     decides the budget and the hint a user actually receives.
 *
 * ★ EVERY ASSERTION PINS A LIST, NEVER A COUNT. A count stays green when one
 * item is fixed and another breaks. Each expectation below names its exact
 * expected members so a two-directional move reads as one.
 *
 * ★ NEVER edit a corpus item, or move an item between the pinned lists, to
 * make this pass. If behaviour changed deliberately, say so in the pin.
 */

import { describe, expect, it } from "vitest";

import { DEEP_RE, LONG_FORM_RE } from "../answer-shape";
import { inferChatIntent, type ChatIntent } from "../chat-intent";
import {
  DEPTH_REGEX_NEAR_MISSES,
  DEPTH_REGEX_VERB_CLAUSE_KEEPS,
  GENUINE_DEPTH_INPUTS,
  HELD_OUT_DEPTH_INPUTS,
  INNOCENT_DEPTH_WORD_INPUTS,
} from "../../__tests__/fixtures/depth-word-inputs";

/** Whether either depth constant claims this turn. The regex-layer question. */
function matchesADepthRegex(text: string): boolean {
  return LONG_FORM_RE.test(text) || DEEP_RE.test(text);
}

function intentOf(text: string): ChatIntent {
  return inferChatIntent(text);
}

// ---------------------------------------------------------------------------
// Layer 1 — claims about the regexes themselves.
// ---------------------------------------------------------------------------

describe("depth regexes — what the constants match", () => {
  it("matches none of the adversarial near-misses", () => {
    // Two earlier candidates were rejected here. A looser verb clause ("go"
    // rather than "go over", "in full" as an idiom) matched "i need to go pay
    // the balance in full before friday"; a single adjective class matched
    // "a long list of chores" and "a long history of the building".
    expect(DEPTH_REGEX_NEAR_MISSES.filter(matchesADepthRegex)).toEqual([]);
  });

  it("keeps every verb-clause phrasing that genuinely asks for thoroughness", () => {
    // The counterweight to the test above: the near-miss set is satisfiable by
    // deleting the verb clause outright, and this is what stops that.
    expect(DEPTH_REGEX_VERB_CLAUSE_KEEPS.filter(matchesADepthRegex)).toEqual([
      "explain it thoroughly please",
      "go over it thoroughly with me",
      "can you describe the process thoroughly",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — claims about routing.
// ---------------------------------------------------------------------------

/**
 * The four innocent turns that still reach `deep` THROUGH A DEPTH REGEX, and
 * why each is an accept rather than an outstanding bug.
 */
const INNOCENT_STILL_DEEP_VIA_DEPTH_REGEX: readonly string[] = [
  // The user literally said "compare". `deep` is expensive here, not untrue.
  "can you compare these two prices for me, 4.99 for 12oz vs 7.49 for 20oz",
  "compare my old rent to the new one, 1400 vs 1675, how much more per year",
  // "strategy for" — genuinely an approach question.
  "is there a strategy for winning at connect four",
  // The "step by step" idiom is kept deliberately; it is the single most
  // reliable explicit request for a walkthrough people type.
  "the step by step instructions in the box are missing a page",
];

/**
 * The one innocent turn that reaches `deep` through a DIFFERENT constant.
 *
 * Pinned separately so a future PLURALITY_RE change cannot be misread as a
 * depth-regex regression, and so nobody tries to fix it by touching
 * LONG_FORM_RE or DEEP_RE — neither of them matches this turn at all.
 */
const INNOCENT_STILL_DEEP_VIA_PLURALITY_RE: readonly string[] = [
  "i cant think through all this noise, any tips for focusing",
];

describe("depth routing — ordinary turns that merely contain a depth word", () => {
  it("routes exactly these five to deep, and no other of the fifty-three", () => {
    const stillDeep = INNOCENT_DEPTH_WORD_INPUTS.filter((text) => intentOf(text) === "deep");
    expect(stillDeep).toEqual([
      ...INNOCENT_STILL_DEEP_VIA_DEPTH_REGEX,
      ...INNOCENT_STILL_DEEP_VIA_PLURALITY_RE,
    ]);
  });

  it("attributes each surviving deep turn to the constant that actually claims it", () => {
    for (const text of INNOCENT_STILL_DEEP_VIA_DEPTH_REGEX) {
      expect(matchesADepthRegex(text), `no depth regex claims "${text}"`).toBe(true);
    }
    for (const text of INNOCENT_STILL_DEEP_VIA_PLURALITY_RE) {
      expect(matchesADepthRegex(text), `a depth regex now claims "${text}"`).toBe(false);
      expect(intentOf(text)).toBe("deep");
    }
  });

  it("shows the plurality turn is carried by its plurality phrase, not a depth word", () => {
    // Same sentence, same "think through", "tips for" removed: it drops out of
    // `deep`. That is the positive attribution — the trigger is PLURALITY_RE
    // (answer-shape.ts), which this change never touched and which no edit to
    // LONG_FORM_RE or DEEP_RE can reach.
    expect(intentOf("i cant think through all this noise, any tips for focusing")).toBe("deep");
    expect(intentOf("i cant think through all this noise, any help with focusing")).not.toBe(
      "deep",
    );
  });

  it("never sends a freed turn somewhere MORE expensive than deep", () => {
    // The narrowing must not trade a wrong `deep` for a wrong `research` or
    // `file` — both of which budget 2048 and carry their own instruction.
    const escalated = INNOCENT_DEPTH_WORD_INPUTS.filter((text) =>
      (["research", "file"] as const).includes(intentOf(text) as "research" | "file"),
    );
    expect(escalated).toEqual([]);
  });
});

describe("depth routing — turns that really are asking for depth", () => {
  it("routes all twenty-five to deep", () => {
    // Recall is the axis a narrowing is most likely to cost, so this pins the
    // members rather than the tally. The last item MISSED before 2026-07-27:
    // the old constant carried the idiom "in depth" and not "in detail".
    expect(GENUINE_DEPTH_INPUTS.filter((text) => intentOf(text) === "deep")).toEqual([
      ...GENUINE_DEPTH_INPUTS,
    ]);
  });
});

/**
 * The held-out set was written AFTER the narrowed constants existed, to catch
 * overfitting to the corpus they were tuned against. Twelve of fifteen reach
 * `deep`; these three do not, and each is a KNOWN miss with a named cause.
 *
 * Two of them missed before the narrowing as well. The first did not, and its
 * cause has never been a depth regex:
 *
 *   It routed `writing` while `WRITING_RE` still matched the bare word `story`.
 *   That regex was narrowed on 2026-07-27 (`story` now needs an authoring verb
 *   governing it), so the turn falls through to the shape classifier and lands
 *   `explain` — a different wrong answer, one budget step closer to right, and
 *   still not `deep`.
 *
 *   Do NOT add `story` to LONG_FORM_RE's deliverable nouns to force `deep`.
 *   That was measured and rejected: it fires on the pasted BODY of ordinary
 *   messages ("the flight thing was the whole story"), which is how a person
 *   asking for feedback on an apology ends up being handed a lecture. Reaching
 *   this turn honestly means recognising "the full story on X" as a request for
 *   a complete account, which no current constant does.
 */
const HELD_OUT_KNOWN_MISSES: readonly { input: string; intent: ChatIntent }[] = [
  // Falls through to the shape classifier now that WRITING_RE needs more than a
  // bare `story`. Was `writing` until 2026-07-27.
  { input: "give me the full story on why the roman empire fell", intent: "explain" },
  // No depth word and no depth idiom — a deliberate non-match, not a leak.
  { input: "what should i consider when choosing a college", intent: "explain" },
  // Short enough to read as a single-fact ask; also missed before the narrowing.
  { input: "whats the best approach to potty training", intent: "quick" },
];

describe("depth routing — held-out phrasings the constants were not tuned on", () => {
  it("misses exactly the three documented turns, each for its recorded reason", () => {
    const missed = HELD_OUT_DEPTH_INPUTS.filter((text) => intentOf(text) !== "deep").map(
      (text) => ({ input: text, intent: intentOf(text) }),
    );
    expect(missed).toEqual(HELD_OUT_KNOWN_MISSES);
  });

  it("reaches deep on every other held-out phrasing", () => {
    const missedInputs = new Set(HELD_OUT_KNOWN_MISSES.map((m) => m.input));
    expect(HELD_OUT_DEPTH_INPUTS.filter((text) => intentOf(text) === "deep")).toEqual(
      HELD_OUT_DEPTH_INPUTS.filter((text) => !missedInputs.has(text)),
    );
  });
});
