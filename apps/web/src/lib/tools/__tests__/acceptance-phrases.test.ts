// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The acceptance script's phrases, run through the same `detectTool` the chat
 * path uses. Unit tests on each matcher test the phrasings we wrote; this table
 * tests the phrasings a person types in the scripted walkthrough, end to end
 * across the whole tool list — so a matcher change that steals or drops one of
 * them fails here, whichever tool it lives in.
 */

import { describe, it, expect } from "vitest";
import { DEFAULT_TOOLS, detectToolFrom } from "../index";

/**
 * The tool list a person gets by default: grounding (the citation tool) is off
 * since R1, and the chat path removes it the same way (`useChat`'s default-off
 * branch). The deterministic tools are what the walkthrough exercises.
 */
const DEFAULT_OFF_TOOLS = DEFAULT_TOOLS.filter((tool) => tool.presentation !== "citation");

function detectTool(input: string) {
  return detectToolFrom(input, DEFAULT_OFF_TOOLS);
}

describe("acceptance phrases — tool cards that must show", () => {
  const cases: { input: string; tool: string; displayContains: string }[] = [
    { input: "What's 18% of $62.50", tool: "calculator", displayContains: "= 11.25" },
  ];

  for (const { input, tool, displayContains } of cases) {
    it(`"${input}" → ${tool} card containing "${displayContains}"`, async () => {
      const hit = detectTool(input);
      expect(hit?.tool.name).toBe(tool);
      if (hit === null) {
        return;
      }
      const result = await hit.tool.execute(hit.args);
      expect(result.ok).toBe(true);
      expect(result.display).toContain(displayContains);
    });
  }
});

describe("acceptance phrases — conversational turns that must NOT fire a tool", () => {
  const cases = [
    "My rent is $1,450 a month and I take home about $3,200.",
    "Groceries run me around $400, and I spend $120 on transit.",
    "What was my rent again?",
    "Can you make that shorter?",
  ];

  for (const input of cases) {
    it(`"${input}" → no tool`, () => {
      expect(detectTool(input)).toBeNull();
    });
  }
});
