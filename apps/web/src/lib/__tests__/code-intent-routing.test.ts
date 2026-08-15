// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The standing net under `CODE_RE`, and the record of what narrowing it cost.
 *
 * WHAT CHANGED. `CODE_RE` was a bare-word list —
 * `debug|bug|stack trace|typescript|javascript|python|react|sql|function|
 * component|api|test|refactor` — half of which are ordinary English words.
 * "whats the function of the pancreas" was a coding task, "my son has a
 * test at school tomorrow" was a coding task, "can you debug why my
 * toddler wont sleep" was a coding task.
 *
 * On 2026-08-15 the constant became three shapes: a fence (always code);
 * unambiguous code-only tokens that fire by themselves; and ambiguous nouns
 * confirmed by a code context signal (a code-domain word or a programming
 * language/framework name) within the same clause. Every ambiguous arm
 * requires a signal the old form did not need, making this a STRICT
 * NARROWING — asserted below, not assumed.
 */

import { describe, expect, it } from "vitest";

import { inferChatIntent } from "../chat-intent";

// ---------------------------------------------------------------------------
// MUST NOT route to code — ordinary English that the old bare-word list
// misrouted. These are the task spec's mandatory exclusions.
// ---------------------------------------------------------------------------

describe("code intent — ordinary English that must not misroute", () => {
  it.each([
    "whats the function of the pancreas",
    "is there a bug going round at the moment",
    "my son has a test at school tomorrow how do i help him revise",
    "how do i test if my smoke alarm works",
    "what are the components of a healthy breakfast",
    "my dog has a bug",
    "should i test the water before swimming",
    "whats the best api for weather",
    "can you debug why my toddler wont sleep",
    "i need to test my patience",
    "i need to buy yarn for knitting",
    "can you compile a list of gift ideas for my mum",
  ])("does not route to code: %s", (text) => {
    expect(inferChatIntent(text)).not.toBe("code");
  });
});

// ---------------------------------------------------------------------------
// MUST route to code — genuine code asks that the narrowing must preserve.
// ---------------------------------------------------------------------------

describe("code intent — genuine code asks that must still route to code", () => {
  it("routes a fenced code block to code", () => {
    expect(inferChatIntent("```js\nconsole.log('hello');\n```")).toBe("code");
  });

  it("routes 'how do i write a function in python' to code", () => {
    expect(inferChatIntent("how do i write a function in python")).toBe("code");
  });

  it("routes 'debug this stack trace' to code", () => {
    expect(inferChatIntent("debug this stack trace")).toBe("code");
  });

  it("routes 'refactor this component' to code", () => {
    expect(inferChatIntent("refactor this component")).toBe("code");
  });

  it("routes 'fix this sql query' to code", () => {
    expect(inferChatIntent("fix this sql query")).toBe("code");
  });

  it("routes 'why does my react component keep re-rendering' to code", () => {
    expect(inferChatIntent("why does my react component keep re-rendering")).toBe("code");
  });

  it("routes 'write a regex for validating emails' to code", () => {
    expect(inferChatIntent("write a regex for validating emails")).toBe("code");
  });

  it("routes 'there is a bug in my code' to code", () => {
    expect(inferChatIntent("there is a bug in my code")).toBe("code");
  });

  it("routes 'my python script throws a TypeError' to code", () => {
    expect(inferChatIntent("my python script throws a TypeError")).toBe("code");
  });

  it("routes 'how do i center a div in css' to code", () => {
    expect(inferChatIntent("how do i center a div in css")).toBe("code");
  });
});

// ---------------------------------------------------------------------------
// Additional coverage — unambiguous tokens fire by themselves
// ---------------------------------------------------------------------------

describe("code intent — unambiguous tokens fire without a context signal", () => {
  it.each([
    "what does this stack trace mean",
    "i got a traceback in my terminal",
    "how do i refactor this",
    "whats the difference between typescript and javascript",
    "write me a regex for phone numbers",
    "explain this sql statement",
    "npm install is failing",
    "pnpm add lodash",
    "how do i use css grid",
    "write me some html for a form",
    "git commit -m fix",
    "what is a segfault",
    "i have a syntax error",
    "whats a runtime error",
  ])("routes to code: %s", (text) => {
    expect(inferChatIntent(text)).toBe("code");
  });
});

// ---------------------------------------------------------------------------
// Additional coverage — ambiguous tokens need a code context signal
// ---------------------------------------------------------------------------

describe("code intent — ambiguous tokens confirmed by code context signals", () => {
  it.each([
    ["how do i test my code", "test + code"],
    ["there is a bug in my program", "bug + program"],
    ["how do i import this in my script", "import + script"],
    ["i have an api endpoint that returns 500", "api + endpoint"],
    ["the function throws an error", "function + error"],
    ["i need to debug this python issue", "debug + python"],
    ["my react hook is not working", "react + hook"],
    ["write a component in react", "component + react"],
    ["how do i query the api endpoint", "query + endpoint"],
    ["what is a class in python", "class + python"],
    ["run the yarn build script", "yarn + script"],
    ["compile my code and show the errors", "compile + code"],
  ] as const)("routes to code: %s (%s)", (text, _signal) => {
    expect(inferChatIntent(text)).toBe("code");
  });
});

// ---------------------------------------------------------------------------
// Ambiguous tokens ALONE do not fire (the narrowing property)
// ---------------------------------------------------------------------------

describe("code intent — ambiguous tokens alone fall through to the shape classifier", () => {
  it.each([
    "help me debug my sleep schedule",
    "whats the best method for losing weight",
    "i need a new hook for my coat",
    "what class is that car",
    "the variable weather is annoying",
    "i love the loop trail downtown",
    "who can i import goods from",
    "my query is about my phone bill",
  ])("does not route to code: %s", (text) => {
    expect(inferChatIntent(text)).not.toBe("code");
  });
});
