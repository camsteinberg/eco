// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { EVERYDAY_CONVERSATION_CORPUS } from "../../__tests__/fixtures/everyday-conversation-corpus";
import {
  appendArtifactFrames,
  buildArtifactFrame,
  buildBranchArtifactFrames,
} from "../artifact-frame";
import { isTextRepairAsk } from "../ask-text";
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

  it("fires on a first user turn when the ask matches", () => {
    expect(buildArtifactFrame(birthdayAsk)).toBe(
      "The message to send to the family group chat:",
    );
  });

  it("is deterministic — the KV precondition", () => {
    expect(buildArtifactFrame(birthdayAsk)).toBe(buildArtifactFrame(birthdayAsk));
  });

  it('does not read "the email" as the verb email', () => {
    expect(buildArtifactFrame("ok back to the email — can you summarise it")).toBe("");
  });

  it('does not frame plain "send it" — a turn can ask ABOUT sending', () => {
    expect(buildArtifactFrame("about that email — did you send it to dave")).toBe("");
  });

  it("does not let a distant 'to' invent an audience", () => {
    expect(
      buildArtifactFrame(
        "go on then write the letter, ive not done one of these before and i dont want to sound like an idiot",
      ),
    ).toBe("The letter:");
  });

  it('does not read a channel-naming fragment as an object — "Email, because…"', () => {
    expect(
      buildArtifactFrame(
        "can you write it for me then. Email, since ive got her address from before",
      ),
    ).toBe("");
  });

  it("frames the reply — correspondence has a second half", () => {
    expect(buildArtifactFrame("ok can you write the slack reply. keep it short")).toBe(
      "The reply:",
    );
  });

  it("names the reply's audience when the ask gives one", () => {
    expect(buildArtifactFrame("can u draft a reply to jess")).toBe(
      "The reply to send to jess:",
    );
  });

  it("stays silent on a verbless ask — a stated limit, not a target", () => {
    expect(buildArtifactFrame("i need the words. its only a small card so nothing gushing")).toBe(
      "",
    );
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
    expect(buildArtifactFrame("did you send the email to dave")).toBe("");
  });

  it("does not frame a question about when to send it", () => {
    expect(buildArtifactFrame("when should i send the email")).toBe("");
  });

  it("does not frame the user reporting that they sent it", () => {
    expect(buildArtifactFrame("i sent the email to dave yesterday")).toBe("");
  });

  it("frames a clause-initial imperative, lead-in words and all", () => {
    expect(buildArtifactFrame("go on then write the letter to the school")).toBe(
      "The letter to send to the school:",
    );
  });
});

describe("buildArtifactFrame — correction verbs", () => {
  it("frames 'fix the typos' as a correction", () => {
    expect(buildArtifactFrame("fix the typos and grammar")).toBe("The corrected version:");
  });

  it("frames 'proofread this' without needing a correction object", () => {
    expect(buildArtifactFrame("can someone proofread this")).toBe("The corrected version:");
  });

  it("uses a named artifact noun from the ask when available", () => {
    expect(buildArtifactFrame("fix the grammar in this essay")).toBe("The corrected essay:");
  });

  it("stays silent when the correction verb has no text-correction object", () => {
    expect(buildArtifactFrame("can you fix my wifi")).toBe("");
  });

  it("stays silent on non-text correction — 'fix the spacing in this css'", () => {
    expect(buildArtifactFrame("fix the spacing in the code")).toBe("");
  });

  it("frames a proofread ask on a paste-heavy turn via askPrefix", () => {
    const longTurn =
      "can you fix the typos, im dyslexic and i miss stuff\n\n" +
      "A".repeat(800);
    expect(buildArtifactFrame(longTurn)).toBe("The corrected version:");
  });

  it("stays silent on a long turn with no clear instruction break", () => {
    expect(buildArtifactFrame("A".repeat(700))).toBe("");
  });

  it("finds the artifact noun even when it is not near the correction verb", () => {
    expect(
      buildArtifactFrame("posting this ad on marketplace. can you fix the spelling in it"),
    ).toBe("The corrected ad:");
  });

  it("'rewrite' is self-qualifying and finds the artifact noun", () => {
    expect(buildArtifactFrame("can you rewrite the email to dave")).toBe(
      "The corrected email:",
    );
  });
});

/**
 * ★ THE VOCABULARY IS `ask-text`'s, NOT THIS MODULE'S.
 *
 * Every verb the classifier reads as a repair ask has to reach the frame, or a
 * turn is routed as "give this person their text back" and then ends on the
 * recap block's list shape instead of on the artifact. That is what happened
 * to "check this for mistakes" — routed `writing`, framed nothing.
 */
describe("buildArtifactFrame — the repair vocabulary shared with the classifier", () => {
  const REPAIR_ASKS: Readonly<Record<string, string>> = {
    // The verbs the frame could not see before the vocabularies were merged.
    "hi can you check this for mistakes please": "The corrected version:",
    "can you just clean up the spelling in it": "The corrected version:",
    "can you check my spelling and grammer": "The corrected version:",
    "could you edit the wording on this": "The corrected version:",
    "can you tidy up the punctuation": "The corrected version:",
    "please sort out the typos": "The corrected version:",
    // Self-qualifying, no object needed.
    "can you spellcheck this": "The corrected version:",
    "could you reword this": "The corrected version:",
    "please rephrase it": "The corrected version:",
  };

  for (const [ask, expected] of Object.entries(REPAIR_ASKS)) {
    it(`frames "${ask}"`, () => {
      expect(buildArtifactFrame(ask)).toBe(expected);
      expect(isTextRepairAsk(ask)).toBe(true);
    });
  }

  it("matches a two-word verb closed up, spaced or hyphenated", () => {
    for (const ask of [
      "can you cleanup the spelling",
      "can you clean up the spelling",
      "can you clean-up the spelling",
    ]) {
      expect(buildArtifactFrame(ask)).toBe("The corrected version:");
    }
  });

  it("starts the object window after the whole verb, not after its first word", () => {
    // "up the spelling" is three words past "clean"; past "up" it is two. A
    // window measured from the first word runs out on longer object phrases.
    expect(buildArtifactFrame("can you clean up all of the spelling")).toBe(
      "The corrected version:",
    );
  });

  it("still needs an object — a bare repair verb frames nothing", () => {
    expect(buildArtifactFrame("can you check this")).toBe("");
    expect(buildArtifactFrame("can you clean up the garage")).toBe("");
    expect(buildArtifactFrame("can you sort out my broadband")).toBe("");
  });

  it("still needs a request shape — a question about text is not an ask for it", () => {
    expect(buildArtifactFrame("did you check the spelling on that")).toBe("");
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
