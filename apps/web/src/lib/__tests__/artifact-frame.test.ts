// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { EVERYDAY_CONVERSATION_CORPUS } from "../../__tests__/fixtures/everyday-conversation-corpus";
import {
  appendArtifactFrames,
  buildArtifactFrame,
  buildBranchArtifactFrames,
} from "../artifact-frame";
import { appendBranchRecaps, buildBranchRecaps } from "../detail-recap";
import { applyTurnHints } from "../chat-intent";

/**
 * ★ THE FIRE SET, pinned corpus-wide as an exact map — every user turn of every
 * conversation, not just the probed ones. A turn missing here that starts to
 * fire, or one here that stops, is a behaviour change that must be classified,
 * not a diff hunk to wave through. Silence ("") is the fail-safe direction and
 * the overwhelming default.
 */
const EXPECTED_FRAMES: Readonly<Record<string, readonly string[]>> = {
  "convo-air-fryer-doneness": ["", "", "", ""],
  "convo-milestone-gift-mailable": ["", "", "", ""],
  "convo-teacher-email-resend": [
    "",
    // "i need to email my sons teacher" — the verb names the artifact, its
    // object is the audience, the comma ends the phrase.
    "The email to send to my sons teacher:",
    "",
    "",
    // "ok back to the email — … can u resend it" — "the email" is a noun (the
    // marker guard), "resend it" resolves to it, resend says "again".
    "The email again:",
  ],
  "convo-grape-climbdown": ["", "", "", "", ""],
  "convo-monstera-contradiction": ["", "", "", "", ""],
  "convo-birthday-lunch-message": [
    "",
    "",
    "",
    // "can you write the message i send to the family group chat."
    "The message to send to the family group chat:",
    "",
    "",
  ],
  // "right can you write the whole thing out as a proper list" — a list is not
  // correspondence; no artifact noun in the verb's window, no fire.
  "convo-four-day-budget-list": ["", "", "", "", "", ""],
  // "go on then write it. proper letter" — the noun sits in the NEXT sentence,
  // outside the verb's window; "send all the paperwork" governs no artifact
  // noun; the pasted turns exceed statedText's paste threshold. All silent,
  // including the probed "before you write owt" turn.
  "convo-insurance-recall": ["", "", "", "", "", "", "", "", ""],
};

function branchOf(itemId: string) {
  const item = EVERYDAY_CONVERSATION_CORPUS.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`no corpus item ${itemId}`);
  return item.turns.map((turn) => ({ role: turn.role, content: turn.text }));
}

describe("buildBranchArtifactFrames — the corpus fire set", () => {
  it("covers every conversation in the corpus", () => {
    expect(Object.keys(EXPECTED_FRAMES).sort()).toEqual(
      EVERYDAY_CONVERSATION_CORPUS.map((item) => item.id).sort(),
    );
  });

  for (const item of EVERYDAY_CONVERSATION_CORPUS) {
    it(`fires exactly as pinned on ${item.id}`, () => {
      expect(buildBranchArtifactFrames(branchOf(item.id))).toEqual(EXPECTED_FRAMES[item.id]);
    });
  }
});

describe("buildArtifactFrame — the gate's own rules", () => {
  const birthdayAsk = branchOf("convo-birthday-lunch-message")[6]!.content;

  it("never fires on a first user turn, whatever the ask", () => {
    expect(buildArtifactFrame(birthdayAsk, false)).toBe("");
  });

  it("is deterministic — the KV precondition", () => {
    expect(buildArtifactFrame(birthdayAsk, true)).toBe(buildArtifactFrame(birthdayAsk, true));
  });

  it('does not read "the email" as the verb email', () => {
    expect(buildArtifactFrame("ok back to the email — can you summarise it", true)).toBe("");
  });

  it('does not frame plain "send it" — a turn can ask ABOUT sending', () => {
    expect(buildArtifactFrame("about that email — did you send it to dave", true)).toBe("");
  });

  it("does not let a distant 'to' invent an audience", () => {
    expect(
      buildArtifactFrame(
        "go on then write the letter, ive not done one of these before and i dont want to sound like an idiot",
        true,
      ),
    ).toBe("The letter:");
  });
});

/**
 * The request-shape gate. Every turn here has the verb-governs-noun shape the
 * fire set is built on, so the shape test alone would frame all of them; what
 * separates them is whether the person is ASKING FOR correspondence or asking
 * ABOUT some.
 */
describe("buildArtifactFrame — asking for a message vs asking about one", () => {
  it("does not frame a question about correspondence already sent", () => {
    expect(buildArtifactFrame("did you send the email to dave", true)).toBe("");
  });

  it("does not frame a question about when to send it", () => {
    expect(buildArtifactFrame("when should i send the email", true)).toBe("");
  });

  it("does not frame the user reporting that they sent it", () => {
    expect(buildArtifactFrame("i sent the email to dave yesterday", true)).toBe("");
  });

  it("frames a clause-initial imperative, lead-in words and all", () => {
    expect(buildArtifactFrame("go on then write the letter to the school", true)).toBe(
      "The letter to send to the school:",
    );
  });
});

describe("appendArtifactFrames / appendBranchRecaps — placement", () => {
  it("puts the frame after the detail recap, as the turn's final line", () => {
    const branch = branchOf("convo-birthday-lunch-message").slice(0, 7);
    const rendered = appendBranchRecaps(
      applyTurnHints(branch, true, "candidate/qwen3.5-2b-onnx"),
      buildBranchRecaps(branch),
    );
    const probe = rendered[6]!.content;
    const frame = "The message to send to the family group chat:";
    expect(probe.endsWith(`\n\n${frame}`)).toBe(true);
    const recapAt = probe.indexOf("Details I gave earlier in this chat:");
    expect(recapAt).toBeGreaterThan(-1);
    expect(recapAt).toBeLessThan(probe.indexOf(frame));
  });

  it("re-renders byte-identically — the KV strict-prefix contract", () => {
    const branch = branchOf("convo-teacher-email-resend");
    const once = appendBranchRecaps(applyTurnHints(branch, true), buildBranchRecaps(branch));
    const twice = appendBranchRecaps(applyTurnHints(branch, true), buildBranchRecaps(branch));
    expect(once).toEqual(twice);
  });

  it("leaves a branch with no firing turns byte-identical", () => {
    const branch = branchOf("convo-monstera-contradiction");
    const frames = buildBranchArtifactFrames(branch);
    expect(appendArtifactFrames(branch, frames)).toEqual(branch);
  });
});
