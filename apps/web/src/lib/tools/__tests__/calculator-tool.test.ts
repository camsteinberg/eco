// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { calculatorTool } from "../calculator-tool";

const { match, execute, validate } = calculatorTool;

describe("calculatorTool.match — true positives (must match + correct execute)", () => {
  const cases: Array<{ input: string; expectedResult: string }> = [
    { input: "17*23", expectedResult: "391" },
    { input: "17 times 23", expectedResult: "391" },
    { input: "what is 17 x 23", expectedResult: "391" },
    { input: "what's 17 × 23?", expectedResult: "391" },
    { input: "15% of 240", expectedResult: "36" },
    { input: "sqrt(144)", expectedResult: "12" },
    { input: "(3+4)*2", expectedResult: "14" },
    { input: "12.5 / 4", expectedResult: "3.125" },
    { input: "12.5 divided by 4", expectedResult: "3.125" },
    { input: "100 plus 250", expectedResult: "350" },
    { input: "1,000 + 2,000", expectedResult: "3000" },
    { input: "calculate 2^8", expectedResult: "256" },
    { input: "what is 9 minus 4", expectedResult: "5" },
    { input: "compute (10 - 3) * 5", expectedResult: "35" },
  ];

  for (const { input, expectedResult } of cases) {
    it(`matches and computes "${input}" → ${expectedResult}`, async () => {
      const args = match(input);
      expect(args).not.toBeNull();
      const result = await execute(args!);
      expect(result.ok).toBe(true);
      expect(result.display).toContain(`= ${expectedResult}`);
    });
  }
});

describe("calculatorTool.match — arithmetic question with a trailing directive", () => {
  // Field regression (prod, 2026-07-03): "What is 2+2? Reply with the number only."
  // did NOT trigger the calculator. Root cause: the trailing format instruction
  // ("? Reply with the number only.") survives stripWrapper (the "?" is mid-string,
  // not at the end), so isPureExpression rejects the whole string on its letters.
  // The fix peels the leading arithmetic clause when the remainder begins at a
  // question/equals boundary (prompt-persona quality pass).
  const cases: Array<{ input: string; expectedResult: string }> = [
    { input: "What is 2+2? Reply with the number only.", expectedResult: "4" },
    { input: "What is 17*24?", expectedResult: "408" },
    { input: "What is 17*24? Just the number.", expectedResult: "408" },
    { input: "2+2=?", expectedResult: "4" },
    { input: "17 * 24 = ? answer only", expectedResult: "408" },
    { input: "what's 2+2", expectedResult: "4" },
    { input: "what's 2+2?", expectedResult: "4" },
  ];

  for (const { input, expectedResult } of cases) {
    it(`matches and computes "${input}" → ${expectedResult}`, async () => {
      const args = match(input);
      expect(args).not.toBeNull();
      const result = await execute(args!);
      expect(result.ok).toBe(true);
      expect(result.display).toContain(`= ${expectedResult}`);
    });
  }
});

describe("calculatorTool.match — false-positive guard (must NOT match)", () => {
  const nonMatches: string[] = [
    // Trigger words, no concrete arithmetic.
    "I calculated my risk of switching jobs",
    "what's the best calculator app",
    "how do I multiply matrices",
    "I need to compute my taxes this year",
    "can you help me solve a relationship problem",
    "what does the number 7 symbolize",
    "tell me about the history of mathematics",
    "I have 3 cats and 2 dogs",
    "the meeting is at 3 with 4 people",
    "summarize chapter 5 of the book",
    "what is the meaning of life",
    "explain how addition works",
    // Leading-clause extraction must not grab a fragment from mid-sentence prose.
    "I have 2+ years of experience",
    "2+2 is easy, right",
    "let's meet on 2026-07-03 to review",
    "I'm running version 1.2.3 of the app",
    "chapter 2-4 covers the basics",
  ];

  for (const input of nonMatches) {
    it(`abstains on "${input}"`, () => {
      expect(match(input)).toBeNull();
    });
  }
});

describe("calculatorTool.match — abstention on empty/garbage input", () => {
  it("returns null for empty string", () => {
    expect(match("")).toBeNull();
  });
  it("returns null for whitespace", () => {
    expect(match("   ")).toBeNull();
  });
  it("returns null for pure prose", () => {
    expect(match("hello there how are you today")).toBeNull();
  });
});

describe("calculatorTool.execute — error handling (returns error result, never throws)", () => {
  it("returns an error result for a malformed expression", async () => {
    // match wouldn't produce this; we feed it directly to prove no throw.
    const result = await execute({ expression: "5 + + *" });
    expect(result.ok).toBe(false);
    expect(result.display).toContain("Couldn't compute");
  });

  it("returns an error result for an empty expression", async () => {
    const result = await execute({ expression: "" });
    expect(result.ok).toBe(false);
  });
});

describe("calculatorTool.execute — non-finite results return ok:false", () => {
  // REGRESSION: evaluateExpression (expr-eval) stringifies Infinity/NaN without
  // erroring. The old code returned ok:true + forModel "use this exact value" for
  // "1/0 = Infinity" and "0/0 = NaN". The fix checks Number.isFinite on the
  // parsed result and returns ok:false with an explanatory message.

  it("1/0 → Infinity is rejected as non-finite", async () => {
    const args = match("1/0");
    expect(args).not.toBeNull();
    const result = await execute(args!);
    expect(result.ok).toBe(false);
    expect(result.display).toContain("doesn't have a finite result");
  });

  it("0/0 → NaN is rejected as non-finite", async () => {
    const args = match("0/0");
    expect(args).not.toBeNull();
    const result = await execute(args!);
    expect(result.ok).toBe(false);
    expect(result.display).toContain("doesn't have a finite result");
  });

  it("sqrt(-1) → NaN is rejected as non-finite", async () => {
    const result = await execute({ expression: "sqrt(-1)" });
    expect(result.ok).toBe(false);
    expect(result.display).toContain("doesn't have a finite result");
  });

  it("finite results still return ok:true", async () => {
    const result = await execute({ expression: "100 / 3" });
    expect(result.ok).toBe(true);
    expect(result.display).toContain("=");
  });
});

describe("calculatorTool.validate", () => {
  it("accepts a well-formed args object", () => {
    expect(validate({ expression: "2+2" })).toBe(true);
  });
  it("rejects non-string expression", () => {
    expect(validate({ expression: 42 })).toBe(false);
  });
  it("rejects empty expression", () => {
    expect(validate({ expression: "   " })).toBe(false);
  });
  it("rejects null / non-object", () => {
    expect(validate(null)).toBe(false);
    expect(validate("2+2")).toBe(false);
  });
});

describe("calculatorTool — authoritative display formatting", () => {
  it("renders the expression and result", async () => {
    const args = match("17*23");
    const result = await execute(args!);
    expect(result.display).toBe("17*23 = 391");
  });
  it("forModel instructs the model to use the exact value", async () => {
    const args = match("17*23");
    const result = await execute(args!);
    expect(result.forModel).toContain("391");
    expect(result.forModel.toLowerCase()).toContain("exact");
  });
});

describe("calculatorTool.summarize — friendly headline", () => {
  it("renders ASCII operators with evenly-spaced typographic symbols", () => {
    expect(calculatorTool.summarize?.({ expression: "17 * 23" })).toBe("17 × 23");
    expect(calculatorTool.summarize?.({ expression: "12.5 / 4" })).toBe("12.5 ÷ 4");
  });

  it("normalizes operator spacing regardless of input spacing", () => {
    // Both the spaced and unspaced forms render the same legible headline.
    expect(calculatorTool.summarize?.({ expression: "17*23" })).toBe("17 × 23");
    expect(calculatorTool.summarize?.({ expression: "17 * 23" })).toBe("17 × 23");
  });

  it("leaves +/- and parens untouched", () => {
    expect(calculatorTool.summarize?.({ expression: "(10 - 3) + 5" })).toBe("(10 - 3) + 5");
  });

  it("derives from the matched expression, not the raw user text", () => {
    const args = match("what is 17 x 23")!;
    expect(calculatorTool.summarize?.(args)).toBe("17 × 23");
  });
});
