// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { EVERYDAY_USE_CORPUS } from "../../__tests__/fixtures/everyday-use-corpus";
import { inferTurnIntent } from "../chat-intent";

type CorpusItem = { readonly id: string; readonly userInput: string };
const CORPUS = EVERYDAY_USE_CORPUS as readonly CorpusItem[];

function intentOf(id: string): string {
  const item = CORPUS.find((entry) => entry.id === id);
  if (!item) throw new Error(`no corpus item ${id}`);
  return inferTurnIntent(item.userInput, false);
}

/**
 * ★ THE ROUTING SET, pinned. Before this change every one of these classified
 * as `deep` — because the classifier read the pasted document instead of the
 * instruction — and collected the "use clear sections; include concrete
 * recommendations and tradeoffs" hint on a proofread request.
 *
 * A row that changes here is a behaviour change to classify, not a diff hunk
 * to wave through.
 */
const PINNED_INTENTS: Readonly<Record<string, string>> = {
  // Repair asks — the user wants their text back, fixed.
  "proofread-teacher-note-esl": "writing", // "check this for mistakes"
  "proofread-birthday-caption": "writing", // "fix the spelling and stuff"
  "proofread-grandfather-letter": "writing", // "fix my spelling"
  "proofread-vet-application": "writing", // "fix the typos and grammar"
  "proofread-crew-email": "writing", // "proofread this"
  "proofread-marketplace-ad": "writing", // "clean up the spelling"
  "proofread-review-reply": "writing", // "check my spelling and grammer"
  "proofread-school-post": "writing", // "fix my typos"
  "sw-15": "writing", // "fix the spelling and grammar"

  // Genuinely an explain ask, and must STAY one: the reader wants to be told
  // what a frightening letter says, not handed a rewritten letter.
  "health-hospital-letter": "explain",

  // ★ KNOWN MISSES, pinned deliberately so they cannot be quietly "fixed" by
  // widening the repair vocabulary to fit them. All three are repair asks
  // phrased as "make this <different>", which needs the paste to resolve
  // "this" — a separate family, to be measured on its own rather than folded
  // in here. If one of these starts passing, something widened the rule.
  "school-essay-not-ai": "explain", // "make this better"
  "work-email-tone-fix": "explain", // "make this sound less passive aggressive"
  "proofread-memorial-tribute": "explain", // "knock the spelling errors out of it"
};

describe("paste-heavy asks route on the instruction, not the paste", () => {
  for (const [id, expected] of Object.entries(PINNED_INTENTS)) {
    it(`routes ${id} to ${expected}`, () => {
      expect(intentOf(id)).toBe(expected);
    });
  }

  it("no corpus item routes to deep on the strength of its paste alone", () => {
    const deepItems = CORPUS.filter(
      (item) =>
        item.userInput.trim().length > 600 && inferTurnIntent(item.userInput, false) === "deep",
    ).map((item) => item.id);
    expect(deepItems).toEqual([]);
  });

  it("is deterministic — the KV re-render contract", () => {
    for (const item of CORPUS) {
      expect(inferTurnIntent(item.userInput, false)).toBe(
        inferTurnIntent(item.userInput, false),
      );
    }
  });
});
