// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { EVERYDAY_USE_CORPUS } from "../../__tests__/fixtures/everyday-use-corpus";
import { buildArtifactFrame } from "../artifact-frame";
import { isTextRepairAsk } from "../ask-text";
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

/**
 * ★ ROUTED AS A REPAIR, THEN GIVEN NO ARTIFACT FRAME.
 *
 * The classifier and the frame both answer "is this person asking for their
 * text back, fixed?" and each used to keep its own word list. The frame's was
 * shorter, so three items were routed as repair asks and then handed nothing:
 * `proofread-teacher-note-esl` ("check this for mistakes"),
 * `proofread-marketplace-ad` ("clean up the spelling in it") and
 * `proofread-review-reply` ("check my spelling and grammer") — while their
 * siblings ended on "The corrected post:".
 *
 * The per-item expectations below are the visible half. This sweep is the
 * mechanism: any verb either side learns without the other closes the same gap
 * again, and the sweep is what notices.
 */
describe("every repair ask ends on a frame naming the artifact", () => {
  it("no corpus item is routed as a repair and then left unframed", () => {
    const unframed = CORPUS.filter(
      (item) => isTextRepairAsk(item.userInput) && buildArtifactFrame(item.userInput) === "",
    ).map((item) => item.id);
    expect(unframed).toEqual([]);
  });

  const PINNED_FRAMES: Readonly<Record<string, string>> = {
    "proofread-teacher-note-esl": "The corrected version:", // "check this for mistakes"
    "proofread-marketplace-ad": "The corrected ad:", // "clean up the spelling in it"
    "proofread-review-reply": "The corrected reply:", // "check my spelling and grammer"
    // Unchanged by the vocabulary merge — pinned so a widening cannot move them.
    "proofread-birthday-caption": "The corrected post:",
    "proofread-grandfather-letter": "The corrected letter:",
    "proofread-crew-email": "The corrected version:",
    "proofread-school-post": "The corrected version:",
    "proofread-vet-application": "The corrected version:",
    "sw-15": "The corrected version:",
  };

  for (const [id, expected] of Object.entries(PINNED_FRAMES)) {
    it(`frames ${id} as "${expected}"`, () => {
      const item = CORPUS.find((entry) => entry.id === id);
      if (!item) throw new Error(`no corpus item ${id}`);
      expect(buildArtifactFrame(item.userInput)).toBe(expected);
    });
  }

  /**
   * The other direction — an instrument that only fires is not an instrument.
   * A wider vocabulary that also framed turns nobody asked an artifact of
   * would be a regression wearing a fix's clothes; the gate's fail-safe
   * direction is silence. The only two non-repair items that carry a frame are
   * write-from-scratch asks that open "write a message to…" / "write me a
   * letter to…", which the correspondence scan has always caught.
   */
  it("frames no turn that is neither a repair ask nor a request to write one", () => {
    const framed = CORPUS.filter(
      (item) => !isTextRepairAsk(item.userInput) && buildArtifactFrame(item.userInput) !== "",
    ).map((item) => item.id);
    expect(framed).toEqual(["draft-01", "admin-gym-cancellation"]);
  });
});
