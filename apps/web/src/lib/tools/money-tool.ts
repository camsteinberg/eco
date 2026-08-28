// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { EcoTool, EcoToolResult, ToolMatchContext } from "./registry";

/**
 * The money tool answers a narrow set of consumer-credit questions
 * deterministically:
 *  - what a stated APR means month to month ("24% APR — what does that mean?")
 *  - how long a balance takes to clear at a fixed monthly payment
 *  - a fixed worked example of compound interest
 *
 * Pure TS, no deps. It exists for the same reason the datetime tool's clock
 * arithmetic does: the on-device models get this class of question
 * catastrophically wrong. In the s19 quality sampling BOTH shipping models applied
 * a 24% APR as a MONTHLY rate — "$144 of interest in month one on $600", a balance
 * that grew while the user paid $100/month, and "roughly $480–500 of total
 * interest" against a true $45.78 (~12× wrong). The same error recurred in a
 * compound-interest example. Money advice that wrong is worse than no answer, so
 * the host computes it and the model never sees the question.
 *
 * `match` is conservative to the point of being stingy — a missing piece abstains
 * rather than guessing, because a wrong balance or rate produces a confident,
 * plausible, wrong number.
 */

export type MoneyArgs =
  | { op: "aprMeaning"; aprPercent: number }
  | {
      op: "payoff";
      balance: number;
      monthlyPayment: number;
      aprPercent: number;
      /** True when the rate came from `ToolMatchContext.recentAprPercent`, not this turn. */
      aprFromContext: boolean;
    }
  | { op: "compoundExample" };

/** Rates outside this range are a typo or a rhetorical flourish, not an input. */
function isSaneRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
}

function isSaneAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isMoneyArgs(value: unknown): value is MoneyArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v.op === "aprMeaning") {
    return isSaneRate(v.aprPercent);
  }
  if (v.op === "payoff") {
    return (
      isSaneAmount(v.balance) &&
      isSaneAmount(v.monthlyPayment) &&
      isSaneRate(v.aprPercent) &&
      typeof v.aprFromContext === "boolean"
    );
  }
  return v.op === "compoundExample";
}

// ── Extraction ───────────────────────────────────────────────────────────────

/** A currency amount, with or without a `$` and with optional thousands commas. */
const AMOUNT = String.raw`\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;

function toAmount(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw.replace(/,/g, ""));
  return isSaneAmount(n) ? n : null;
}

/**
 * The APR the user stated in `text` ("24% APR", "APR of 24%", "APR is 24%", "at
 * 19.99% APR"), or null. The LAST mention wins — in a turn that revises itself
 * the most recent figure is the operative one.
 *
 * Exported so the host's conversation-context derivation reads rates by exactly
 * the same rule the tool does (see `hooks/useChat/money-context.ts`).
 */
export function extractAprPercent(text: string): number | null {
  const patterns = [
    /(\d+(?:\.\d+)?)\s*%\s*apr\b/gi,
    /\bapr\s+(?:of|is|at|=)\s*(\d+(?:\.\d+)?)\s*%/gi,
  ];
  let found: number | null = null;
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const n = Number(m[1]);
      if (isSaneRate(n)) {
        found = n;
      }
    }
  }
  return found;
}

/** "I owe $600", "owing $600", "a balance of $600", "$600 balance/debt". */
function extractBalance(lower: string): number | null {
  const patterns = [
    new RegExp(String.raw`\bow(?:e|ing)\s+(?:about\s+|around\s+|roughly\s+)?${AMOUNT}`),
    new RegExp(String.raw`\bbalance\s+of\s+${AMOUNT}`),
    new RegExp(String.raw`${AMOUNT}\s+(?:balance|debt)\b`),
  ];
  for (const pattern of patterns) {
    const m = pattern.exec(lower);
    const amount = toAmount(m?.[1]);
    if (amount !== null) {
      return amount;
    }
  }
  return null;
}

/**
 * A recurring monthly payment: "$100 a month", "$100/month", "$100 monthly".
 * Keyed on the CADENCE rather than on a "pay" verb so "pay $100 a month" and
 * "pay him $100 a month" read the same.
 */
function extractMonthlyPayment(lower: string): number | null {
  const pattern = new RegExp(
    String.raw`${AMOUNT}\s*(?:/\s*mo(?:nth)?\b|\s+(?:a|per|each|every)\s+month\b|\s+monthly\b)`,
  );
  return toAmount(pattern.exec(lower)?.[1]);
}

/** "what does that actually mean (for me)", "how does that work", "what am I paying". */
const MEANING_QUESTION =
  /\bwhat\s+(?:does|do)\s+(?:that|it|this)\s+(?:actually\s+|really\s+)?mean\b|\bmean\s+for\s+me\b|\bhow\s+does\s+(?:that|it|this)\s+work\b|\bwhat\s+am\s+i\s+(?:actually\s+|really\s+)?paying\b/;

/** "how long until it's paid off", "when will I be paid off", "how many payments". */
const PAYOFF_QUESTION =
  /\bhow\s+long\s+(?:until|till|before|to)\b[^?]*\bpaid?\s+off\b|\bwhen\s+will\s+(?:it|i)\b[^?]*\bpaid\s+off\b|\bhow\s+many\s+(?:months|payments)\b/;

/**
 * Something in the turn that ties the payment to an interest-bearing instrument.
 * Required before a CONTEXT-supplied APR may be used, so "I owe my friend $600"
 * never inherits the rate from a credit card discussed two turns ago.
 */
const DEBT_INSTRUMENT =
  /\bon\s+it\b|\b(?:the|that|my|this)\s+card\b|\bcredit\s+card\b|\b(?:the|my|that)\s+loan\b|\binterest\b/;

const COMPOUND_QUESTION =
  /\b(?:explain|what(?:'s|\s+is)|how\s+does|how\s+do)\b[^?]*\bcompound(?:ing|ed)?\s+interest\b/;

function matchMoney(userText: string, context?: ToolMatchContext): MoneyArgs | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }
  const lower = userText.toLowerCase();
  const turnApr = extractAprPercent(lower);

  // ── what a stated APR means ──────────────────────────────────────────────
  if (turnApr !== null && MEANING_QUESTION.test(lower)) {
    return { op: "aprMeaning", aprPercent: turnApr };
  }

  // ── how long to pay a balance off ────────────────────────────────────────
  if (PAYOFF_QUESTION.test(lower)) {
    const balance = extractBalance(lower);
    const monthlyPayment = extractMonthlyPayment(lower);
    if (balance !== null && monthlyPayment !== null) {
      if (turnApr !== null) {
        return { op: "payoff", balance, monthlyPayment, aprPercent: turnApr, aprFromContext: false };
      }
      const contextApr = context?.recentAprPercent;
      if (isSaneRate(contextApr) && DEBT_INSTRUMENT.test(lower)) {
        return {
          op: "payoff",
          balance,
          monthlyPayment,
          aprPercent: contextApr,
          aprFromContext: true,
        };
      }
    }
    return null;
  }

  // ── compound interest, explained ─────────────────────────────────────────
  if (COMPOUND_QUESTION.test(lower)) {
    return { op: "compoundExample" };
  }

  return null;
}

// ── Computation ──────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Amortization of a fixed monthly payment against a revolving balance. Interest
 * is charged on the balance at the start of each month at `aprPercent / 1200` and
 * rounded to the cent, exactly as a card statement does.
 *
 * `neverShrinks` is the honest outcome for the case where the payment can't beat
 * the interest — reporting a payoff month there would be a lie of arithmetic.
 * The 600-month cap catches the near-miss version of the same situation.
 *
 * @internal Exported for tests that pin the reference case.
 */
export function simulatePayoff(
  balance: number,
  monthlyPayment: number,
  aprPercent: number,
): {
  months: number;
  totalInterest: number;
  finalPayment: number;
  firstMonthInterest: number;
  neverShrinks: boolean;
} {
  const rate = aprPercent / 1200;
  const firstMonthInterest = round2(balance * rate);
  const idle = {
    months: 0,
    totalInterest: 0,
    finalPayment: 0,
    firstMonthInterest,
    neverShrinks: true,
  };
  if (firstMonthInterest >= monthlyPayment) {
    return idle;
  }

  let remaining = balance;
  let totalInterest = 0;
  let months = 0;
  let finalPayment = monthlyPayment;
  while (remaining > 0) {
    if (months >= 600) {
      return idle;
    }
    const interest = round2(remaining * rate);
    totalInterest = round2(totalInterest + interest);
    const due = round2(remaining + interest);
    months += 1;
    if (due <= monthlyPayment) {
      finalPayment = due;
      remaining = 0;
    } else {
      remaining = round2(due - monthlyPayment);
    }
  }
  return { months, totalInterest, finalPayment, firstMonthInterest, neverShrinks: false };
}

/** "$600", "$2,000", "$45.78" — cents shown only when they are non-zero. */
function formatMoney(amount: number): string {
  const rounded = round2(amount);
  const whole = Math.floor(rounded);
  const cents = Math.round((rounded - whole) * 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents === 0 ? `$${grouped}` : `$${grouped}.${String(cents).padStart(2, "0")}`;
}

/** A rate at one decimal, hedged with "about" only when the rounding lost precision. */
function formatRate(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  const text = `${String(rounded)}%`;
  return rounded === value ? text : `about ${text}`;
}

function executeMoney(args: MoneyArgs): EcoToolResult {
  if (args.op === "aprMeaning") {
    const monthly = args.aprPercent / 12;
    const perHundred = formatMoney(monthly);
    const display =
      `${String(args.aprPercent)}% APR is a YEARLY rate, not a monthly one — carried month to month it works out to ` +
      `${formatRate(monthly)} of the balance. On every $100 you still owe, that is roughly ${perHundred} of interest ` +
      `added each month. If you pay the statement balance in full each month, you pay no interest at all.`;
    return {
      display,
      forModel: `A money calculator already worked this out: ${display} State this as the answer; repeat it exactly rather than doing your own rate arithmetic — an APR divided by 12 is the monthly rate.`,
      ok: true,
    };
  }

  if (args.op === "payoff") {
    const sim = simulatePayoff(args.balance, args.monthlyPayment, args.aprPercent);
    if (sim.neverShrinks) {
      const display =
        `At ${formatMoney(args.monthlyPayment)} a month, a ${formatMoney(args.balance)} balance at ` +
        `${String(args.aprPercent)}% APR never shrinks: the interest alone is about ` +
        `${formatMoney(sim.firstMonthInterest)} a month, so the payment has to beat that before the debt can start ` +
        `coming down.`;
      return {
        display,
        forModel: `A money calculator already worked this out: ${display} State this as the answer; do not produce a payoff date — there isn't one at this payment.`,
        ok: true,
      };
    }

    const baseline = Math.ceil(args.balance / args.monthlyPayment);
    const extra = sim.months - baseline;
    const interestClause =
      extra <= 0
        ? "that is the same number of payments it would take with no interest at all, so the interest costs you money but not time"
        : extra === 1
          ? `with no interest it would take ${String(baseline)} payments, so the interest adds one extra payment`
          : `with no interest it would take ${String(baseline)} payments, so the interest adds ${String(extra)} extra payments`;
    const display =
      `Paying ${formatMoney(args.monthlyPayment)} a month against ${formatMoney(args.balance)} at ` +
      `${String(args.aprPercent)}% APR clears it in ${String(sim.months)} monthly payments (the last one is only ` +
      `${formatMoney(sim.finalPayment)}). Total interest: about ${formatMoney(Math.round(sim.totalInterest))}. ` +
      `To your second question — ${interestClause}.`;
    return {
      display,
      forModel: `A money calculator already worked this out: ${display} State these figures as the answer; repeat the number of payments and the total interest exactly rather than computing your own.`,
      ok: true,
    };
  }

  const display =
    "Compound interest is interest charged on interest (on a debt) or earned on interest (on savings). " +
    "Say you have $100 at 10% a year: after year one it is $110. Year two's 10% is applied to $110, not to the " +
    "original $100, so you end year two with $121. That extra $1 is the interest the first year's interest earned.";
  return {
    display,
    forModel: `A money calculator already produced this worked example: ${display} State it as the answer; repeat the figures exactly rather than computing your own.`,
    ok: true,
  };
}

/** Friendly headline framing the money question the tool is answering. */
function summarizeMoney(args: MoneyArgs): string {
  if (args.op === "aprMeaning") {
    return `What ${String(args.aprPercent)}% APR means`;
  }
  if (args.op === "payoff") {
    return `${formatMoney(args.balance)} at ${String(args.aprPercent)}% APR, ${formatMoney(args.monthlyPayment)}/month`;
  }
  return "Compound interest example";
}

export const moneyTool: EcoTool<MoneyArgs> = {
  name: "money",
  description:
    "Answer consumer-credit money questions: what an APR means per month, how long a balance takes to pay off at a fixed payment, and a worked compound-interest example.",
  validate: isMoneyArgs,
  match: matchMoney,
  execute: executeMoney,
  summarize: summarizeMoney,
};

/** Exported for deterministic tests of the canonical display strings. */
export { executeMoney };
