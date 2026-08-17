// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import {
  buildIntegrityRepairPrompt,
  derivePrivacyGuard,
  findLeaks,
  matchesTerm,
  redactPrivateSpans,
  type IntegrityTurn,
} from "../conversation-integrity-guard";
import { CONVERSATION_INTEGRITY_PROBES } from "../../local-ai/eval/conversation-integrity-probe";
import { analyzeRuledOut } from "../../local-ai/eval/rubric";

// All inputs here are FABRICATED for the test — never the eval-fixture secrets.
// The guard must work on the shape of the conversation, blind to any answer key.

describe("conversation-integrity-guard — arming", () => {
  const marker: IntegrityTurn = {
    role: "user",
    content: "just so you know, this is between us — nobody at work can find out",
  };
  const ack: IntegrityTurn = { role: "assistant", content: "Understood, I'll keep that in mind." };

  it("arms on a privacy marker in history + a draft-to-someone turn", () => {
    const guard = derivePrivacyGuard([marker, ack], "write a quick email to my manager");
    expect(guard.armed).toBe(true);
  });

  it("does NOT arm without a privacy marker (a normal writing turn is untouched)", () => {
    const guard = derivePrivacyGuard(
      [{ role: "user", content: "i want to invite my team to lunch" }, ack],
      "write a message to my team about lunch",
    );
    expect(guard.armed).toBe(false);
    expect(guard.forbiddenSpans).toEqual([]);
  });

  it("does NOT arm when the turn is not a draft request", () => {
    const guard = derivePrivacyGuard([marker, ack], "what should I say to them?");
    expect(guard.armed).toBe(false);
  });

  it("ignores a privacy marker sitting in an assistant turn only", () => {
    const guard = derivePrivacyGuard(
      [
        { role: "user", content: "i have some news about work" },
        { role: "assistant", content: "keep it confidential if you like — between us." },
      ],
      "write an email to my boss",
    );
    // No USER marker → not armed (the assistant echoing 'confidential' is not the user flagging it).
    expect(guard.armed).toBe(false);
  });
});

describe("conversation-integrity-guard — extraction", () => {
  it("extracts a mid-sentence proper noun and a large figure, forbidding them", () => {
    const guard = derivePrivacyGuard(
      [
        {
          role: "user",
          content:
            "keep this between us: i just accepted an offer from Zeplox for 145000 a year",
        },
      ],
      "write a short message to my current boss asking for friday off",
    );
    expect(guard.armed).toBe(true);
    expect(guard.forbiddenSpans.map((s) => s.toLowerCase())).toEqual(
      expect.arrayContaining(["zeplox", "145000"]),
    );
  });

  it("extracts a general sensitive-category term (blind to any specific secret)", () => {
    const guard = derivePrivacyGuard(
      [{ role: "user", content: "between us, i'm interviewing elsewhere and nobody knows" }],
      "write a message to my manager about my schedule",
    );
    expect(guard.forbiddenSpans.map((s) => s.toLowerCase())).toContain("interviewing");
  });

  it("captures a 'diagnosed with X' object", () => {
    const guard = derivePrivacyGuard(
      [{ role: "user", content: "i havent told work but i was diagnosed with narcolepsy" }],
      "write an email to my boss about working from home",
    );
    const lowered = guard.forbiddenSpans.map((s) => s.toLowerCase());
    expect(lowered).toContain("narcolepsy");
    expect(lowered).toContain("diagnosed");
  });

  it("never forbids a token the user put in the drafting request (the recipient)", () => {
    // 'Priyanka' is both the private-context friend and the intended recipient.
    const guard = derivePrivacyGuard(
      [{ role: "user", content: "between us, my friend Priyanka told me a secret" }],
      "write a friendly message to Priyanka inviting her to dinner",
    );
    expect(guard.forbiddenSpans.map((s) => s.toLowerCase())).not.toContain("priyanka");
  });

  it("excludes sentence-initial capitals and calendar words", () => {
    const guard = derivePrivacyGuard(
      [{ role: "user", content: "between us. Tuesday i got a promotion nobody knows about" }],
      "write a note to my teammate",
    );
    const lowered = guard.forbiddenSpans.map((s) => s.toLowerCase());
    expect(lowered).not.toContain("tuesday");
    expect(lowered).toContain("promotion");
  });
});

describe("conversation-integrity-guard — single-turn shape (the canonical repro)", () => {
  // One turn carries the private detail, the marker AND the draft ask (fabricated).
  const singleTurn =
    "i need to email the events team to cancel my slot. the real reason is my husband " +
    "arlo is having surgery at the hospital that day, but i dont want to tell them, its " +
    "private. can you write the email";

  it("arms and forbids the co-located sensitive terms", () => {
    const guard = derivePrivacyGuard([{ role: "user", content: singleTurn }], singleTurn);
    expect(guard.armed).toBe(true);
    const lowered = guard.forbiddenSpans.map((s) => s.toLowerCase());
    expect(lowered).toEqual(expect.arrayContaining(["surgery", "hospital"]));
  });

  it("sentence-level redaction removes the lowercase name it never extracted", () => {
    const guard = derivePrivacyGuard([{ role: "user", content: singleTurn }], singleTurn);
    const draft = [
      "Hi team,",
      "",
      "I need to cancel my slot. My husband Arlo is having surgery at the hospital that day.",
      "",
      "Thanks for understanding.",
    ].join("\n");
    const out = redactPrivateSpans(draft, guard.forbiddenSpans);
    // The whole leaking sentence is gone — so 'Arlo', which the extractor could not
    // pin (lowercase), leaves with it.
    expect(out).not.toMatch(/arlo/i);
    expect(out).not.toMatch(/surgery/i);
    expect(out).not.toMatch(/hospital/i);
    expect(out).toContain("Hi team");
    expect(out).toContain("Thanks for understanding");
    expect(out).toContain("I need to cancel my slot.");
  });
});

describe("conversation-integrity-guard — single-turn proper-noun leads", () => {
  // Closes a subset of the single-turn seam: a PROPER-NOUN secret that is the object
  // of an announcement/secrecy lead, with no co-located sensitive-category word.
  it("forbids a proper noun that is the object of a secrecy lead", () => {
    const oneTurn =
      "i want to email my current tutor a quick note. between us i got into Cambridge " +
      "and havent told anyone yet, keep it quiet. write it";
    const guard = derivePrivacyGuard([{ role: "user", content: oneTurn }], oneTurn);
    expect(guard.armed).toBe(true);
    expect(guard.forbiddenSpans.map((s) => s.toLowerCase())).toContain("cambridge");
  });

  it("forbids a 'moving to X' destination flagged private", () => {
    const oneTurn =
      "draft a message to my client. between us i'm moving to Lisbon next month but " +
      "it's private for now";
    const guard = derivePrivacyGuard([{ role: "user", content: oneTurn }], oneTurn);
    expect(guard.forbiddenSpans.map((s) => s.toLowerCase())).toContain("lisbon");
  });

  it("pins the lead's object but NEVER the recipient in the same turn", () => {
    const oneTurn =
      "the real reason is Brightwave and i'd rather nobody knows — email my manager " +
      "Dana to ask for the day off";
    const guard = derivePrivacyGuard([{ role: "user", content: oneTurn }], oneTurn);
    const lowered = guard.forbiddenSpans.map((s) => s.toLowerCase());
    expect(lowered).toContain("brightwave");
    // The recipient is not the object of a secrecy lead — it must stay usable.
    expect(lowered).not.toContain("dana");
  });

  it("redacts the leaked proper noun end-to-end", () => {
    const oneTurn =
      "write my landlord a short note. between us i'm moving to Zephyria next month " +
      "but keep it confidential for now";
    const guard = derivePrivacyGuard([{ role: "user", content: oneTurn }], oneTurn);
    const draft = [
      "Hi,",
      "",
      "I'm writing to give notice. I'm moving to Zephyria at the end of the month.",
      "",
      "Thanks!",
    ].join("\n");
    const out = redactPrivateSpans(draft, guard.forbiddenSpans);
    expect(out).not.toMatch(/zephyria/i);
    expect(out).toContain("Hi,");
    expect(out).toContain("Thanks!");
  });

  it("does NOT capture a recipient company named via an employment/offer lead", () => {
    // The message is addressed TO Brightwave; 'position at Brightwave' / 'offer from
    // Brightwave' must NOT forbid it, or redaction would delete the greeting. The
    // employment/offer leads are deliberately omitted for exactly this reason.
    const oneTurn =
      "email the team at Brightwave to accept the position at Brightwave — keep it " +
      "confidential for now, my current boss doesnt know";
    const guard = derivePrivacyGuard([{ role: "user", content: oneTurn }], oneTurn);
    expect(guard.forbiddenSpans.map((s) => s.toLowerCase())).not.toContain("brightwave");
  });
});

describe("conversation-integrity-guard — matchesTerm (mirrors the leak scorer)", () => {
  it("is whole-token and plural-tolerant, not a prefix match", () => {
    expect(matchesTerm("we booked Reykjavik", "Reykjavik")).toBe(true);
    expect(matchesTerm("two Rolexes", "Rolex")).toBe(true);
    expect(matchesTerm("a spare room in Spain", "spa")).toBe(false);
  });
});

describe("conversation-integrity-guard — redaction guarantee", () => {
  it("drops the whole leaking sentence, keeping clean prose", () => {
    const draft = [
      "Hi Dana,",
      "",
      "Could I take Friday off? The real reason is I'm interviewing at Zeplox.",
      "",
      "Thanks!",
    ].join("\n");
    const out = redactPrivateSpans(draft, ["Zeplox", "interviewing"]);
    expect(findLeaks(out, ["Zeplox", "interviewing"])).toEqual([]);
    expect(out).toContain("Hi Dana");
    expect(out).toContain("Thanks!");
    expect(out).toContain("Could I take Friday off?");
  });

  it("is a hard guarantee even for a span mid-sentence with no boundary", () => {
    const out = redactPrivateSpans("the price was 4200 dollars all in", ["4200"]);
    expect(findLeaks(out, ["4200"])).toEqual([]);
  });

  it("never returns empty — falls back to a word-stripped draft", () => {
    const out = redactPrivateSpans("Reykjavik", ["Reykjavik"]);
    expect(findLeaks(out, ["Reykjavik"])).toEqual([]);
  });

  it("no-ops when there is nothing to redact", () => {
    const draft = "Happy birthday! Hope you have a wonderful day.";
    expect(redactPrivateSpans(draft, ["Zeplox"])).toBe(draft);
  });
});

describe("conversation-integrity-guard — hardened regeneration frame", () => {
  it("names the exact spans to withhold and offers the neutral fallback", () => {
    const { systemInstruction, userPrompt } = buildIntegrityRepairPrompt(
      "write a message to my boss",
      ["Zeplox", "interviewing"],
    );
    expect(systemInstruction).toContain("Zeplox");
    expect(systemInstruction).toContain("a personal matter");
    expect(userPrompt).toContain("Zeplox, interviewing");
  });
});

// ── THE PROOF: the general guard, run against the real #27 fixture, blind ──────
//
// For every probe: the guard must ARM, and a worst-case draft that leaks EVERY
// planted span must come back clean by the SAME scorer the leak-rate metric reads
// (analyzeRuledOut). This proves the deterministic guarantee drives leak-rate to 0
// on the real defect — without a model, and without hardcoding a single secret.
describe("conversation-integrity-guard — PROOF against the #27 leak fixture", () => {
  it("arms on every conversation-integrity probe", () => {
    for (const probe of CONVERSATION_INTEGRITY_PROBES) {
      const guard = derivePrivacyGuard(probe.history ?? [], probe.prompt);
      expect(guard.armed, `${probe.id} should arm`).toBe(true);
    }
  });

  it("its general extraction covers every planted private span", () => {
    for (const probe of CONVERSATION_INTEGRITY_PROBES) {
      const guard = derivePrivacyGuard(probe.history ?? [], probe.prompt);
      const spans = probe.historyRuledOut ?? [];
      for (const secret of spans) {
        const caught = guard.forbiddenSpans.some((f) => matchesTerm(secret, f));
        expect(caught, `${probe.id}: extractor must cover "${secret}"`).toBe(true);
      }
    }
  });

  it("redacts a worst-case leaking draft to a clean reply (leak-rate → 0)", () => {
    for (const probe of CONVERSATION_INTEGRITY_PROBES) {
      const guard = derivePrivacyGuard(probe.history ?? [], probe.prompt);
      const spans = probe.historyRuledOut ?? [];
      // A worst-case draft: the model leaked every planted span, one per sentence,
      // amid legitimate message prose.
      const leakingDraft = [
        "Hi there,",
        "",
        ...spans.map((s) => `Just so you know, ${s} is part of this.`),
        "",
        "Looking forward to it. Best wishes.",
      ].join("\n");

      // Pre-condition: the raw draft really does leak (scored by the metric).
      expect(analyzeRuledOut(spans, leakingDraft).resurfaced).toEqual([...spans]);

      const guarded = redactPrivateSpans(leakingDraft, guard.forbiddenSpans);

      // The guarantee: no planted span survives, per the exact leak scorer.
      expect(
        analyzeRuledOut(spans, guarded).resurfaced,
        `${probe.id} must be clean after the guard`,
      ).toEqual([]);
      // And the message keeps its legitimate opening/closing.
      expect(guarded).toContain("Hi there");
      expect(guarded).toContain("Best wishes");
    }
  });
});
