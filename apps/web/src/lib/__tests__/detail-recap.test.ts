// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { hasExplicitFormatInstruction } from "../answer-shape";
import { applyTurnHints, inferTurnIntent, type ChatTurnMessage } from "../chat-intent";
import { selectMessagesForContext } from "../context-window";
import {
  appendBranchRecaps,
  applyDetailRecaps,
  buildBranchDetailRecaps,
  buildBranchRecaps,
  buildDetailRecap,
  extractStatedDetails,
} from "../detail-recap";
import {
  appendFigureRecaps,
  buildBranchFigureRecaps,
  buildFigureRecap,
} from "../figure-recap";
import type { ChatMessage } from "../../stores/chatStore";
import {
  CONVERSATION_ROUTING_NEEDS,
  EVERYDAY_CONVERSATION_CORPUS,
} from "../../__tests__/fixtures/everyday-conversation-corpus";

function conversation(id: string): ChatTurnMessage[] {
  const item = EVERYDAY_CONVERSATION_CORPUS.find((entry) => entry.id === id);
  if (!item) throw new Error(`${id} missing from corpus`);
  return item.turns.map((turn) => ({ role: turn.role, content: turn.text }));
}

function birthdayTurns(): ChatTurnMessage[] {
  return conversation("convo-birthday-lunch-message");
}

/** The recap block carried by the user turn at `index`, or "" when it has none. */
function recapAt(messages: readonly ChatTurnMessage[], index: number): string {
  const original = messages[index]!.content;
  const applied = applyDetailRecaps(messages)[index]!.content;
  return applied === original ? "" : applied.slice(original.length).trim();
}

/** The user turns of a conversation that come before its probed turn. */
function priorUserTurns(id: string): string[] {
  const item = EVERYDAY_CONVERSATION_CORPUS.find((entry) => entry.id === id)!;
  const probed = CONVERSATION_ROUTING_NEEDS[id]?.probedTurnIndex ?? item.turns.length - 1;
  return item.turns
    .slice(0, probed)
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text);
}

describe("extractStatedDetails — dates", () => {
  it("reads a date the user wrote as more than one calendar token", () => {
    expect(extractStatedDetails("sunday 8th march then, 1pm").map((d) => d.value)).toContain(
      "sunday 8th march",
    );
  });

  it("ignores a lone calendar token, which is prose far more often than a date", () => {
    // Every one of these appears in the corpus, and none of them states a date.
    expect(extractStatedDetails("sunday lunch is actually a really good shout")).toEqual([]);
    expect(extractStatedDetails("its my mums 60th in march and im organising it")).toEqual([]);
    expect(extractStatedDetails("her birthdays the 7th")).toEqual([]);
    expect(extractStatedDetails("but thats a saturday")).toEqual([]);
  });

  it("bounds a day of the month to a real one", () => {
    // "my mums 60th" is an age. Left unbounded it becomes the 60th of a month.
    expect(extractStatedDetails("mums 60th in march")).toEqual([]);
    expect(extractStatedDetails("the 8th of march")).toHaveLength(1);
  });

  it("reads a bare number as a day only when a month sits beside it", () => {
    expect(extractStatedDetails("booked for 8 march").map((d) => d.value)).toEqual(["8 march"]);
    // ★ The reason "in" and "on" are not span joiners: they let an unrelated
    // number reach a month across them, and the budget conversation is full of
    // exactly this shape.
    expect(extractStatedDetails("water 31 and rents going up in october")).toEqual([]);
  });

  it("does not read a reference code or a revision stamp as a date", () => {
    expect(extractStatedDetails("Attendance Policy 4.2 | Revised 8/2024")).toEqual([]);
    expect(extractStatedDetails("policy SVT/TRV/09-25 covers it")).toEqual([]);
  });

  it("leaves out the month words that are also ordinary words", () => {
    // "may" is a modal verb and "mar" is a verb; either would let prose form a
    // date span. The cost is silence on a May date, never a wrong one.
    expect(extractStatedDetails("you may 8 of them")).toEqual([]);
  });
});

describe("extractStatedDetails — times", () => {
  it("reads a clock time in the shapes people type", () => {
    for (const [text, expected] of [
      ["sunday 8th march then, 1pm", "1pm"],
      ["get there for 6:15am", "6:15am"],
      ["table at 13:30", "13:30"],
      ["lunch at noon", "noon"],
    ] as const) {
      const times = extractStatedDetails(text).filter((d) => d.slot === "time");
      expect(times.map((d) => d.value)).toEqual([expected]);
    }
  });

  it("never reads a bare number as a time", () => {
    // "hes no good saturdays til after 7 at the earliest" — an hour only to a
    // human reader, and reading it would put a wrong time in the recap.
    expect(extractStatedDetails("hes no good saturdays til after 7 at the earliest")).toEqual([]);
  });
});

describe("extractStatedDetails — places", () => {
  it("reads the thing and the address the user gave for it", () => {
    const places = extractStatedDetails(
      "theres an italian on bridgford road weve been to before",
    ).filter((d) => d.slot === "place");
    expect(places.map((d) => d.value)).toEqual(["italian on bridgford road"]);
  });

  it("★ never emits a venue the user ruled out", () => {
    // The hazard this conversation actually contains. "il pescatore" has no
    // street or venue word after it, so it is not a candidate at all — and the
    // negation guard catches the version that does.
    const recap = buildDetailRecap([
      "theres an italian on bridgford road weve been to before, not il pescatore thats the fish one, the other one",
    ]);
    expect(recap).toContain("bridgford road");
    expect(recap.toLowerCase()).not.toContain("pescatore");

    const negated = extractStatedDetails("not the one on victoria street, the other one");
    expect(negated).toEqual([]);
  });

  it("needs a name, not just a street word", () => {
    expect(extractStatedDetails("its down the road a bit")).toEqual([]);
  });

  it("does not read an ordinary verb as a place word", () => {
    // "drive" and "way" are left out of the vocabulary for exactly this.
    expect(extractStatedDetails("we're driving to my sisters")).toEqual([]);
    expect(extractStatedDetails("its a long way to go")).toEqual([]);
  });
});

describe("extractStatedDetails — cost per person", () => {
  it("reads an amount whose label comes after it", () => {
    // ★ The shape `figure-recap.ts` cannot see: it keys on the noun BEFORE a
    // number, and this one puts "a head" after.
    expect(
      extractStatedDetails("nobody can do more than about 25 quid a head").map((d) => d.value),
    ).toEqual(["25 quid a head"]);
    expect(buildFigureRecap(["nobody can do more than about 25 quid a head"])).toBe("");
  });

  it("reads the other ways people write it", () => {
    for (const [text, expected] of [
      ["its £30 each", "£30 each"],
      ["works out 20 pp", "20 pp"],
      ["£12.50 per person", "£12.50 per person"],
    ] as const) {
      expect(extractStatedDetails(text).map((d) => d.value)).toEqual([expected]);
    }
  });

  it("does not read a ceiling as a negation", () => {
    // "more than" bounds the amount; it does not rule it out. A negation guard
    // that fired here would delete the figure the conversation settled on.
    expect(extractStatedDetails("no more than 25 quid a head")).toHaveLength(1);
  });
});

describe("extractStatedDetails — pasted documents are not stated details", () => {
  it("reads nothing from a turn long enough to be carrying a document", () => {
    const pasted = `right found it\n\n${"Departing: 07 October 2026, Newcastle 06:15. ".repeat(20)}`;
    expect(pasted.length).toBeGreaterThan(600);
    expect(extractStatedDetails(pasted)).toEqual([]);
  });

  it("reads nothing out of an attachment block", () => {
    expect(extractStatedDetails(`<file name="booking.txt">sunday 8th march, 1pm</file>`)).toEqual(
      [],
    );
  });
});

describe("buildDetailRecap — last-stated-wins", () => {
  it("★ keeps only the latest value for a slot", () => {
    const recap = buildDetailRecap([
      "lets do saturday 7th march at 6pm",
      "actually sunday 8th march then, 1pm",
    ]);
    expect(recap).toContain("sunday 8th march");
    expect(recap).toContain("1pm");
    expect(recap).not.toContain("saturday");
    expect(recap).not.toContain("7th");
    expect(recap).not.toContain("6pm");
  });

  it("★ keeps the last statement when a slot moves twice inside one turn", () => {
    // The correction shape this module exists to get right. "no" is not in the
    // negation vocabulary precisely because of this sentence: read as a
    // negation it would drop the SUPERSEDING date and leave the old one.
    const recap = buildDetailRecap(["saturday 7th march no wait sunday 8th march"]);
    expect(recap).toContain("sunday 8th march");
    expect(recap).not.toContain("7th");
  });

  it("leaves a slot the later turns never mention exactly as it was", () => {
    const recap = buildDetailRecap([
      "theres an italian on bridgford road",
      "sunday 8th march then, 1pm",
    ]);
    expect(recap).toContain("italian on bridgford road");
    expect(recap).toContain("sunday 8th march");
  });

  it("is empty when no turn states a detail", () => {
    expect(buildDetailRecap(["hows it going", "no details here at all"])).toBe("");
    expect(buildDetailRecap([])).toBe("");
  });

  it("renders slots in a fixed order, so the block is a pure function of them", () => {
    const forwards = buildDetailRecap(["sunday 8th march at 1pm", "the pub on gladstone street"]);
    const backwards = buildDetailRecap(["the pub on gladstone street", "sunday 8th march at 1pm"]);
    expect(forwards).toBe(backwards);
    expect(forwards.indexOf("date:")).toBeLessThan(forwards.indexOf("time:"));
    expect(forwards.indexOf("time:")).toBeLessThan(forwards.indexOf("place:"));
  });
});

describe("applyDetailRecaps — the KV strict-prefix contract", () => {
  it("never recaps into the first user turn (nothing precedes it)", () => {
    const messages = birthdayTurns();
    expect(applyDetailRecaps(messages)[0]!.content).toBe(messages[0]!.content);
  });

  it("derives turn K's recap only from turns before K", () => {
    const messages = birthdayTurns();
    // Turn 4 is the turn that fixes the date. Its own date must not appear in
    // its own recap — only the venue and price from turn 2 may.
    const recap = recapAt(messages, 4);
    expect(recap).toContain("bridgford road");
    expect(recap).not.toContain("sunday 8th march");
  });

  it("★ re-renders an earlier turn byte-identically as the conversation grows", () => {
    // THE load-bearing property. A turn's recap must not change when later
    // turns arrive, or the cached token sequence stops being a strict prefix of
    // the next render and KV reuse silently dies for the whole conversation.
    const full = birthdayTurns();
    const rendered = applyDetailRecaps(full);

    for (let cut = 1; cut <= full.length; cut++) {
      const earlier = applyDetailRecaps(full.slice(0, cut));
      for (let i = 0; i < earlier.length; i++) {
        expect(earlier[i]!.content).toBe(rendered[i]!.content);
      }
    }
  });

  it("is a pure function of the branch — repeated calls agree", () => {
    const messages = birthdayTurns();
    expect(applyDetailRecaps(messages).map((m) => m.content)).toEqual(
      applyDetailRecaps(messages).map((m) => m.content),
    );
  });

  it("does not mutate the messages it is given", () => {
    const messages = birthdayTurns();
    const before = messages.map((m) => m.content);
    applyDetailRecaps(messages);
    expect(messages.map((m) => m.content)).toEqual(before);
  });

  it("leaves assistant turns untouched", () => {
    const messages = birthdayTurns();
    const applied = applyDetailRecaps(messages);
    messages.forEach((message, i) => {
      if (message.role !== "user") expect(applied[i]!.content).toBe(message.content);
    });
  });

  it("never recaps a detail only the assistant stated", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "when should we do it" },
      { role: "assistant", content: "Sunday 8th March at 1pm works, at the pub on Main Street." },
      { role: "user", content: "ok write the invite" },
    ];
    expect(applyDetailRecaps(messages)).toEqual(messages);
  });

  it("is a no-op for a conversation that states no details", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "hows things" },
      { role: "assistant", content: "good thanks" },
      { role: "user", content: "whats a good name for a cat" },
    ];
    expect(applyDetailRecaps(messages)).toEqual(messages);
  });
});

describe("appendDetailRecaps — surviving context eviction", () => {
  function asChatMessages(): ChatMessage[] {
    return birthdayTurns().map((turn, i) => ({
      id: `m${i}`,
      role: turn.role,
      content: turn.content,
      parentId: i === 0 ? null : `m${i - 1}`,
      createdAt: 0,
    })) as ChatMessage[];
  }

  it("gives an evicted window the same recaps the full branch would have", () => {
    const branch = asChatMessages();
    const recaps = buildBranchRecaps(branch);
    const full = appendBranchRecaps(branch, recaps);

    const windowed = selectMessagesForContext(branch, 700);
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThan(branch.length);

    for (const message of appendBranchRecaps(windowed, recaps)) {
      expect(message.content).toBe(full.find((m) => m.id === message.id)!.content);
    }
  });

  it("still carries the venue after the turn that stated it is evicted", () => {
    const branch = asChatMessages();
    const recaps = buildBranchRecaps(branch);
    const windowed = selectMessagesForContext(branch, 700);
    expect(windowed.some((m) => m.content.includes("bridgford road weve been"))).toBe(false);

    const rendered = appendBranchRecaps(windowed, recaps)
      .map((m) => m.content)
      .join("\n");
    expect(rendered).toContain("bridgford road");
  });
});

describe("applyDetailRecaps — the birthday conversation it was built for", () => {
  it("carries every specific the message has to contain", () => {
    // The probed turn (index 6) asks for the group-chat message. Measured over
    // 10 real generations before this existed: venue 1/10, right date 5/10,
    // price 5/10, and 7/10 left a bracketed placeholder instead.
    const recap = recapAt(birthdayTurns(), 6);
    expect(recap).toContain("sunday 8th march");
    expect(recap).toContain("1pm");
    expect(recap).toContain("italian on bridgford road");
    expect(recap).toContain("25 quid a head");
  });

  it("★★ never carries the date the conversation moved off", () => {
    // The corpus names this as the bounce condition, and a hint that made the
    // model reuse the user's own wording pulled it back 1/10 -> 5/10. This
    // module re-injects that wording by design, so the corrected-away date has
    // to be unreachable.
    const recap = recapAt(birthdayTurns(), 6);
    expect(recap.toLowerCase()).not.toContain("saturday");
    expect(recap).not.toContain("7th");
  });

  it("never carries the venue she ruled out", () => {
    expect(recapAt(birthdayTurns(), 6).toLowerCase()).not.toContain("pescatore");
  });

  it("stays short enough to be worth its place in the prompt", () => {
    expect(recapAt(birthdayTurns(), 6).length).toBeLessThan(200);
  });
});

describe("buildDetailRecap — across the whole conversation corpus", () => {
  const fires = ["convo-birthday-lunch-message", "convo-teacher-email-resend", "convo-insurance-recall"];

  it("is inert on every conversation that settles no dated arrangement", () => {
    // ★ PROVEN BY EXECUTION, not by argument, and proven on the RENDERED turn
    // rather than just the recap string: on these the prompt sent is
    // byte-identical to what it was before this module existed.
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      if (fires.includes(item.id)) continue;
      const turns = conversation(item.id);
      const hinted = applyTurnHints(turns, true);
      const withFigures = appendFigureRecaps(hinted, buildBranchFigureRecaps(turns));
      const withBoth = appendBranchRecaps(hinted, buildBranchRecaps(turns));
      expect([item.id, buildDetailRecap(priorUserTurns(item.id))]).toEqual([item.id, ""]);
      expect([item.id, withBoth.map((m) => m.content)]).toEqual([
        item.id,
        withFigures.map((m) => m.content),
      ]);
    }
  });

  it("carries the days off school the teacher email has to name", () => {
    expect(buildDetailRecap(priorUserTurns("convo-teacher-email-resend"))).toContain(
      "thursday and friday",
    );
  });

  it("carries only the one date the insurance conversation typed itself", () => {
    // Its long turns are pasted policy and booking documents, and their dates
    // are not the user's stated details. The only date left is the one he
    // typed: the day he paid the deposit.
    const recap = buildDetailRecap(priorUserTurns("convo-insurance-recall"));
    expect(recap).toContain("14th feb");
    expect(recap).not.toContain("06:15");
    expect(recap).not.toContain("19th september");
  });
});

describe("composition with the figure recap", () => {
  it("★ the two blocks are never both non-empty on today's corpus", () => {
    // Which is why two labelled blocks costs nothing today. If a conversation
    // ever earns both, this turns red and the merged-block question gets asked
    // against real evidence rather than in the abstract.
    for (const item of EVERYDAY_CONVERSATION_CORPUS) {
      const prior = priorUserTurns(item.id);
      const both = buildFigureRecap(prior).length > 0 && buildDetailRecap(prior).length > 0;
      expect([item.id, both]).toEqual([item.id, false]);
    }
  });

  it("leaves the budget conversation's figure recap exactly as it was", () => {
    // The conversation `figure-recap.ts` was measured on. This module must not
    // add to it, remove from it, or duplicate any of it.
    const prior = priorUserTurns("convo-four-day-budget-list");
    expect(buildDetailRecap(prior)).toBe("");
    expect(buildFigureRecap(prior)).toContain("take home 2180");

    const budget = conversation("convo-four-day-budget-list");
    const recaps = buildBranchRecaps(budget);
    expect(recaps.details.every((recap) => recap === "")).toBe(true);
  });

  it("appends figures first, then details, and nothing else", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "rent 745. council tax 142. water 31. sunday 8th march at 1pm" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "write it out" },
    ];
    const composed = appendBranchRecaps(messages, buildBranchRecaps(messages));
    const tail = composed[2]!.content.slice(messages[2]!.content.length);
    expect(tail.indexOf("Figures I gave")).toBeGreaterThan(-1);
    expect(tail.indexOf("Figures I gave")).toBeLessThan(tail.indexOf("Details I gave"));
    expect(tail).toContain("sunday 8th march");
  });
});

describe("applyDetailRecaps — leaves the existing turn machinery alone", () => {
  it("does not read as an explicit format instruction", () => {
    const recap = recapAt(birthdayTurns(), 6);
    expect(recap).not.toBe("");
    expect(hasExplicitFormatInstruction(recap)).toBe(false);
  });

  it("WHY the recap is applied last: classifying recapped text changes the intent", () => {
    // The reason this runs after `applyTurnHints` rather than before it — the
    // same measured reason `figure-recap.test.ts` records for its own block.
    // Recapped text is longer and denser, and on this conversation that alone
    // flips a turn from `explain` to `deep`, which resolves different sampling
    // options. Kept as a standing net: if this ever stops being true the
    // ordering is still correct, but the measured reason for it has changed.
    const messages = birthdayTurns();
    const recapped = applyDetailRecaps(messages);
    const flipped = messages.some(
      (message, i) =>
        message.role === "user" &&
        inferTurnIntent(recapped[i]!.content, i > 0) !== inferTurnIntent(message.content, i > 0),
    );
    expect(flipped).toBe(true);
  });

  it("dispatch order leaves every hint decision exactly as the raw turn made it", () => {
    const messages = birthdayTurns();
    const hinted = applyTurnHints(messages, true);
    const composed = appendBranchRecaps(hinted, buildBranchRecaps(messages));

    composed.forEach((message, i) => {
      const hintedContent = hinted[i]!.content;
      expect(message.content.startsWith(hintedContent)).toBe(true);
      const tail = message.content.slice(hintedContent.length);
      expect(tail === "" || tail.startsWith("\n\n")).toBe(true);
    });
  });

  it("recaps the same details whether or not hints were applied first", () => {
    const messages = birthdayTurns();
    expect(buildBranchDetailRecaps(applyTurnHints(messages, true))).toEqual(
      buildBranchDetailRecaps(messages),
    );
  });
});
