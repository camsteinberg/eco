// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The detector's acceptance, pinned to the corpora it was designed against.
 *
 * Recall is pinned by the real-time eval pool: every prompt in it must match,
 * because that pool IS the class the note exists for. Precision is pinned by
 * the three pools that must never draw the note — known-answer, everyday
 * conversation, and the quantum-trade budget transcript's user turns — plus
 * the deterministic-tool phrases the calculator and date tools answer exactly.
 *
 * A change that loosens the matcher shows up here as a negative pool going
 * non-zero, which is the failure that matters: a "can't check live
 * information" note under an answer that needed nothing live.
 */

import { describe, expect, it } from "vitest";

import { isRealTimeAsk } from "../detect-real-time";
import { REAL_TIME_PROBES } from "../../../local-ai/eval/real-time-probes";
import { KNOWN_ANSWER_PROBES } from "../../../local-ai/eval/known-answer-probes";
import { EVERYDAY_CONVERSATION_PROBES } from "../../../local-ai/eval/everyday-conversation-probes";
import { BUDGET_TRANSCRIPT } from "../../../local-ai/eval/quantum-trade-probes";

/** Report misses by their text, so a failure names what to look at. */
function missesIn(prompts: readonly string[], expected: boolean): string[] {
  return prompts.filter((p) => isRealTimeAsk(p) !== expected);
}

describe("isRealTimeAsk — recall on the real-time pool", () => {
  it("matches every prompt in the shipped real-time probe set", () => {
    const prompts = REAL_TIME_PROBES.map((p) => p.prompt);
    expect(prompts).toHaveLength(24);
    expect(missesIn(prompts, true)).toEqual([]);
  });

  it("matches each of the three shapes", () => {
    expect(isRealTimeAsk("plan me a night out in williamsburg this saturday")).toBe(true);
    expect(isRealTimeAsk("is jfk having delays right now")).toBe(true);
    expect(isRealTimeAsk("when is the next yankees home game")).toBe(true);
  });
});

describe("isRealTimeAsk — precision on the pools that must not draw the note", () => {
  it("matches nothing in the known-answer pool", () => {
    const prompts = KNOWN_ANSWER_PROBES.map((p) => p.prompt);
    expect(prompts.length).toBeGreaterThan(0);
    expect(missesIn(prompts, false)).toEqual([]);
  });

  it("matches nothing in the everyday-conversation pool", () => {
    const prompts = EVERYDAY_CONVERSATION_PROBES.map((p) => p.prompt);
    expect(prompts.length).toBeGreaterThan(0);
    expect(missesIn(prompts, false)).toEqual([]);
  });

  it("matches no user turn of the quantum-trade transcript", () => {
    const prompts = BUDGET_TRANSCRIPT.filter((t) => t.role === "user").map((t) => t.content);
    expect(prompts.length).toBeGreaterThan(0);
    expect(missesIn(prompts, false)).toEqual([]);
  });

  it("leaves the deterministic tool phrases alone", () => {
    // Both are answered exactly by the calculator / date tools; a
    // "can't check live information" note under a correct computed answer
    // would contradict the answer above it.
    expect(isRealTimeAsk("What's 18% of $62.50")).toBe(false);
    expect(isRealTimeAsk("what date is 6 weeks from today")).toBe(false);
    expect(isRealTimeAsk("what time is it")).toBe(false);
  });

  it("leaves ordinary asks alone", () => {
    const plainNegatives = [
      "write me a python function that sorts a list",
      "explain how photosynthesis works",
      "what is the capital of france",
      "tell me a joke",
    ];
    expect(missesIn(plainNegatives, false)).toEqual([]);
  });

  it("leaves recommendations a local model can answer alone", () => {
    // Each carries a time word and a media or game noun, and none needs live
    // information: the model's own knowledge of films, shows, board games and
    // books IS the answer. A "can't check live information" note under a good
    // suggestion is the felt false positive, so these are pinned here.
    const recommendations = [
      "what's a good movie to watch tonight",
      "good show to binge this weekend",
      "any fun board games to play tonight",
      "what's a good book to read this weekend",
      "who plays in the next avengers movie",
    ];
    expect(missesIn(recommendations, false)).toEqual([]);
  });

  it("still matches the occurrence sense of the same nouns", () => {
    // The distinction the deny set has to preserve: what is ON somewhere is a
    // real-time ask; what is worth watching is not.
    expect(isRealTimeAsk("what movies are playing near me tonight")).toBe(true);
    expect(isRealTimeAsk("is there a giants game this weekend")).toBe(true);
  });

  it("needs both axes — a bare time cue or a bare subject is not enough", () => {
    expect(isRealTimeAsk("i had a rough day today")).toBe(false);
    expect(isRealTimeAsk("how does the offside rule work in soccer")).toBe(false);
    expect(isRealTimeAsk("what causes traffic jams")).toBe(false);
  });

  it("abstains on empty and on pasted-length input", () => {
    expect(isRealTimeAsk("")).toBe(false);
    expect(isRealTimeAsk("   ")).toBe(false);
    expect(isRealTimeAsk(`${"lorem ipsum ".repeat(40)} is the L train running right now`)).toBe(
      false,
    );
  });
});
