// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import {
  datetimeTool,
  executeDatetime,
  resolveNamedDayTarget,
  type DatetimeArgs,
} from "../datetime-tool";

const { match, validate } = datetimeTool;

// A fixed reference point for deterministic execute assertions.
// 2026-06-15 is a Monday (local interpretation; we assert on the parts we control).
const FIXED_NOW = new Date(2026, 5, 15, 14, 30, 0); // June 15 2026, 14:30 local

describe("datetimeTool.match — current date/time/day true positives", () => {
  const cases: Array<{ input: string; op: "current"; kind: "date" | "time" | "dayOfWeek" }> = [
    { input: "what day is it", op: "current", kind: "dayOfWeek" },
    { input: "What day is it today?", op: "current", kind: "dayOfWeek" },
    { input: "what day of the week is it", op: "current", kind: "dayOfWeek" },
    { input: "what's today's date", op: "current", kind: "date" },
    { input: "what is the date", op: "current", kind: "date" },
    { input: "today's date", op: "current", kind: "date" },
    { input: "what is the date today", op: "current", kind: "date" },
    { input: "what time is it", op: "current", kind: "time" },
    { input: "what's the current time", op: "current", kind: "time" },
  ];

  for (const { input, op, kind } of cases) {
    it(`matches "${input}" → ${op}/${kind}`, () => {
      const args = match(input);
      expect(args).not.toBeNull();
      expect(args).toMatchObject({ op, kind });
    });
  }
});

describe("datetimeTool.match — date arithmetic true positives", () => {
  it("matches '90 days from today' as an offset", () => {
    expect(match("what day is 90 days from today")).toEqual({ op: "offset", days: 90 });
  });
  it("matches '30 days from now'", () => {
    expect(match("30 days from now")).toEqual({ op: "offset", days: 30 });
  });
  it("matches '7 days ago' as a negative offset", () => {
    expect(match("what was the date 7 days ago")).toEqual({ op: "offset", days: -7 });
  });
  it("matches 'what's the date in 30 days'", () => {
    expect(match("what's the date in 30 days")).toEqual({ op: "offset", days: 30 });
  });
  it("matches 'days until 2026-12-25'", () => {
    expect(match("days until 2026-12-25")).toEqual({ op: "until", target: "2026-12-25" });
  });
  it("matches 'how many days until 2026-12-25'", () => {
    expect(match("how many days until 2026-12-25")).toEqual({ op: "until", target: "2026-12-25" });
  });
});

describe("datetimeTool.match — named fixed-date days (audit RC6)", () => {
  // match() resolves named days against the real clock, so assert shape, not a
  // hard-coded year: the target must be the named month-day in the current or
  // next calendar year.
  it("matches 'how many days until Christmas?'", () => {
    const args = match("how many days until Christmas?");
    expect(args).not.toBeNull();
    expect(args).toMatchObject({ op: "until" });
    expect((args as { target: string }).target).toMatch(/^\d{4}-12-25$/);
  });

  it("matches 'days till new year's eve'", () => {
    const args = match("days till new year's eve");
    expect(args).toMatchObject({ op: "until" });
    expect((args as { target: string }).target).toMatch(/^\d{4}-12-31$/);
  });

  it("resolves 'Christmas Eve' before bare 'Christmas'", () => {
    const args = match("how many days until Christmas Eve?");
    expect((args as { target: string }).target).toMatch(/^\d{4}-12-24$/);
  });

  it("does NOT fire on a named day without an until lead", () => {
    expect(match("I love Christmas")).toBeNull();
    expect(match("what should I cook for Halloween")).toBeNull();
  });
});

describe("resolveNamedDayTarget — next-occurrence year math", () => {
  // FIXED reference: June 15 2026 (UTC fields are what the resolver reads).
  const NOW = new Date(Date.UTC(2026, 5, 15));

  it("uses the current year when the day is still ahead", () => {
    expect(resolveNamedDayTarget("days until christmas", NOW)).toBe("2026-12-25");
    expect(resolveNamedDayTarget("days until halloween", NOW)).toBe("2026-10-31");
  });

  it("rolls to next year when the day has passed", () => {
    expect(resolveNamedDayTarget("days until valentine's day", NOW)).toBe("2027-02-14");
    expect(resolveNamedDayTarget("days until new year's day", NOW)).toBe("2027-01-01");
  });

  it("treats today as this year's occurrence (0 days, not 365)", () => {
    const fourthOfJuly = new Date(Date.UTC(2026, 6, 4));
    expect(resolveNamedDayTarget("days until 4th of july", fourthOfJuly)).toBe("2026-07-04");
  });

  it("returns null when no named day is present", () => {
    expect(resolveNamedDayTarget("days until my birthday", NOW)).toBeNull();
  });
});

describe("datetimeTool.match — false-positive guard (must NOT match)", () => {
  const nonMatches: string[] = [
    "I had a great day",
    "what's a good first-date idea",
    "the update is out of date",
    "have a nice day",
    "let's make a date for coffee",
    "the data is up to date",
    "back in the day things were different",
    "what day-to-day tasks should I prioritize",
    "she is my date for the wedding",
    "how do I time my workouts",
    "it's about time we talked",
  ];

  for (const input of nonMatches) {
    it(`abstains on "${input}"`, () => {
      expect(match(input)).toBeNull();
    });
  }
});

/**
 * The offset branch used to read "N days ago / from today / later" anywhere in the
 * turn, with no requirement that a date was being asked about. Measured in the
 * realistic-input sweep (2026-08-29): a nine-item to-do list containing "she asked
 * like 10 days ago" matched `{op:"offset",days:-10}`, and because a datetime match
 * returns a canonicalAnswer, the reply to the whole turn would have been the date
 * ten days ago. Nothing left the device; the turn was still taken.
 *
 * The guard is scope, not a longer pattern: a short turn IS the ask, and a long one
 * needs the same date cue the "in N days" branch below it already required.
 */
describe("datetimeTool.match — offsets are scoped to the ask, not the paste", () => {
  const TASK_LIST =
    "help me figure out what to actually do today, I keep bouncing between these and finishing nothing\n\n" +
    "- call the dentist back (they left a voicemail tuesday)\n" +
    "- finish the Q3 deck — slides 8-14 still empty\n" +
    "- renew car registration, expires end of month\n" +
    "- reply to Jenna about the wedding, she asked like 10 days ago\n" +
    "- gym\n- pick up the prescription\n- laundry (out of clean shirts as of tomorrow)\n" +
    "- look into that weird charge on the credit card statement\n" +
    "- book flights for october before they go up\n\n" +
    "the deck is the one I keep avoiding. meeting is thursday";

  it("abstains when the offset phrase is buried in a pasted to-do list", () => {
    expect(match(TASK_LIST)).toBeNull();
  });

  it("still matches when the offset phrase is essentially the whole turn", () => {
    expect(match("30 days ago")).toEqual({ op: "offset", days: -30 });
  });

  it("still matches a long turn that carries a date cue", () => {
    const longAsk =
      "I'm trying to work out when my return window actually closes — I bought it on a Friday " +
      "and the shop said the policy runs from the purchase date, not the delivery date, which " +
      "is a whole other argument. Anyway: what day was 30 days ago, so I can count forward " +
      "from there and stop guessing at this?";
    expect(longAsk.length).toBeGreaterThan(280);
    expect(match(longAsk)).toEqual({ op: "offset", days: -30 });
  });
});

describe("datetimeTool.match — abstention on empty/garbage", () => {
  it("returns null for empty / whitespace", () => {
    expect(match("")).toBeNull();
    expect(match("   ")).toBeNull();
  });
});

describe("datetimeTool.execute — deterministic with fixed now", () => {
  it("formats the current date", () => {
    const result = executeDatetime({ op: "current", kind: "date" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("June");
    expect(result.display).toContain("2026");
    expect(result.display).toContain("15");
  });

  it("formats the current day of week", () => {
    const result = executeDatetime({ op: "current", kind: "dayOfWeek" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("Monday");
  });

  it("formats the current time", () => {
    const result = executeDatetime({ op: "current", kind: "time" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toMatch(/\d{1,2}:\d{2}/);
  });

  it("computes a positive offset (90 days from today)", () => {
    const result = executeDatetime({ op: "offset", days: 90 }, FIXED_NOW);
    expect(result.ok).toBe(true);
    // 2026-06-15 + 90 days = 2026-09-13.
    expect(result.display).toContain("September");
    expect(result.display).toContain("13");
    expect(result.display).toContain("90 days from today");
  });

  it("computes a negative offset (7 days ago)", () => {
    const result = executeDatetime({ op: "offset", days: -7 }, FIXED_NOW);
    expect(result.ok).toBe(true);
    // 2026-06-15 - 7 days = 2026-06-08.
    expect(result.display).toContain("8");
    expect(result.display).toContain("7 days ago");
  });

  it("computes days until a future date", () => {
    const result = executeDatetime({ op: "until", target: "2026-12-25" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    // 2026-06-15 → 2026-12-25 = 193 days.
    expect(result.display).toContain("193 days until");
  });

  it("reports a past date as days ago", () => {
    const result = executeDatetime({ op: "until", target: "2026-01-01" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("ago");
  });

  it("rejects an invalid date in until", () => {
    const result = executeDatetime({ op: "until", target: "2026-02-31" }, FIXED_NOW);
    expect(result.ok).toBe(false);
  });
});

describe("datetimeTool.execute — until target date renders correctly (UTC regression)", () => {
  // REGRESSION: the original code formatted UTC-midnight target dates with a
  // local-time Intl.DateTimeFormat. In west-of-UTC timezones (all Americas),
  // UTC midnight = the PREVIOUS calendar day locally, so "until 2026-12-25"
  // rendered as "December 24" instead of "December 25". The fix uses a UTC-
  // pinned formatter (DATE_FMT_UTC with timeZone:"UTC") for the until target.
  // These tests assert the FULL rendered target date, not just the day count.

  it("until 2026-12-25 renders 'December 25' not 'December 24'", () => {
    const result = executeDatetime({ op: "until", target: "2026-12-25" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("December 25, 2026");
    expect(result.display).toContain("Friday");
    // The day count is still correct.
    expect(result.display).toContain("193 days until");
  });

  it("until tomorrow renders the correct date, not today", () => {
    // FIXED_NOW = 2026-06-15 (Monday); tomorrow = 2026-06-16 (Tuesday).
    const result = executeDatetime({ op: "until", target: "2026-06-16" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("June 16, 2026");
    expect(result.display).toContain("Tuesday");
    expect(result.display).toContain("1 day until");
  });

  it("until today renders 'is today' with the correct date", () => {
    // FIXED_NOW = 2026-06-15; target = same day.
    const result = executeDatetime({ op: "until", target: "2026-06-15" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("June 15, 2026");
    expect(result.display).toContain("is today");
  });

  it("until a past date renders the correct target (not off-by-one)", () => {
    // FIXED_NOW = 2026-06-15; 2026-01-01 is in the past.
    const result = executeDatetime({ op: "until", target: "2026-01-01" }, FIXED_NOW);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("January 1, 2026");
    expect(result.display).toContain("Thursday");
    expect(result.display).toContain("ago");
  });
});

describe("datetimeTool.validate", () => {
  it("accepts valid current args", () => {
    expect(validate({ op: "current", kind: "date" } satisfies DatetimeArgs)).toBe(true);
  });
  it("accepts valid offset args", () => {
    expect(validate({ op: "offset", days: 5 } satisfies DatetimeArgs)).toBe(true);
  });
  it("accepts valid until args", () => {
    expect(validate({ op: "until", target: "2026-12-25" } satisfies DatetimeArgs)).toBe(true);
  });
  it("rejects unknown op", () => {
    expect(validate({ op: "wat" })).toBe(false);
  });
  it("rejects malformed until target", () => {
    expect(validate({ op: "until", target: "Dec 25" })).toBe(false);
  });
  it("rejects non-finite offset", () => {
    expect(validate({ op: "offset", days: Number.NaN })).toBe(false);
  });
  it("rejects null / non-object", () => {
    expect(validate(null)).toBe(false);
    expect(validate("today")).toBe(false);
  });
});

describe("datetimeTool.summarize — friendly headline", () => {
  it("frames the current-date/time/day questions", () => {
    expect(datetimeTool.summarize?.({ op: "current", kind: "date" })).toBe("Today's date");
    expect(datetimeTool.summarize?.({ op: "current", kind: "time" })).toBe("Current time");
    expect(datetimeTool.summarize?.({ op: "current", kind: "dayOfWeek" })).toBe(
      "Today's day of the week",
    );
  });

  it("frames offsets with direction + pluralization", () => {
    expect(datetimeTool.summarize?.({ op: "offset", days: 90 })).toBe("90 days from today");
    expect(datetimeTool.summarize?.({ op: "offset", days: 1 })).toBe("1 day from today");
    expect(datetimeTool.summarize?.({ op: "offset", days: -30 })).toBe("30 days ago");
    expect(datetimeTool.summarize?.({ op: "offset", days: -1 })).toBe("1 day ago");
  });

  it("frames a days-until question with the target date", () => {
    expect(datetimeTool.summarize?.({ op: "until", target: "2026-12-25" })).toBe(
      "Days until 2026-12-25",
    );
  });
});

describe("datetimeTool.match — current-time must not fire on clock arithmetic", () => {
  it("does not treat 'what time does it arrive' as a current-time ask", () => {
    const args = match(
      "my train leaves at 2:15pm and the journey takes 1 hour 50 minutes, what time does it arrive"
    );
    expect(args).not.toMatchObject({ op: "current" });
  });
  it("still matches 'what's the time'", () => {
    expect(match("what's the time")).toMatchObject({ op: "current", kind: "time" });
  });
});

describe("datetimeTool.match — clock arithmetic", () => {
  it("adds a duration for an arrival ask", () => {
    expect(
      match("my train leaves at 2:15pm and the journey takes 1 hour 50 minutes, what time does it arrive")
    ).toEqual({ op: "clock", startMinutes: 14 * 60 + 15, deltaMinutes: 110, meridiem: true });
  });
  it("subtracts summed durations for a 'when should i leave' ask", () => {
    expect(
      match(
        "my flight is at 6am and i want to be at the airport 90 minutes before. it's a 40 minute drive. what time should i leave?"
      )
    ).toEqual({ op: "clock", startMinutes: 6 * 60, deltaMinutes: -130, meridiem: true });
  });
  it("handles a bare h:mm start with no am/pm", () => {
    expect(match("if i start a 45 minute workout at 6:20 what time do i finish")).toEqual({
      op: "clock",
      startMinutes: 6 * 60 + 20,
      deltaMinutes: 45,
      meridiem: false,
    });
  });
  it("subtracts for 'when should i leave'", () => {
    expect(
      match("i need to be at the dentist at 9:30 and it takes 25 minutes to get there, when should i leave")
    ).toEqual({ op: "clock", startMinutes: 9 * 60 + 30, deltaMinutes: -25, meridiem: false });
  });
  it("adds hours and minutes for a movie end", () => {
    expect(match("a movie is 2 hours 20 minutes long and starts at 7:40pm, when does it end")).toEqual({
      op: "clock",
      startMinutes: 19 * 60 + 40,
      deltaMinutes: 140,
      meridiem: true,
    });
  });
  it("abstains without a question", () => {
    expect(match("i ran for 30 minutes at 5pm and felt great")).toBeNull();
  });
  it("abstains without a direction cue", () => {
    expect(match("what time is 6:20 plus 45 minutes in france")).toBeNull();
  });
  it("abstains when the start time is ambiguous (no colon, no am/pm)", () => {
    expect(match("i leave at 6 and drive 40 minutes, when do i arrive")).toBeNull();
  });
  it("abstains on two clock times", () => {
    expect(match("from 2:15pm to 4:05pm is how long, when does it end in 10 minutes")).toBeNull();
  });
});

describe("executeDatetime — clock arithmetic", () => {
  it("formats an am/pm result and leads the note with the answer", () => {
    const r = executeDatetime({ op: "clock", startMinutes: 14 * 60 + 15, deltaMinutes: 110, meridiem: true });
    expect(r.ok).toBe(true);
    expect(r.display).toBe("2:15 PM + 1 hour 50 minutes = 4:05 PM.");
    expect(r.forModel).toContain("4:05 PM");
  });
  it("formats subtraction with am/pm", () => {
    const r = executeDatetime({ op: "clock", startMinutes: 6 * 60, deltaMinutes: -130, meridiem: true });
    expect(r.display).toBe("6:00 AM − 2 hours 10 minutes = 3:50 AM.");
  });
  it("keeps a bare 12-hour style when the input had no am/pm", () => {
    const r = executeDatetime({ op: "clock", startMinutes: 6 * 60 + 20, deltaMinutes: 45, meridiem: false });
    expect(r.display).toBe("6:20 + 45 minutes = 7:05.");
  });
  it("wraps across midnight", () => {
    const r = executeDatetime({ op: "clock", startMinutes: 23 * 60 + 30, deltaMinutes: 60, meridiem: true });
    expect(r.display).toBe("11:30 PM + 1 hour = 12:30 AM.");
  });
  it("rejects out-of-range args in validate", () => {
    expect(validate({ op: "clock", startMinutes: 1500, deltaMinutes: 5, meridiem: true })).toBe(false);
    expect(validate({ op: "clock", startMinutes: 60, deltaMinutes: 5, meridiem: true })).toBe(true);
  });
});
