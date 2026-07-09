// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Parser } from "expr-eval";

const parser = new Parser();

/**
 * Safely evaluate a math expression using expr-eval, not JavaScript execution.
 * Returns the stringified result, or an error message on failure.
 */
export function evaluateExpression(expression: string): string {
  if (!expression || expression.trim() === "") {
    return "Error: Empty expression";
  }

  try {
    const result = parser.evaluate(expression);
    return String(result);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : "Invalid expression"}`;
  }
}
