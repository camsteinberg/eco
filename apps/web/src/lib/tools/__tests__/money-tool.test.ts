// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Contract tests for the money tool (s20).
 *
 * The verbatim turns come from the s19 quality-sampling instrument (scenario B,
 * id `money`) — the run in which both on-device models applied a 24% APR as a
 * MONTHLY rate. Keeping the strings verbatim is the point: these are the exact
 * asks the tool has to take away from the model.
 */

import { describe, it, expect } from "vitest";
import { moneyTool, executeMoney, simulatePayoff, type MoneyArgs } from "../money-tool";

const { match } = moneyTool;

// ── Scenario B, verbatim ────────────────────────────────────────────────────
const B1 = "What's the difference between a debit card and a credit card? Keep it simple.";
const B2 = "My credit card says 24% APR. What does that actually mean for me?";
const B3 =
  "If I owe $600 on it and pay $100 a month, roughly how long until it's paid off? Does the interest change that much?";
const B4 =
  "Write a short email to my bank asking them to lower my interest rate. I've been a customer for 6 years and never missed a payment.";
const B6 = "What is a credit score, and what actually makes it go up or down?";
const B7 = "Is it bad to close an old credit card I don't use anymore?";
const B8 = "Explain compound interest with one small example.";
const B10 = "Give me three habits to keep my finances healthy. One line each.";

describe("moneyTool.match — aprMeaning", () => {
  it("matches B2 verbatim", () => {
    expect(match(B2)).toEqual<MoneyArgs>({ op: "aprMeaning", aprPercent: 24 });
  });
});

describe("moneyTool.match — payoff", () => {
  it("matches B3 verbatim with a context APR", () => {
    expect(match(B3, { recentAprPercent: 24 })).toEqual<MoneyArgs>({
      op: "payoff",
      balance: 600,
      monthlyPayment: 100,
      aprPercent: 24,
      aprFromContext: true,
    });
  });

  it("abstains on B3 verbatim with no context APR (never guesses a rate)", () => {
    expect(match(B3)).toBeNull();
  });

  it("takes the APR from the turn when it is stated inline, even if context differs", () => {
    const turn =
      "I owe $2,000 on my card at 19.99% APR and pay $150 a month — how long until it's paid off?";
    expect(match(turn, { recentAprPercent: 24 })).toEqual<MoneyArgs>({
      op: "payoff",
      balance: 2000,
      monthlyPayment: 150,
      aprPercent: 19.99,
      aprFromContext: false,
    });
  });
});

describe("moneyTool.match — compoundExample", () => {
  it("matches B8 verbatim", () => {
    expect(match(B8)).toEqual<MoneyArgs>({ op: "compoundExample" });
  });
});

describe("moneyTool.match — abstains", () => {
  it("abstains on B1 (debit vs credit)", () => {
    expect(match(B1)).toBeNull();
  });
  it("abstains on B4 (transform ask that mentions an interest rate)", () => {
    expect(match(B4)).toBeNull();
  });
  it("abstains on B7 (closing an old card)", () => {
    expect(match(B7)).toBeNull();
  });
  it("abstains on B6 (what is a credit score)", () => {
    expect(match(B6)).toBeNull();
  });
  it("abstains on B10 (three habits)", () => {
    expect(match(B10)).toBeNull();
  });
  it("abstains on a statement with no question", () => {
    expect(match("my mortgage is 6% APR")).toBeNull();
  });
  it("abstains when no rate is present", () => {
    expect(match("what does APR stand for")).toBeNull();
  });
  it("abstains when a context APR would have to be inherited by an unrelated debt", () => {
    expect(
      match("I owe my friend $600 and pay him $100 a month, how long until it's paid off?", {
        recentAprPercent: 24,
      }),
    ).toBeNull();
  });
});

describe("moneyTool.match — sanity bounds", () => {
  it("abstains on a 0% rate", () => {
    expect(match("my card says 0% APR, what does that mean for me")).toBeNull();
  });
  it("abstains on a rate above 100%", () => {
    expect(match("my card says 400% APR, what does that mean for me")).toBeNull();
  });
});

describe("moneyTool.execute — payoff", () => {
  it("computes the reference case: $600 at 24% APR, $100/month", () => {
    const sim = simulatePayoff(600, 100, 24);
    expect(sim.neverShrinks).toBe(false);
    expect(sim.months).toBe(7);
    expect(sim.totalInterest).toBeCloseTo(45.78, 2);

    const result = executeMoney({
      op: "payoff",
      balance: 600,
      monthlyPayment: 100,
      aprPercent: 24,
      aprFromContext: true,
    });
    expect(result.ok).toBe(true);
    expect(result.display).toContain("7");
    expect(result.display).toContain("$46");
  });

  it("is honest when the payment cannot beat the monthly interest", () => {
    const result = executeMoney({
      op: "payoff",
      balance: 10000,
      monthlyPayment: 150,
      aprPercent: 24,
      aprFromContext: false,
    });
    expect(result.ok).toBe(true);
    expect(result.display).toContain("never shrinks");
    expect(result.display).toContain("$200");
  });
});

describe("moneyTool.execute — aprMeaning", () => {
  it("states the monthly rate and that paying in full costs nothing", () => {
    const result = executeMoney({ op: "aprMeaning", aprPercent: 24 });
    expect(result.ok).toBe(true);
    expect(result.display).toContain("2%");
    expect(result.display).toContain("no interest");
  });

  it("rounds a fractional monthly rate to one decimal", () => {
    expect(executeMoney({ op: "aprMeaning", aprPercent: 19.99 }).display).toContain("1.7");
  });
});

describe("moneyTool.execute — compoundExample", () => {
  it("gives the fixed worked example with exact arithmetic", () => {
    const result = executeMoney({ op: "compoundExample" });
    expect(result.ok).toBe(true);
    expect(result.display).toContain("$110");
    expect(result.display).toContain("$121");
  });
});

describe("moneyTool contract", () => {
  it("renders a ToolCallBlock (canonical answer) and summarizes each op", () => {
    expect(moneyTool.presentation).toBeUndefined();
    expect(moneyTool.summarize?.({ op: "aprMeaning", aprPercent: 24 })).toContain("24");
    expect(
      moneyTool.summarize?.({
        op: "payoff",
        balance: 600,
        monthlyPayment: 100,
        aprPercent: 24,
        aprFromContext: true,
      }),
    ).toContain("$600");
    expect(moneyTool.summarize?.({ op: "compoundExample" })).toMatch(/compound/i);
  });

  it("validates its own extracted args and rejects foreign shapes", () => {
    expect(moneyTool.validate({ op: "aprMeaning", aprPercent: 24 })).toBe(true);
    expect(moneyTool.validate({ op: "payoff", balance: 600 })).toBe(false);
    expect(moneyTool.validate({ expression: "2+2" })).toBe(false);
    expect(moneyTool.validate(null)).toBe(false);
  });
});
