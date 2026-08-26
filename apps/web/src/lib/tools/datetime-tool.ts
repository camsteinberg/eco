// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { EcoTool, EcoToolResult } from "./registry";

/**
 * The datetime tool answers explicit date/time questions deterministically:
 *  - current date / time / day-of-week ("what day is it", "today's date")
 *  - date arithmetic ("what day is 90 days from today")
 *  - days until a date ("days until 2026-12-25", "days until Christmas")
 *  - clock arithmetic ("leaves at 2:15pm, takes 1h50m, when does it arrive")
 *
 * Pure TS (Date / Intl, no deps). `match` is conservative — it only fires on
 * explicit date/time phrasing, never on idiomatic uses of "day"/"date".
 *
 * Named days cover FIXED-date occasions only (Christmas, New Year's, Halloween,
 * Valentine's, July 4th). Movable feasts (Easter, Thanksgiving) are deliberately
 * excluded — the tool answers only what it can compute exactly. Without this
 * coverage the model fills the gap itself, and on-device models produce
 * catastrophic date math (observed live: "Christmas (December 25, 2030) … ≈ 16
 * months. That's about 91 days" — the chat-experience quality audit, RC6).
 */

export type DatetimeOp = "current" | "offset" | "until" | "clock";

export type DatetimeArgs =
  | { op: "current"; kind: "date" | "time" | "dayOfWeek" }
  | { op: "offset"; days: number }
  | { op: "until"; target: string }
  /**
   * Clock arithmetic: a start time of day plus/minus a duration ("leaves at
   * 2:15pm, takes 1h50m, when does it arrive"). `startMinutes` is minutes since
   * midnight (0–1439); `deltaMinutes` is signed; `meridiem` records whether the
   * user wrote am/pm so the answer can be rendered in the same style.
   */
  | { op: "clock"; startMinutes: number; deltaMinutes: number; meridiem: boolean };

function isDatetimeArgs(value: unknown): value is DatetimeArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.op === "current") {
    return v.kind === "date" || v.kind === "time" || v.kind === "dayOfWeek";
  }
  if (v.op === "offset") {
    return typeof v.days === "number" && Number.isFinite(v.days);
  }
  if (v.op === "until") {
    return typeof v.target === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.target);
  }
  if (v.op === "clock") {
    return (
      Number.isInteger(v.startMinutes) &&
      (v.startMinutes as number) >= 0 &&
      (v.startMinutes as number) < 1440 &&
      Number.isInteger(v.deltaMinutes) &&
      typeof v.meridiem === "boolean"
    );
  }
  return false;
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
});
/**
 * UTC-pinned date formatter. Used exclusively for dates produced by
 * {@link parseIsoDate}, which returns UTC-midnight timestamps. Formatting those
 * with a local-time formatter shifts the rendered calendar day backwards in
 * west-of-UTC timezones (the #4 Phase 4a review blocker).
 */
const DATE_FMT_UTC = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
});
const WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "long" });

/** Parse an ISO `YYYY-MM-DD` into a UTC-midnight Date, or null if invalid. */
function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) {
    return null;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject overflow (e.g. 2026-02-31 → March).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** Whole days between two dates, counting calendar days (ignores time-of-day). */
function daysBetween(from: Date, to: Date): number {
  const startOfDay = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const ms = startOfDay(to) - startOfDay(from);
  return Math.round(ms / 86_400_000);
}

/**
 * Fixed-date named days resolvable to a `days until` target. Order matters:
 * "…Eve" entries must precede their bare names so "Christmas Eve" doesn't
 * resolve as "Christmas". Fixed calendar dates only — never movable feasts.
 */
const NAMED_DAYS: readonly { month: number; day: number; pattern: RegExp }[] = [
  { month: 12, day: 24, pattern: /\b(?:christmas|xmas)\s+eve\b/ },
  { month: 12, day: 25, pattern: /\b(?:christmas|xmas)\b/ },
  { month: 12, day: 31, pattern: /\bnew\s+year'?s?\s+eve\b/ },
  { month: 1, day: 1, pattern: /\bnew\s+year(?:'?s(?:\s+day)?)?\b/ },
  { month: 10, day: 31, pattern: /\bhalloween\b/ },
  { month: 2, day: 14, pattern: /\bvalentine'?s?(?:\s+day)?\b/ },
  { month: 7, day: 4, pattern: /\b(?:fourth|4th)\s+of\s+july\b|\bindependence\s+day\b|\bjuly\s+4(?:th)?\b/ },
];

/**
 * Resolve a named fixed-date day in `lower` to its NEXT occurrence as an ISO
 * `YYYY-MM-DD` string (this year if today-or-later, else next year), or null
 * when no named day is present. Day comparison uses the UTC calendar fields of
 * `now`, matching {@link daysBetween}'s day-counting convention.
 *
 * @internal Exported for unit testing.
 */
export function resolveNamedDayTarget(lower: string, now: Date): string | null {
  for (const named of NAMED_DAYS) {
    if (!named.pattern.test(lower)) {
      continue;
    }
    const thisYear = now.getUTCFullYear();
    const todayUtc = Date.UTC(thisYear, now.getUTCMonth(), now.getUTCDate());
    const occurrenceThisYear = Date.UTC(thisYear, named.month - 1, named.day);
    const year = occurrenceThisYear >= todayUtc ? thisYear : thisYear + 1;
    const mm = String(named.month).padStart(2, "0");
    const dd = String(named.day).padStart(2, "0");
    return `${String(year)}-${mm}-${dd}`;
  }
  return null;
}

/**
 * Words that decide the direction of clock arithmetic. Arrival-style asks add
 * the duration to the start; departure-style asks ("when should I leave")
 * subtract it. Without a cue the tool abstains — guessing the direction would
 * be worse than letting the model answer.
 */
const CLOCK_SUBTRACT = /\b(?:leave|depart|set\s+off|head\s+out|start\s+driving|go)\b/;
const CLOCK_ADD = /\b(?:arrive|arrival|get\s+there|finish|finished|end|ends|done|be\s+over|ready|get\s+home)\b/;

/** Parse "2:15pm", "6am", "9:30" into minutes since midnight. Bare "6" is ambiguous → skipped. */
function parseClockTimes(lower: string): { minutes: number; meridiem: boolean }[] {
  const out: { minutes: number; meridiem: boolean }[] = [];
  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\d:])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    const hasColon = m[2] !== undefined;
    const meridiem = m[3]?.replace(/\./g, "");
    if (!hasColon && meridiem === undefined) {
      continue;
    }
    let hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    if (minute > 59) {
      continue;
    }
    if (meridiem !== undefined) {
      if (hour < 1 || hour > 12) {
        continue;
      }
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    } else if (hour > 23) {
      continue;
    }
    out.push({ minutes: hour * 60 + minute, meridiem: meridiem !== undefined });
  }
  return out;
}

/** Sum every duration mention ("1 hour 50 minutes", "90 min", "1.5 hrs", "half an hour"). */
function sumDurationMinutes(lower: string): number {
  let total = 0;
  let found = false;
  const hours = /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/g;
  const minutes = /\b(\d+)\s*(?:minutes?|mins?|m)\b/g;
  let m: RegExpExecArray | null;
  while ((m = hours.exec(lower)) !== null) {
    total += Number(m[1]) * 60;
    found = true;
  }
  while ((m = minutes.exec(lower)) !== null) {
    total += Number(m[1]);
    found = true;
  }
  if (/\b(?:half\s+an\s+hour|half\s+hour|half\s+an\s+hr)\b/.test(lower)) {
    total += 30;
    found = true;
  } else if (/\b(?:an|one)\s+hour\b/.test(lower)) {
    total += 60;
    found = true;
  }
  return found ? Math.round(total) : Number.NaN;
}

function matchClock(lower: string): DatetimeArgs | null {
  // Must be a question about a time of day.
  if (!/\b(?:what\s+time|when)\b/.test(lower)) {
    return null;
  }
  const times = parseClockTimes(lower);
  if (times.length !== 1) {
    return null;
  }
  const delta = sumDurationMinutes(lower);
  if (!Number.isFinite(delta) || delta <= 0) {
    return null;
  }
  const subtract = CLOCK_SUBTRACT.test(lower);
  const add = CLOCK_ADD.test(lower);
  // "when should I leave … to arrive" carries both cues; the ask is the verb
  // next to the question word, so prefer that one.
  let sign: 1 | -1 | null = null;
  if (subtract && add) {
    const q = /\b(?:what\s+time|when)\b.*$/.exec(lower)?.[0] ?? "";
    sign = CLOCK_SUBTRACT.test(q) ? -1 : CLOCK_ADD.test(q) ? 1 : null;
  } else if (subtract) {
    sign = -1;
  } else if (add) {
    sign = 1;
  }
  if (sign === null) {
    return null;
  }
  const start = times[0];
  if (start === undefined) {
    return null;
  }
  return { op: "clock", startMinutes: start.minutes, deltaMinutes: sign * delta, meridiem: start.meridiem };
}

function matchDatetime(userText: string): DatetimeArgs | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }
  const text = userText.trim();
  const lower = text.toLowerCase();

  // ── days until <ISO date> ────────────────────────────────────────────────
  // "days until 2026-12-25", "how many days until 2026-12-25"
  const untilMatch =
    /\b(?:how many\s+)?days?\s+(?:until|till|to|before)\s+(\d{4}-\d{2}-\d{2})\b/.exec(lower);
  if (untilMatch?.[1] !== undefined) {
    return { op: "until", target: untilMatch[1] };
  }

  // ── days until <named day> ──────────────────────────────────────────────
  // "days until Christmas", "how many days till new year's eve"
  if (/\b(?:days?|how\s+long)\s+(?:until|till|to|before)\b/.test(lower)) {
    const namedTarget = resolveNamedDayTarget(lower, new Date());
    if (namedTarget !== null) {
      return { op: "until", target: namedTarget };
    }
  }

  // ── offset from today ─────────────────────────────────────────────────────
  // "what day is 90 days from today", "what's the date in 30 days",
  // "90 days from now", "30 days ago"
  const offsetMatch =
    /\b(\d{1,5})\s+days?\s+(from\s+(?:today|now)|ago|in the future|out|later|before(?:\s+today)?)\b/.exec(
      lower
    );
  if (offsetMatch?.[1] !== undefined && offsetMatch[2] !== undefined) {
    const n = Number(offsetMatch[1]);
    const dir = offsetMatch[2];
    const sign = /ago|before/.test(dir) ? -1 : 1;
    if (Number.isFinite(n)) {
      return { op: "offset", days: sign * n };
    }
  }
  // "in 30 days" phrasing ("what's the date in 30 days")
  const inDaysMatch = /\bin\s+(\d{1,5})\s+days?\b/.exec(lower);
  if (inDaysMatch?.[1] !== undefined && /\b(date|day)\b/.test(lower)) {
    const n = Number(inDaysMatch[1]);
    if (Number.isFinite(n)) {
      return { op: "offset", days: n };
    }
  }

  // ── current day-of-week ───────────────────────────────────────────────────
  // "what day is it", "what day of the week is it", "what's today"
  if (
    /\bwhat\s+day\s+(?:of\s+the\s+week\s+)?is\s+it\b/.test(lower) ||
    /\bwhat\s+day\s+is\s+(?:it\s+)?today\b/.test(lower) ||
    /\bwhat'?s?\s+(?:the\s+)?day\s+(?:of\s+the\s+week\s+)?(?:today|is it)\b/.test(lower)
  ) {
    return { op: "current", kind: "dayOfWeek" };
  }

  // ── clock arithmetic ─────────────────────────────────────────────────────
  // "leaves at 2:15pm, takes 1 hour 50 minutes, what time does it arrive"
  const clock = matchClock(lower);
  if (clock !== null) {
    return clock;
  }

  // ── current time ──────────────────────────────────────────────────────────
  // "what time is it", "what's the current time", "what's the time".
  // Requires "the"/"current"/"is it" — a bare `what's … time` matched "what
  // time does it arrive" and answered the wrong question (seen live 2026-08-26).
  if (
    /\bwhat\s+time\s+is\s+it\b/.test(lower) ||
    /\bwhat(?:'s|\s+is)\s+the\s+(?:current\s+)?time\b/.test(lower) ||
    /\bcurrent\s+time\b/.test(lower)
  ) {
    return { op: "current", kind: "time" };
  }

  // ── current date ──────────────────────────────────────────────────────────
  // "what's today's date", "what is the date", "today's date", "what is the date today"
  if (
    /\bwhat'?s?\s+(?:the\s+|today'?s?\s+)?(?:current\s+)?date\b/.test(lower) ||
    /\bwhat\s+is\s+(?:the\s+|today'?s?\s+)?(?:current\s+)?date\b/.test(lower) ||
    /\btoday'?s\s+date\b/.test(lower) ||
    /\bwhat'?s?\s+the\s+date\s+today\b/.test(lower)
  ) {
    return { op: "current", kind: "date" };
  }

  return null;
}

function executeDatetime(args: DatetimeArgs, now: Date = new Date()): EcoToolResult {
  if (args.op === "current") {
    if (args.kind === "date") {
      const display = DATE_FMT.format(now);
      return {
        display: `Today is ${display}.`,
        forModel: `The current date is ${display}. Use this exact date.`,
        ok: true,
      };
    }
    if (args.kind === "time") {
      const display = TIME_FMT.format(now);
      return {
        display: `It's ${display}.`,
        forModel: `The current local time is ${display}. Use this exact time.`,
        ok: true,
      };
    }
    // dayOfWeek
    const day = WEEKDAY_FMT.format(now);
    return {
      display: `It's ${day}.`,
      forModel: `Today is ${day}. Use this exact day of the week.`,
      ok: true,
    };
  }

  if (args.op === "offset") {
    const target = new Date(now);
    target.setDate(target.getDate() + args.days);
    const display = DATE_FMT.format(target);
    const magnitude = Math.abs(args.days);
    const plural = magnitude === 1 ? "" : "s";
    const phrase =
      args.days >= 0
        ? `${String(magnitude)} day${plural} from today`
        : `${String(magnitude)} day${plural} ago`;
    return {
      display: `${phrase} is ${display}.`,
      forModel: `The date ${phrase} is ${display}. Use this exact date.`,
      ok: true,
    };
  }

  if (args.op === "clock") {
    const end = (((args.startMinutes + args.deltaMinutes) % 1440) + 1440) % 1440;
    const startText = formatClock(args.startMinutes, args.meridiem);
    const endText = formatClock(end, args.meridiem);
    const op = args.deltaMinutes < 0 ? "−" : "+";
    const display = `${startText} ${op} ${formatDuration(Math.abs(args.deltaMinutes))} = ${endText}.`;
    return {
      display,
      forModel: `A time calculator already computed the exact answer: ${display} State ${endText} as the answer; repeat it exactly rather than calculating your own.`,
      ok: true,
    };
  }

  // until
  const target = parseIsoDate(args.target);
  if (target === null) {
    return {
      display: `"${args.target}" isn't a valid date.`,
      forModel: `"${args.target}" is not a valid date; do not compute a day count.`,
      ok: false,
    };
  }
  const days = daysBetween(now, target);
  const magnitude = Math.abs(days);
  const plural = magnitude === 1 ? "" : "s";
  // Format the target with the UTC-pinned formatter — parseIsoDate produces
  // UTC-midnight dates, and a local formatter shifts west-of-UTC dates backwards.
  const targetDisplay = DATE_FMT_UTC.format(target);
  let display: string;
  if (days > 0) {
    display = `${String(magnitude)} day${plural} until ${targetDisplay}.`;
  } else if (days < 0) {
    display = `${targetDisplay} was ${String(magnitude)} day${plural} ago.`;
  } else {
    display = `${targetDisplay} is today.`;
  }
  return {
    display,
    // Mirrors the calculator note shape (proven to get exact restatement): the
    // COUNT leads the note. A first draft led with "Today is <date>." and the
    // 1.2B, faced with many numbers, invented its own count in prose ("252"
    // against the tool's 198 — observed live on prod). Today's date stays as a
    // trailing parenthetical so a compound ask ("today's date and days until …")
    // still has both facts, without burying the salient number.
    forModel: `A date calculator already computed the exact answer: ${display} (Today is ${DATE_FMT.format(now)}.) State this result as the answer; repeat the day count exactly rather than calculating your own.`,
    ok: true,
  };
}

/** Render minutes-since-midnight as "4:05 PM", or "7:05" / "0:30" when the user gave no am/pm. */
function formatClock(minutes: number, meridiem: boolean): string {
  const h = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(2, "0");
  if (!meridiem) {
    return `${String(h)}:${mm}`;
  }
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12)}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${String(h)} hour${h === 1 ? "" : "s"}`);
  }
  if (m > 0) {
    parts.push(`${String(m)} minute${m === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

/** Friendly headline framing the date/time question the tool is answering. */
function summarizeDatetime(args: DatetimeArgs): string {
  if (args.op === "current") {
    if (args.kind === "date") {
      return "Today's date";
    }
    if (args.kind === "time") {
      return "Current time";
    }
    return "Today's day of the week";
  }
  if (args.op === "offset") {
    const magnitude = Math.abs(args.days);
    const plural = magnitude === 1 ? "" : "s";
    return args.days >= 0
      ? `${String(magnitude)} day${plural} from today`
      : `${String(magnitude)} day${plural} ago`;
  }
  if (args.op === "clock") {
    return args.deltaMinutes < 0 ? "Time to leave" : "Time it ends";
  }
  return `Days until ${args.target}`;
}

export const datetimeTool: EcoTool<DatetimeArgs> = {
  name: "datetime",
  description:
    "Answer date/time questions: current date/time/day, date offsets, days until a date, start time plus or minus a duration.",
  validate: isDatetimeArgs,
  match: matchDatetime,
  execute: (args) => executeDatetime(args),
  summarize: summarizeDatetime,
};

/** Exported for deterministic tests that inject a fixed `now`. */
export { executeDatetime };
