// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import {
  detectTool as detectFrom,
  type AnyEcoTool,
  type ToolMatchContext,
} from "../registry";
import {
  detectTool,
  detectToolFrom,
  DEFAULT_TOOLS,
  DEFAULT_TOOL_REGISTRY,
  calculatorTool,
  datetimeTool,
  unitTool,
  wikipediaGroundingTool,
} from "../index";

/** A tool whose `match` records the context it was handed (and always abstains). */
function makeSpyTool(record: (context?: ToolMatchContext) => void): AnyEcoTool {
  return {
    name: "spy",
    description: "records the match context",
    validate: (): boolean => true,
    match: (_userText: string, context?: ToolMatchContext) => {
      record(context);
      return null;
    },
    execute: () => ({ display: "", forModel: "", ok: true }),
  };
}

describe("detectTool — routes to the correct tool", () => {
  it("routes arithmetic to the calculator", () => {
    const hit = detectTool("what is 17 x 23");
    expect(hit).not.toBeNull();
    expect(hit!.tool.name).toBe("calculator");
  });

  it("routes a date question to datetime", () => {
    const hit = detectTool("what day is it");
    expect(hit).not.toBeNull();
    expect(hit!.tool.name).toBe("datetime");
  });

  it("routes a unit conversion to unit-conversion", () => {
    const hit = detectTool("5 miles in km");
    expect(hit).not.toBeNull();
    expect(hit!.tool.name).toBe("unit-conversion");
  });
});

describe("detectTool — abstains (returns null) on no confident match", () => {
  const nonMatches = [
    "",
    "   ",
    "tell me a story about a forest",
    "I had a great day",
    "miles to go before I sleep",
    "I calculated my risk of switching jobs",
    "how are you today",
  ];

  for (const input of nonMatches) {
    it(`abstains on "${input}"`, () => {
      expect(detectTool(input)).toBeNull();
    });
  }
});

describe("detectTool — end-to-end execute of a detected tool", () => {
  it("executes the matched calculator and produces an authoritative answer", async () => {
    const hit = detectTool("what's 17 times 23?");
    expect(hit).not.toBeNull();
    const result = await hit!.tool.execute(hit!.args);
    expect(result.ok).toBe(true);
    expect(result.display).toContain("391");
  });
});

describe("detectTool — first-confident-hit / priority order", () => {
  it("returns the first tool whose match succeeds", () => {
    const calls: string[] = [];
    const wrap = (tool: AnyEcoTool, label: string): AnyEcoTool => ({
      ...tool,
      match: (text: string) => {
        calls.push(label);
        return tool.match(text);
      },
    });
    const ordered = [
      wrap(calculatorTool, "calc"),
      wrap(datetimeTool, "date"),
      wrap(unitTool, "unit"),
    ];
    const hit = detectFrom("what is 2 + 2", ordered);
    expect(hit!.tool.name).toBe("calculator");
    // Stops at the first confident match — does not run later tools.
    expect(calls).toEqual(["calc"]);
  });

  it("falls through to a later tool when earlier tools abstain", () => {
    const hit = detectFrom("5 miles in km", DEFAULT_TOOLS);
    expect(hit!.tool.name).toBe("unit-conversion");
  });
});

describe("DEFAULT_TOOLS / DEFAULT_TOOL_REGISTRY shape", () => {
  it("exposes the shipping tools in priority order (identity FIRST, grounding LAST)", () => {
    // identity sweeps FIRST (Finding G): identity/privacy/"are you <product>?" frames
    // must win before grounding's fuzzy extractor can steal e.g. "ChatGPT". grounding
    // sweeps last: its matcher is broadest/fuzziest, so it must not pre-empt an
    // arithmetic / unit / date frame a more specific tool answers.
    expect(DEFAULT_TOOLS.map((t) => t.name)).toEqual([
      "identity",
      "calculator",
      "datetime",
      "unit-conversion",
      "wikipedia-grounding",
    ]);
  });
  it("keys the registry by tool name", () => {
    expect(DEFAULT_TOOL_REGISTRY.calculator).toBe(calculatorTool);
    expect(DEFAULT_TOOL_REGISTRY.datetime).toBe(datetimeTool);
    expect(DEFAULT_TOOL_REGISTRY["unit-conversion"]).toBe(unitTool);
    expect(DEFAULT_TOOL_REGISTRY["wikipedia-grounding"]).toBe(wikipediaGroundingTool);
  });
  it("every tool exposes the EcoTool contract", () => {
    for (const tool of DEFAULT_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.match).toBe("function");
      expect(typeof tool.execute).toBe("function");
      expect(typeof tool.validate).toBe("function");
    }
  });
  it("every ToolCallBlock-rendering tool provides a friendly summarize() headline", () => {
    // The summary is the ToolCallBlock headline, so it only applies to tools that
    // render a block. `presentation:"host-answer"` (identity — Finding G) renders no
    // block and states its answer verbatim, so it carries no summarize by design.
    for (const tool of DEFAULT_TOOLS) {
      if (tool.presentation === "host-answer") continue;
      expect(typeof tool.summarize).toBe("function");
    }
  });
});

describe("detectTool — forwards match context to each tool's match (chat #7 W2.2)", () => {
  it("passes the context through the registry detectFrom into match", () => {
    const seen: Array<ToolMatchContext | undefined> = [];
    const spy = makeSpyTool((ctx) => seen.push(ctx));
    const context: ToolMatchContext = { lastGroundedTitle: "Eiffel Tower" };

    const hit = detectFrom("anything", [spy], context);
    expect(hit).toBeNull(); // the spy abstains
    expect(seen).toEqual([context]);
  });

  it("passes the context through the barrel detectToolFrom (explicit list)", () => {
    const seen: Array<ToolMatchContext | undefined> = [];
    const spy = makeSpyTool((ctx) => seen.push(ctx));
    const context: ToolMatchContext = { lastGroundedTitle: "Paris" };

    detectToolFrom("anything", [spy], context);
    expect(seen).toEqual([context]);
  });

  it("forwards undefined context to existing two-arg callers (no change)", () => {
    const seen: Array<ToolMatchContext | undefined> = [];
    const spy = makeSpyTool((ctx) => seen.push(ctx));

    detectFrom("anything", [spy]);
    expect(seen).toEqual([undefined]);
  });

  it("the barrel one-arg detectTool still resolves against DEFAULT_TOOLS unchanged", () => {
    // The context-forwarding addition is appended LAST, so the original one-arg
    // call signature keeps working.
    const hit = detectTool("what is 17 x 23");
    expect(hit!.tool.name).toBe("calculator");
  });
});
