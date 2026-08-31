// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";

import { hasExplicitFormatInstruction } from "../answer-shape";
import { inferTurnIntent } from "../chat-intent";

type ChatTurnMessage = { role: "user" | "assistant" | "system"; content: string };
import {
  FIGURE_RECAP_CAP,
  appendFigureRecaps,
  applyFigureRecaps,
  buildBranchFigureRecaps,
  buildFigureRecap,
  extractStatedFigures,
} from "../figure-recap";
import { selectMessagesForContext } from "../context-window";
import type { ChatMessage } from "../../stores/chatStore";
import { EVERYDAY_CONVERSATION_CORPUS } from "../../__tests__/fixtures/everyday-conversation-corpus";

const BUDGET_CONVERSATION = EVERYDAY_CONVERSATION_CORPUS.find(
  (item) => item.id === "convo-four-day-budget-list",
);

function budgetTurns(): ChatTurnMessage[] {
  if (!BUDGET_CONVERSATION) throw new Error("convo-four-day-budget-list missing from corpus");
  return BUDGET_CONVERSATION.turns.map((turn) => ({
    role: turn.role,
    content: turn.text,
  }));
}

/** The recap block carried by the user turn at `index`, or "" when it has none. */
function recapAt(messages: readonly ChatTurnMessage[], index: number): string {
  const original = messages[index]!.content;
  const applied = applyFigureRecaps(messages)[index]!.content;
  return applied === original ? "" : applied.slice(original.length).trim();
}

describe("extractStatedFigures — number+noun pairs only", () => {
  it("pairs a figure with the noun the user attached it to", () => {
    const figures = extractStatedFigures("rent 745. council tax 142. water 31.");
    expect(figures.map((f) => `${f.label} ${f.value}`)).toEqual([
      "rent 745",
      "council tax 142",
      "water 31",
    ]);
  });

  it("ignores a bare number with no noun attached", () => {
    // The corpus's own turn 6 opens with a bare "279" quoted back from the
    // assistant's arithmetic. It is not a figure the user stated about anything.
    expect(extractStatedFigures("279 doesnt sound like much when you say it out loud")).toEqual([]);
  });

  it("ignores list indices and ordinals", () => {
    expect(extractStatedFigures("turn 3 was the one")).toEqual([]);
    expect(extractStatedFigures("she had a stroke on the 19th september")).toEqual([]);
  });

  it("keeps the currency symbol only when the user wrote one", () => {
    expect(extractStatedFigures("rent £790").map((f) => f.value)).toEqual(["£790"]);
    expect(extractStatedFigures("rent 790. water 31. phone 18.").map((f) => f.value)).toEqual([
      "790",
      "31",
      "18",
    ]);
  });

  it("carries the rate qualifier the user attached", () => {
    const figures = extractStatedFigures("car tax is 245 for the year");
    expect(figures).toHaveLength(1);
    expect(figures[0]!.qualifier).toBe("for the year");
  });

  it("does not bind a second, unrelated number to the preceding label", () => {
    // "dogs insurance 29 shes 11 now" — 11 is the dog's age, not a second
    // insurance figure. No supersession marker sits between them, so it drops.
    const figures = extractStatedFigures(
      "gym 34. netflix 12.99. dogs insurance 29 shes 11 now so its gone up",
    );
    expect(figures.map((f) => `${f.label} ${f.value}`)).toEqual([
      "gym 34",
      "netflix 12.99",
      "dogs insurance 29",
    ]);
  });

  it("supersedes an earlier figure when a restatement marker sits between them", () => {
    // "take home was 2690 a month now its 2180" — one label, two numbers, and
    // "now" marks the second as the live one.
    const figures = extractStatedFigures("take home was 2690 a month now its 2180");
    expect(figures.map((f) => `${f.label} ${f.value}`)).toEqual(["take home 2180"]);
  });
});

describe("extractStatedFigures — a figure has to look like one", () => {
  it("reads a lone figure only when it is written as money", () => {
    expect(extractStatedFigures("the deposit was £50").map((f) => f.value)).toEqual(["£50"]);
    expect(extractStatedFigures("the plan is 14.50").map((f) => f.value)).toEqual(["14.50"]);
    expect(extractStatedFigures("the gym is 34 a month").map((f) => f.value)).toEqual(["34"]);
    // No currency, no decimals, no rate, and nothing else in the turn to make it
    // a list of figures — "she is 11" is an age, not a bill.
    expect(extractStatedFigures("the dog is 11")).toEqual([]);
  });

  it("reads bare figures once the turn is plainly a list of them", () => {
    // How people actually dump a budget. Three pairs is the threshold.
    expect(extractStatedFigures("gym 34. water 31.")).toEqual([]);
    expect(extractStatedFigures("gym 34. water 31. phone 18.").map((f) => f.value)).toEqual([
      "34",
      "31",
      "18",
    ]);
  });

  it("ignores dates, times and reference codes", () => {
    expect(extractStatedFigures("the flight departs 06:15 on 03/04/2026")).toEqual([]);
    expect(extractStatedFigures("policy SVT/TRV/09-25 covers it")).toEqual([]);
  });
});

describe("extractStatedFigures — pasted documents are not stated figures", () => {
  it("reads nothing from a turn long enough to be carrying a document", () => {
    const pasted = `here is the booking\n\n${"Deposit paid £300.00. Balance £2,547.60. ".repeat(20)}`;
    expect(pasted.length).toBeGreaterThan(600);
    expect(extractStatedFigures(pasted)).toEqual([]);
  });

  it("reads nothing out of an attachment block", () => {
    const withFile = `<file name="bills.txt">rent 745. council tax 142. water 31.</file>`;
    expect(extractStatedFigures(withFile)).toEqual([]);
  });

  it("still reads a normal bill dump, which is long but typed", () => {
    const billDump = budgetTurns()[2]!.content;
    expect(billDump.length).toBeGreaterThan(280);
    expect(extractStatedFigures(billDump).length).toBeGreaterThan(10);
  });
});

describe("buildFigureRecap — last-stated-wins", () => {
  it("keeps only the most recent value for a restated label", () => {
    // The second turn is bare prose with one figure in it — it only counts
    // because "rent" was already established as a figure by the first turn.
    const recap = buildFigureRecap([
      "rent 745. water 31. phone 18.",
      "rents going up to 790 in october",
    ]);
    expect(recap).toContain("rent 790");
    expect(recap).not.toContain("745");
    expect(recap).toContain("water 31");
  });

  it("ignores a bare prose figure whose label was never established", () => {
    const recap = buildFigureRecap([
      "rent 745. water 31. phone 18.",
      "the dog is 11 now so its gone up",
    ]);
    expect(recap).not.toContain("dog");
  });

  it("keeps the last value when the restatement happens inside one turn", () => {
    const recap = buildFigureRecap(["take home was 2690 a month now its 2180"]);
    expect(recap).toContain("2180");
    expect(recap).not.toContain("2690");
  });

  it("is empty when no turn states a trackable figure", () => {
    expect(buildFigureRecap(["hows it going", "no numbers here at all"])).toBe("");
    expect(buildFigureRecap([])).toBe("");
  });
});

describe("buildFigureRecap — recency-order capping", () => {
  // Labels must be pure letters: the tokenizer splits "item0" into a word and a
  // number, which would make every fixture turn share one label.
  const capLabel = (i: number) =>
    `zz${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
  const overCap = Array.from(
    { length: FIGURE_RECAP_CAP + 5 },
    (_, i) => `${capLabel(i)} £${100 + i}.`,
  );

  it("caps the number of distinct figures it carries", () => {
    const recap = buildFigureRecap(overCap);
    expect(recap.match(/zz[a-z]{2}/g) ?? []).toHaveLength(FIGURE_RECAP_CAP);
  });

  it("drops the oldest and keeps the most recently stated", () => {
    const recap = buildFigureRecap(overCap);
    expect(recap).not.toContain(capLabel(0));
    expect(recap).not.toContain(capLabel(4));
    expect(recap).toContain(capLabel(FIGURE_RECAP_CAP + 4));
  });
});

describe("applyFigureRecaps — the KV strict-prefix contract", () => {
  it("never recaps into the first user turn (nothing precedes it)", () => {
    const messages = budgetTurns();
    expect(applyFigureRecaps(messages)[0]!.content).toBe(messages[0]!.content);
  });

  it("derives turn K's recap only from turns before K", () => {
    const messages = budgetTurns();
    // Turn 2 states the bill list. Its own figures must not appear in its own
    // recap — only turn 0's take-home figure may.
    const recap = recapAt(messages, 2);
    expect(recap).toContain("2180");
    expect(recap).not.toContain("745");
    expect(recap).not.toContain("142");
  });

  it("re-renders an earlier turn byte-identically as the conversation grows", () => {
    // THE load-bearing property. A turn's recap must not change when later
    // turns arrive, or the cached token sequence stops being a strict prefix
    // of the next render and KV reuse silently dies for the whole conversation.
    const full = budgetTurns();
    const rendered = applyFigureRecaps(full);

    for (let cut = 1; cut <= full.length; cut++) {
      const earlier = applyFigureRecaps(full.slice(0, cut));
      for (let i = 0; i < earlier.length; i++) {
        expect(earlier[i]!.content).toBe(rendered[i]!.content);
      }
    }
  });

  it("is a pure function of the branch — repeated calls agree", () => {
    const messages = budgetTurns();
    expect(applyFigureRecaps(messages).map((m) => m.content)).toEqual(
      applyFigureRecaps(messages).map((m) => m.content),
    );
  });

  it("does not mutate the messages it is given", () => {
    const messages = budgetTurns();
    const before = messages.map((m) => m.content);
    applyFigureRecaps(messages);
    expect(messages.map((m) => m.content)).toEqual(before);
  });

  it("leaves assistant turns untouched", () => {
    const messages = budgetTurns();
    const applied = applyFigureRecaps(messages);
    messages.forEach((message, i) => {
      if (message.role !== "user") expect(applied[i]!.content).toBe(message.content);
    });
  });

  it("is a no-op for a conversation that states no figures", () => {
    const messages: ChatTurnMessage[] = [
      { role: "user", content: "hows things" },
      { role: "assistant", content: "good thanks" },
      { role: "user", content: "whats a good name for a cat" },
    ];
    expect(applyFigureRecaps(messages)).toEqual(messages);
  });
});

describe("appendFigureRecaps — surviving context eviction", () => {
  function asChatMessages(): ChatMessage[] {
    return budgetTurns().map((turn, i) => ({
      id: `m${i}`,
      role: turn.role,
      content: turn.content,
      parentId: i === 0 ? null : `m${i - 1}`,
      createdAt: 0,
    })) as ChatMessage[];
  }

  it("gives an evicted window the same recaps the full branch would have", () => {
    // THE reason recaps derive from the branch and not from the window. A
    // window that has lost early turns must still recap the figures those
    // turns carried, and each surviving turn must keep the recap it was
    // cached with — otherwise the eviction rewrites history and the KV
    // prefix breaks for every turn after it.
    const branch = asChatMessages();
    const recaps = buildBranchFigureRecaps(branch);
    const full = appendFigureRecaps(branch, recaps);

    // A context small enough to force real eviction.
    const windowed = selectMessagesForContext(branch, 700);
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.length).toBeLessThan(branch.length);

    const windowedWithRecaps = appendFigureRecaps(windowed, recaps);
    for (const message of windowedWithRecaps) {
      const fromFullBranch = full.find((m) => m.id === message.id);
      expect(message.content).toBe(fromFullBranch!.content);
    }
  });

  it("still carries the take-home figure after the turn that stated it is evicted", () => {
    const branch = asChatMessages();
    const recaps = buildBranchFigureRecaps(branch);
    const windowed = selectMessagesForContext(branch, 700);
    expect(windowed.some((m) => m.content.includes("take home was 2690"))).toBe(false);

    const rendered = appendFigureRecaps(windowed, recaps)
      .map((m) => m.content)
      .join("\n");
    expect(rendered).toContain("2180");
  });
});

describe("applyFigureRecaps — the budget conversation it was built for", () => {
  it("surfaces the take-home figure at the turn that asks for the list", () => {
    // The probed turn (index 8) asks for the printable budget. Across 27 real
    // generations the £2,180 take-home — stated once, in turn 0 — reached the
    // answer 0 times. It has to be in this turn's recap.
    const recap = recapAt(budgetTurns(), 8);
    expect(recap).toContain("2180");
  });

  it("carries the superseding rent, never the superseded one", () => {
    const recap = recapAt(budgetTurns(), 8);
    expect(recap).toContain("790");
    expect(recap).not.toContain("745");
  });

  it("recaps only the user's own figures, never the assistant's arithmetic", () => {
    // The assistant computed £1,646, £1,750.50 and £1,900.50. Recapping a
    // computed outgoings total is the exact "expense total relabelled as
    // income" failure this is meant to stop, so those must never appear.
    const recap = recapAt(budgetTurns(), 8);
    for (const total of ["1,646", "1646", "1,750.50", "1750.50", "1,900.50", "1900.50"]) {
      expect(recap).not.toContain(total);
    }
  });

  it("stays inside the cap on the corpus's most figure-dense conversation", () => {
    // If the cap bound here it would drop real figures from a normal
    // conversation — the cap is a bloat ceiling, not a working limit.
    const figureCount = recapAt(budgetTurns(), 8).split(";").length;
    expect(figureCount).toBeLessThan(FIGURE_RECAP_CAP);
  });
});

describe("applyFigureRecaps — leaves the existing turn machinery alone", () => {
  it("does not read as an explicit format instruction", () => {
    // A block that tripped this detector would suppress the per-turn quality
    // hint on every turn carrying a recap.
    const recap = recapAt(budgetTurns(), 8);
    expect(recap).not.toBe("");
    expect(hasExplicitFormatInstruction(recap)).toBe(false);
  });

  it("WHY the recap is applied last: classifying recapped text changes the intent", () => {
    // Recapped text is longer and denser, and on this conversation that alone
    // flips a turn's intent — which resolves different sampling options. Kept
    // as a standing net: if this ever stops being true the ordering is still
    // correct, but the measured reason for it has changed.
    const messages = budgetTurns();
    const recapped = applyFigureRecaps(messages);
    const flipped = messages.some(
      (message, i) =>
        message.role === "user" &&
        inferTurnIntent(recapped[i]!.content, i > 0) !== inferTurnIntent(message.content, i > 0),
    );
    expect(flipped).toBe(true);
  });

});
