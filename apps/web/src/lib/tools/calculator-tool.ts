// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { evaluateExpression } from "../calculator";
import type { EcoTool, EcoToolResult } from "./registry";

/** Extracted args for the calculator tool. */
export type CalculatorArgs = {
  /** A normalized expression ready for `expr-eval` (e.g. "17 * 23"). */
  expression: string;
};

function isCalculatorArgs(value: unknown): value is CalculatorArgs {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { expression?: unknown }).expression === "string" &&
    (value as { expression: string }).expression.trim() !== ""
  );
}

/**
 * Map a recognized math function name to its `expr-eval` form. `expr-eval` exposes
 * these directly, so we only need them in the candidacy regex.
 */
const MATH_FUNCTIONS = ["sqrt", "cbrt", "abs", "sin", "cos", "tan", "log", "ln", "exp", "round", "floor", "ceil"] as const;
const MATH_FUNCTION_PATTERN = MATH_FUNCTIONS.join("|");

/**
 * Normalize a free-text arithmetic expression into something `expr-eval` evaluates.
 * Word operators and symbols → ASCII operators; leaves already-valid expressions
 * untouched.
 */
function normalizeExpression(raw: string): string {
  let expr = raw;

  // Word and symbol operators → ASCII.
  expr = expr.replace(/\b(?:times|multiplied by)\b/gi, "*");
  expr = expr.replace(/\b(?:divided by|over)\b/gi, "/");
  expr = expr.replace(/\bplus\b/gi, "+");
  expr = expr.replace(/\b(?:minus|less)\b/gi, "-");
  expr = expr.replace(/[×∗•]/g, "*");
  expr = expr.replace(/[÷]/g, "/");
  expr = expr.replace(/[−–—]/g, "-");

  // "x" / "X" used as a multiplication operator between two numbers ("17 x 23").
  // Only when flanked by digit/paren context so we never touch hex-like words.
  expr = expr.replace(/(\d|\))\s*[xX]\s*(\d|\()/g, "$1*$2");

  // "to the power of" → ^.
  expr = expr.replace(/\b(?:to the power of|raised to(?: the power of)?)\b/gi, "^");

  // Strip thousands separators inside numbers ("1,000" → "1000").
  expr = expr.replace(/(\d),(?=\d{3}\b)/g, "$1");

  return expr.trim();
}

/**
 * Strip a leading natural-language wrapper so "what is 17 x 23" → "17 x 23".
 * Conservative: only removes a known interrogative/imperative lead-in and a
 * trailing "?" / "=" / "equals".
 */
function stripWrapper(text: string): string {
  let s = text.trim();
  s = s.replace(
    /^\s*(?:please\s+)?(?:can you\s+|could you\s+|hey\s+|ok\s+)?(?:what(?:'s| is| are)|whats|calculate|compute|evaluate|solve|how much is|what does|tell me)\s+/i,
    ""
  );
  // Trailing question/equals.
  s = s.replace(/\s*(?:\?|=|equals?|equal to)\s*$/i, "");
  // A currency symbol glued to a number is a unit, not an operand: "18% of $62.50"
  // is the same arithmetic as "18% of 62.50" (the acceptance script's own phrase
  // produced no card until this, s39). Only symbols directly before a digit, so a
  // stray "$" in prose still counts as a non-arithmetic character below.
  s = s.replace(/[$£€]\s*(?=\d)/g, "");
  return s.trim();
}

/**
 * "15% of 240" → "(15/100)*240". Handles the common percentage phrasing the raw
 * `expr-eval` grammar does not understand.
 */
function rewritePercentOf(text: string): string | null {
  const m = /^(-?\d+(?:\.\d+)?)\s*%\s*of\s*(-?\d+(?:\.\d+)?(?:[\s\d.+\-*/()]*)?)\s*$/i.exec(text);
  if (m?.[1] === undefined || m[2] === undefined) {
    return null;
  }
  const pct = m[1];
  const base = m[2].trim();
  return `(${pct}/100)*(${base})`;
}

/**
 * Does this look like a concrete arithmetic expression we should compute?
 *
 * Conservative gate. Requires either:
 *  - at least one digit AND an arithmetic operator (so "17 * 23", "15% of 240"), OR
 *  - a recognized math function applied to a number ("sqrt(144)").
 *
 * Rejects prose like "I calculated my risk" (no operator between numbers) and
 * conceptual asks like "how do I multiply matrices" (no concrete numbers).
 */
function looksArithmetic(normalized: string): boolean {
  // A math function call with a numeric argument.
  const fnCall = new RegExp(`\\b(?:${MATH_FUNCTION_PATTERN})\\s*\\(\\s*-?\\d`, "i");
  if (fnCall.test(normalized)) {
    return true;
  }

  // Must contain at least one digit.
  if (!/\d/.test(normalized)) {
    return false;
  }

  // A binary arithmetic operator that sits between two numeric/paren operands.
  // e.g. "17*23", "12.5 / 4", "(3+4)*2", "2^8".
  const binary = /(?:\d|\))\s*[+\-*/^%]\s*(?:\d|\(|-?\d)/;
  if (binary.test(normalized)) {
    return true;
  }

  return false;
}

/**
 * The expression, once normalized, must consist ONLY of calculator-safe tokens:
 * digits, operators, parens, decimal points, whitespace, and recognized math
 * function names. Any stray letters mean it's prose, not arithmetic — abstain.
 */
function isPureExpression(normalized: string): boolean {
  const withoutFunctions = normalized.replace(
    new RegExp(`\\b(?:${MATH_FUNCTION_PATTERN}|pi|e)\\b`, "gi"),
    ""
  );
  return /^[\s\d+\-*/^%().,]*$/.test(withoutFunctions);
}

/**
 * Peel a leading arithmetic clause when the whole message isn't pure arithmetic.
 *
 * Handles the "math question + trailing directive" class — e.g.
 * "2+2? Reply with the number only." or "2+2=?", where a trailing format
 * instruction (or a stray "=") survives `stripWrapper` because the "?" sits
 * mid-string, not at the end. We take the leading run of calculator-safe tokens
 * and accept it ONLY when the remainder begins at a question/equals boundary, so
 * a fragment is never grabbed from the middle of a sentence ("I have 2+ years"
 * and "2+2 is easy" stay prose). Deliberately narrow: no boundary, no match — a
 * miss is safer than a wrong injection (see registry.ts's over-call note).
 */
function extractLeadingExpression(normalized: string): string | null {
  const lead = /^[\s\d+\-*/^%().,]+/.exec(normalized);
  if (lead === null) {
    return null;
  }

  const remainder = normalized.slice(lead[0].length).trimStart();
  // The arithmetic must be a complete clause: the leftover text starts at a
  // question or equals boundary ("? Reply…", "= ? answer only"), never mid-word.
  if (!/^[?=]/.test(remainder)) {
    return null;
  }

  const expr = lead[0].trim();
  if (!looksArithmetic(expr) || !isPureExpression(expr)) {
    return null;
  }

  return expr;
}

function matchCalculator(userText: string): CalculatorArgs | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }

  const stripped = stripWrapper(userText);

  // Percentage phrasing handled before the pure-expression check (it contains "of").
  const percent = rewritePercentOf(stripped);
  if (percent !== null) {
    return { expression: percent };
  }

  const normalized = normalizeExpression(stripped);

  // Common case: the whole (wrapper-stripped) message is one arithmetic expression.
  if (looksArithmetic(normalized) && isPureExpression(normalized)) {
    return { expression: normalized };
  }

  // Fallback: a math question followed by a trailing directive.
  const leading = extractLeadingExpression(normalized);
  if (leading !== null) {
    return { expression: leading };
  }

  return null;
}

function executeCalculator(args: CalculatorArgs): EcoToolResult {
  const result = evaluateExpression(args.expression);
  const failed = result.startsWith("Error:");

  if (failed) {
    return {
      display: `Couldn't compute "${args.expression}" — ${result.replace(/^Error:\s*/, "")}.`,
      forModel: `The calculator could not evaluate "${args.expression}" (${result}). Do not invent a number; tell the user the expression could not be computed.`,
      ok: false,
    };
  }

  // Guard against non-finite results (Infinity, -Infinity, NaN) that expr-eval
  // stringifies without erroring — e.g. "1/0" → "Infinity", "0/0" → "NaN".
  const numeric = Number(result);
  if (!Number.isFinite(numeric)) {
    return {
      display: `"${args.expression}" doesn't have a finite result.`,
      forModel: `The expression "${args.expression}" evaluated to ${result}, which is not a finite number. Tell the user the expression doesn't produce a meaningful result.`,
      ok: false,
    };
  }

  return {
    display: `${args.expression} = ${result}`,
    // "already done … rather than recalculating" is load-bearing: small models
    // otherwise re-derive the math in prose and contradict the correct result
    // (observed live: tool said 332024, prose "corrected" it to 332,026 — the
    // chat-experience quality audit, RC1).
    forModel: `A calculator already computed the exact answer: ${args.expression} = ${result}. State this result as the answer; the math is already done, so repeat the number exactly rather than recalculating or showing alternative working.`,
    ok: true,
  };
}

/**
 * Friendly headline: the expression with typographic ×/÷ operators, evenly spaced
 * for legibility regardless of how the user spaced their input ("17*23" and
 * "17 * 23" both render "17 × 23"). Cosmetic only — never feeds back into the
 * computed expression, which stays exactly as `match` normalized it.
 */
function summarizeCalculator(args: CalculatorArgs): string {
  return args.expression
    .replace(/\s*\*\s*/g, " × ")
    .replace(/\s*\/\s*/g, " ÷ ")
    .trim();
}

export const calculatorTool: EcoTool<CalculatorArgs> = {
  name: "calculator",
  description: "Evaluate an arithmetic expression (e.g. 17 * 23, 15% of 240, sqrt(144)).",
  validate: isCalculatorArgs,
  match: matchCalculator,
  execute: executeCalculator,
  summarize: summarizeCalculator,
};
