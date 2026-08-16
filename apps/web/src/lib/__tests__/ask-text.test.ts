// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { PASTED_TURN_MIN_CHARS, askPrefix, isTextRepairAsk, isTextTransformAsk } from "../ask-text";

const PASTE = "x".repeat(PASTED_TURN_MIN_CHARS + 50);

describe("askPrefix — the instruction, not the pasted subject", () => {
  it("returns a short turn whole", () => {
    expect(askPrefix("fix my typos")).toBe("fix my typos");
  });

  it("returns the instruction paragraph when a paste follows", () => {
    expect(askPrefix(`can you fix my spelling in this\n\n${PASTE}`)).toBe(
      "can you fix my spelling in this",
    );
  });

  it("strips file blocks before measuring length", () => {
    expect(askPrefix(`summarise this <file name="a.txt">${PASTE}</file>`)).toBe(
      "summarise this",
    );
  });

  it("is silent when a long turn has no paragraph break — no ask to find", () => {
    expect(askPrefix(PASTE)).toBe("");
  });

  it("is silent when the 'instruction' is itself longer than a paste", () => {
    expect(askPrefix(`${PASTE}\n\nand another thing`)).toBe("");
  });

  it("is deterministic — the KV precondition", () => {
    const turn = `proofread this please\n\n${PASTE}`;
    expect(askPrefix(turn)).toBe(askPrefix(turn));
  });
});

describe("isTextRepairAsk — the user wants text back, not commentary", () => {
  // ★ The production build once dropped the `)\b` closing the first alternative
  // (see the note in ask-text.ts). Node built the string correctly, so nothing
  // in this suite could see it — the bundle threw at module evaluation instead.
  // This cannot catch a build-time mangle, but it does catch a source-level one,
  // and it states the shape the regex is required to have.
  it("matches both alternatives independently — the group is closed", () => {
    // Self-qualifying arm alone, with no text-quality object anywhere.
    expect(isTextRepairAsk("please rephrase")).toBe(true);
    // Verb-plus-object arm alone, with no self-qualifying verb anywhere.
    expect(isTextRepairAsk("sort out the punctuation")).toBe(true);
    // A self-qualifying verb must not need an object to be in range.
    expect(isTextRepairAsk("spellcheck it")).toBe(true);
  });

  it("fires on a correction verb with a text object", () => {
    expect(isTextRepairAsk("can you fix the typos")).toBe(true);
    expect(isTextRepairAsk("could you correct my spelling")).toBe(true);
  });

  it("fires on a self-qualifying verb with no object", () => {
    expect(isTextRepairAsk("can someone proofread this")).toBe(true);
    expect(isTextRepairAsk("rewrite this for me")).toBe(true);
  });

  it("fires on 'check this for mistakes'", () => {
    expect(isTextRepairAsk("hi can you check this for mistakes please")).toBe(true);
  });

  it("does NOT fire when the repair is not about text", () => {
    expect(isTextRepairAsk("can you fix my wifi")).toBe(false);
    expect(isTextRepairAsk("fix the spacing in the code")).toBe(false);
  });

  it("does NOT fire on a question about text that asks nothing to be repaired", () => {
    expect(isTextRepairAsk("what does this letter mean")).toBe(false);
    expect(isTextRepairAsk("is this rude")).toBe(false);
  });

  it("reads only the ask, never the pasted subject", () => {
    // The paste mentions typos; the instruction does not ask for a repair.
    expect(isTextRepairAsk(`what does this mean\n\nplease fix the typos ${PASTE}`)).toBe(
      false,
    );
  });
});

describe("isTextTransformAsk — the user wants the text back changed, not explained", () => {
  it("matches both alternatives independently — the group is closed", () => {
    // Self-qualifying transform verb alone.
    expect(isTextTransformAsk("shorten this")).toBe(true);
    // "make <this|it> <degree>" alone, no transform verb anywhere.
    expect(isTextTransformAsk("make this more formal")).toBe(true);
  });

  it("fires on the self-qualifying transform verbs", () => {
    for (const ask of [
      "summarize this in one sentence",
      "can you summarise it",
      "condense this for me",
      "paraphrase this paragraph",
      "reword this so it flows",
      "simplify this explanation",
      "formalize this note",
    ]) {
      expect(isTextTransformAsk(ask), ask).toBe(true);
    }
  });

  it("fires on 'make this/it more|less|sound X'", () => {
    expect(isTextTransformAsk("make this more formal")).toBe(true);
    expect(isTextTransformAsk("can you make it less wordy")).toBe(true);
    expect(isTextTransformAsk("make this sound more professional")).toBe(true);
  });

  // TR-1 widening (2026-08-16, measured on the real 1.2B): the natural transform
  // phrasings PR #154 left uncovered. Before, these routed to `explain` and the
  // model lectured instead of delivering (0/6 Did-It on the probe).
  it("fires on the TR-1 verbs added after measurement", () => {
    for (const ask of [
      "tidy this up",
      "polish this",
      "soften this",
      "translate this to spanish",
      "bullet point this",
      "bullet-point this",
    ]) {
      expect(isTextTransformAsk(ask), ask).toBe(true);
    }
  });

  it("fires on a curated PROSE comparative after 'make this/it'", () => {
    expect(isTextTransformAsk("make this shorter")).toBe(true);
    expect(isTextTransformAsk("make this punchier")).toBe(true);
    expect(isTextTransformAsk("can you make it a bit shorter")).toBe(true);
    expect(isTextTransformAsk("make it tighter")).toBe(true);
  });

  it("does NOT fire on 'make <a noun>' — a creation ask, not a rewrite", () => {
    expect(isTextTransformAsk("make me a study guide for calc 1")).toBe(false);
    expect(isTextTransformAsk("turn this into a grocery list")).toBe(false);
  });

  it("does not read the adverb 'simply' as the verb 'simplify'", () => {
    expect(isTextTransformAsk("explain how a credit score works, simply")).toBe(false);
  });

  it("does NOT fire on the verb governing an external subject — no 'this'/'it'", () => {
    // Knowledge/explain asks that merely use the verb; nothing to transform.
    expect(isTextTransformAsk("summarize what a vpn does in one sentence")).toBe(false);
    expect(isTextTransformAsk("simplify the equation for me")).toBe(false);
    expect(isTextTransformAsk("can you summarize the french revolution")).toBe(false);
  });

  it("keeps explain-overlap and non-prose comparatives OUT (curated, not any -er)", () => {
    // "easier"/"clearer" are as often "explain X more clearly" as a rewrite;
    // "bigger"/"better" aren't prose-transform signals. All deliberately excluded.
    expect(isTextTransformAsk("make it easier for me to understand recursion")).toBe(false);
    expect(isTextTransformAsk("make it clearer")).toBe(false);
    expect(isTextTransformAsk("make it bigger")).toBe(false);
    expect(isTextTransformAsk("make it better")).toBe(false);
    // "clean" is unmeasured here and "clean this room" is a real non-text sense.
    expect(isTextTransformAsk("clean this up")).toBe(false);
  });

  it("reads only the ask, never the pasted subject", () => {
    // The paste asks to rephrase; the instruction does not.
    expect(isTextTransformAsk(`what do you think of this\n\nplease rephrase it all ${PASTE}`)).toBe(
      false,
    );
  });
});
