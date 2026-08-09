// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { EVERYDAY_USE_CORPUS } from "../../__tests__/fixtures/everyday-use-corpus";
import { pastedBlock } from "../ask-text";
import {
  applySentenceRepair,
  buildSentenceRepairPass,
  reassemble,
  segmentForRepair,
} from "../sentence-repair";

type CorpusItem = { readonly id: string; readonly userInput: string };
const CORPUS = EVERYDAY_USE_CORPUS as readonly CorpusItem[];

function itemNamed(id: string): CorpusItem {
  const item = CORPUS.find((entry) => entry.id === id);
  if (!item) throw new Error(`no corpus item ${id}`);
  return item;
}

/**
 * ★ THE PROPERTY THE WHOLE MECHANISM RESTS ON.
 *
 * A sentence the model does not name must come back as the person typed it —
 * not approximately, exactly, down to the blank lines she put between her
 * paragraphs. If reassembly is lossy then the app is quietly rewriting text
 * nobody asked it to touch, which is the defect this module exists to make
 * impossible.
 */
describe("segmentation reassembles the person's text exactly", () => {
  for (const item of CORPUS) {
    const paste = pastedBlock(item.userInput);
    if (paste.length === 0) continue;
    it(`round-trips the pasted block of ${item.id}`, () => {
      expect(reassemble(segmentForRepair(paste), new Map())).toBe(paste);
    });
  }

  it("round-trips text whose shape is nothing but whitespace decisions", () => {
    const awkward = "Line one\n\n\nLine two.  Line three!!  \n\tTabbed\n\nEnd";
    expect(reassemble(segmentForRepair(awkward), new Map())).toBe(awkward);
  });

  it("keeps a blank line between paragraphs when a sentence IS replaced", () => {
    const source = "First one is wrong.\n\nSecond one is fine.";
    const units = segmentForRepair(source);
    expect(reassemble(units, new Map([[0, "First one is right."]]))).toBe(
      "First one is right.\n\nSecond one is fine.",
    );
  });
});

describe("segmentForRepair — where a unit ends", () => {
  it("splits on sentence-ending punctuation followed by a space", () => {
    expect(segmentForRepair("One. Two. Three.").map((u) => u.body)).toEqual([
      "One.",
      "Two.",
      "Three.",
    ]);
  });

  it("splits on a line break, so her paragraphs stay her paragraphs", () => {
    expect(segmentForRepair("Dear Ms Halbrook\n\nI am the mother").map((u) => u.body)).toEqual([
      "Dear Ms Halbrook",
      "I am the mother",
    ]);
  });

  it("does not split a title — 'Dear Ms. Halbrook' is one unit", () => {
    expect(segmentForRepair("Dear Ms. Halbrook, I write.").map((u) => u.body)).toEqual([
      "Dear Ms. Halbrook, I write.",
    ]);
  });

  it("does not split an initial — 'J. Smith' is one unit", () => {
    expect(segmentForRepair("Regards, J. Smith and co.").map((u) => u.body)).toEqual([
      "Regards, J. Smith and co.",
    ]);
  });

  it("splits after lowercase texting shorthand — 'u.' is not an initial", () => {
    // Found by reading the numbered listing the model would actually get: the
    // birthday caption's last two sentences arrived as one unit, so fixing one
    // typo would have regenerated both.
    expect(segmentForRepair("i hope this year is good to u. love u alot idc.").map((u) => u.body))
      .toEqual(["i hope this year is good to u.", "love u alot idc."]);
  });

  it("does not split a full stop with no space after it — that is the typo, not a boundary", () => {
    expect(segmentForRepair("i went home.then i slept. ok").map((u) => u.body)).toEqual([
      "i went home.then i slept.",
      "ok",
    ]);
  });

  it("keeps a closing quote with the sentence it closes", () => {
    expect(segmentForRepair('He said "stop!" Then he left.').map((u) => u.body)).toEqual([
      'He said "stop!"',
      "Then he left.",
    ]);
  });
});

describe("buildSentenceRepairPass — which turns are candidates", () => {
  it("builds a pass for the ESL note to the teacher", () => {
    const pass = buildSentenceRepairPass(itemNamed("proofread-teacher-note-esl").userInput);
    expect(pass).not.toBeNull();
    expect(pass!.units.length).toBeGreaterThan(5);
    // Her own constraint leads the prompt — it is hers to state, not ours.
    expect(pass!.userPrompt).toContain("dont change the way i say things");
    expect(pass!.userPrompt).toContain("1. Dear Ms. Halbrook,");
  });

  it("builds a pass for every repair ask in the corpus with a paste worth numbering", () => {
    const built = CORPUS.filter(
      (item) => buildSentenceRepairPass(item.userInput) !== null,
    ).map((item) => item.id);
    expect(built).toEqual([
      "sw-15",
      "proofread-teacher-note-esl",
      "proofread-birthday-caption",
      "proofread-grandfather-letter",
      "proofread-vet-application",
      "proofread-crew-email",
      "proofread-marketplace-ad",
      "proofread-review-reply",
      "proofread-school-post",
    ]);
  });

  /**
   * `proofread-memorial-tribute` is absent on purpose. "knock the spelling
   * errors out of it" is a repair ask that `isTextRepairAsk` deliberately does
   * not catch — it belongs to the "make this <different>" family, pinned as a
   * known miss in `paste-ask-routing.test.ts` so nobody widens the rule to fit
   * the labelled items. It is the reminder that this path covers the asks the
   * classifier can see, and no more.
   */
  it("does not reach an ask the classifier deliberately does not catch", () => {
    expect(buildSentenceRepairPass(itemNamed("proofread-memorial-tribute").userInput)).toBeNull();
  });

  it("is silent on a turn that is not a repair ask", () => {
    const item = itemNamed("health-hospital-letter");
    expect(buildSentenceRepairPass(item.userInput)).toBeNull();
  });

  it("is silent when there is no pasted block to repair", () => {
    expect(buildSentenceRepairPass("can you fix my spelling")).toBeNull();
  });

  it("never bans n-gram reuse — the one job that must reuse the user's spans", () => {
    const pass = buildSentenceRepairPass(itemNamed("proofread-crew-email").userInput);
    expect(pass).not.toBeNull();
    expect(pass!.generationOptions).not.toHaveProperty("no_repeat_ngram_size");
    expect(pass!.generationOptions.temperature).toBeLessThan(0.48);
  });
});

describe("applySentenceRepair — the app changes the text, not the model", () => {
  const SOURCE =
    "Dear Ms. Halbrook,\n\n"
    + "I am the mother of Mateo of your class of 4 grade. "
    + "I want to say sorry because he not finish the reading log since two weeks.\n\n"
    + "He is not a lazy boy. He like very much your class, specially the part of the "
    + "volcanos, he explain to me all the thing about the lava in the dinner.\n\n"
    + "With respect,\nYaneth";
  const TURN = `hi can you check this for mistakes please, dont change the way i say things\n\n${SOURCE}`;

  function passFor(): NonNullable<ReturnType<typeof buildSentenceRepairPass>> {
    const pass = buildSentenceRepairPass(TURN);
    if (!pass) throw new Error("expected a pass");
    return pass;
  }

  it("replaces only the sentences the model named", () => {
    const pass = passFor();
    const outcome = applySentenceRepair(
      pass,
      "3: I want to say sorry because he has not finished the reading log for two weeks.",
    );
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.replaced).toBe(1);
    expect(outcome.text).toContain("he has not finished the reading log for two weeks");
    // Everything she wrote that the model did not name is untouched, including
    // the closing she meant to write.
    expect(outcome.text).toContain("Dear Ms. Halbrook,");
    expect(outcome.text).toContain("He is not a lazy boy.");
    expect(outcome.text).toContain("With respect,\nYaneth");
  });

  it("a total voice replacement is not expressible — unnamed lines cannot change", () => {
    const pass = passFor();
    const outcome = applySentenceRepair(pass, "2: I am Mateo's mother, in your 4th grade class.");
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.text).toContain("With respect,\nYaneth");
    expect(outcome.text).not.toContain("I hope this message finds you well");
    expect(outcome.replaced).toBeLessThan(outcome.total);
  });

  it("ignores a preface, a closing note and a code fence around the corrections", () => {
    const pass = passFor();
    const outcome = applySentenceRepair(
      pass,
      "Here are the corrections:\n```\n3. He has not finished it.\n```\n"
      + "Key changes made: I corrected the verb tense.",
    );
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.replaced).toBe(1);
    expect(outcome.text).not.toContain("Key changes made");
  });

  it("accepts the numbering shapes a model actually writes", () => {
    const pass = passFor();
    // `<3>:` is the shape the 2B model used on every line of a live run — the
    // parser dropped all of them and the path looked like it could not work.
    for (const line of ["3: fixed", "3. fixed", "3) fixed", "- 3: fixed", "<3>: fixed", "[3]: fixed"]) {
      const outcome = applySentenceRepair(pass, line);
      expect(outcome.status, line).toBe("applied");
    }
  });

  it("strips the change-note the model appends, so it never lands in her text", () => {
    const pass = passFor();
    const outcome = applySentenceRepair(
      pass,
      '<3>: I want to say sorry because he has not finished it. (Corrected "not finish" to "has not finished")',
    );
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.text).toContain("he has not finished it.");
    expect(outcome.text).not.toContain("Corrected");
  });

  it("keeps a trailing parenthesis that is the person's own words", () => {
    // The birthday caption ends a line "(ur not slick)". A rule that stripped
    // any trailing bracket would delete her joke.
    const pass = passFor();
    const outcome = applySentenceRepair(pass, "3: he has not finished it (ur not slick)");
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.text).toContain("(ur not slick)");
  });

  it("drops a number outside the range without losing the rest", () => {
    const pass = passFor();
    const outcome = applySentenceRepair(pass, "99: nonsense\n3: He has not finished it.");
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.replaced).toBe(1);
  });

  it("falls back when the model rewrote the whole thing instead of naming lines", () => {
    const outcome = applySentenceRepair(
      passFor(),
      "Dear Ms. Halbrook, I hope this message finds you well. I am writing regarding "
      + "my son Mateo's incomplete reading log.",
    );
    expect(outcome).toEqual({ status: "fallback", reason: "no-numbered-lines" });
  });

  it("falls back when every number it gave is out of range", () => {
    const outcome = applySentenceRepair(passFor(), "88: something\n99: something else");
    expect(outcome).toEqual({ status: "fallback", reason: "no-usable-numbers" });
  });

  it("keeps the first answer when the model repeats a number", () => {
    const pass = passFor();
    const outcome = applySentenceRepair(pass, "3: first answer\n3: second answer");
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    expect(outcome.text).toContain("first answer");
    expect(outcome.text).not.toContain("second answer");
  });
});
