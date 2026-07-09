// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { evaluateExpression } from "../calculator";

describe("evaluateExpression (client)", () => {
  it("evaluates basic arithmetic", () => {
    expect(evaluateExpression("2 + 2")).toBe("4");
  });

  it("evaluates multiplication", () => {
    expect(evaluateExpression("3 * 7")).toBe("21");
  });

  it("evaluates sqrt function", () => {
    expect(evaluateExpression("sqrt(25)")).toBe("5");
  });

  it("evaluates sin(PI/2)", () => {
    expect(evaluateExpression("sin(PI / 2)")).toBe("1");
  });

  it("returns error for invalid expression", () => {
    const result = evaluateExpression("bad expression!!!");
    expect(result).toMatch(/^Error:/);
  });

  it("returns error for empty input", () => {
    expect(evaluateExpression("")).toBe("Error: Empty expression");
  });

  it("evaluates power expressions", () => {
    expect(evaluateExpression("2^8")).toBe("256");
  });
});
