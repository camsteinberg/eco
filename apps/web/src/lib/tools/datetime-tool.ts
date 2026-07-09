// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { EcoTool, EcoToolResult } from "./registry";

/**
 * The datetime tool answers explicit date/time questions deterministically:
 *  - current date / time / day-of-week ("what day is it", "today's date")
 *  - date arithmetic ("what day is 90 days from today")
 *  - days until a date ("days until 2026-12-25", "days until Christmas")
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

export type DatetimeOp = "current" | "offset" | "until";

export type DatetimeArgs =
  | { op: "current"; kind: "date" | "time" | "dayOfWeek" }
  | { op: "offset"; days: number }
  | { op: "until"; target: string };

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

  // ── current time ──────────────────────────────────────────────────────────
  // "what time is it", "what's the current time"
  if (
    /\bwhat\s+time\s+is\s+it\b/.test(lower) ||
    /\bwhat'?s?\s+(?:the\s+)?(?:current\s+)?time\b/.test(lower) ||
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
  return `Days until ${args.target}`;
}

export const datetimeTool: EcoTool<DatetimeArgs> = {
  name: "datetime",
  description:
    "Answer date/time questions: current date/time/day, date offsets, days until a date.",
  validate: isDatetimeArgs,
  match: matchDatetime,
  execute: (args) => executeDatetime(args),
  summarize: summarizeDatetime,
};

/** Exported for deterministic tests that inject a fixed `now`. */
export { executeDatetime };
