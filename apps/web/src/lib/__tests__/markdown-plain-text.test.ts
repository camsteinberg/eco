// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { stripMarkdown } from "../markdown-plain-text";

describe("stripMarkdown", () => {
  it("strips the heading that started this — the sidebar preview leak", () => {
    expect(stripMarkdown("## Watering a container garden")).toBe(
      "Watering a container garden",
    );
  });

  it("strips headings at every level", () => {
    expect(stripMarkdown("# One")).toBe("One");
    expect(stripMarkdown("###### Six")).toBe("Six");
    // Seven hashes is not a heading in Markdown; leave it alone.
    expect(stripMarkdown("####### Seven")).toBe("####### Seven");
  });

  it("keeps a lone hash that is not a heading", () => {
    expect(stripMarkdown("Issue #42 is fixed")).toBe("Issue #42 is fixed");
    expect(stripMarkdown("#hashtag")).toBe("#hashtag");
  });

  it("unwraps emphasis, strong, both, and strikethrough", () => {
    expect(stripMarkdown("*italic*")).toBe("italic");
    expect(stripMarkdown("_italic_")).toBe("italic");
    expect(stripMarkdown("**bold**")).toBe("bold");
    expect(stripMarkdown("__bold__")).toBe("bold");
    expect(stripMarkdown("***both***")).toBe("both");
    expect(stripMarkdown("~~gone~~")).toBe("gone");
    expect(stripMarkdown("A **bold** claim about *pots*")).toBe(
      "A bold claim about pots",
    );
  });

  it("keeps link and image text, drops the target", () => {
    expect(stripMarkdown("See [the guide](https://example.com/x)")).toBe(
      "See the guide",
    );
    expect(stripMarkdown('![a fern](/fern.png "Fern")')).toBe("a fern");
  });

  it("unwraps inline code and drops code fences", () => {
    expect(stripMarkdown("Run `pnpm qa` first")).toBe("Run pnpm qa first");
    expect(stripMarkdown("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripMarkdown("~~~\nplain\n~~~")).toBe("plain");
  });

  it("drops blockquote markers, including nested ones", () => {
    expect(stripMarkdown("> quoted")).toBe("quoted");
    expect(stripMarkdown(">> deeper")).toBe("deeper");
  });

  it("drops bullet and ordered list markers", () => {
    expect(stripMarkdown("- first\n- second")).toBe("first second");
    expect(stripMarkdown("* star\n+ plus")).toBe("star plus");
    expect(stripMarkdown("1. one\n2) two")).toBe("one two");
    // A hyphen inside a sentence is not a list marker.
    expect(stripMarkdown("well-watered soil")).toBe("well-watered soil");
  });

  it("drops horizontal rules and setext underlines", () => {
    expect(stripMarkdown("Title\n===\n\nBody")).toBe("Title Body");
    expect(stripMarkdown("above\n---\nbelow")).toBe("above below");
    expect(stripMarkdown("above\n***\nbelow")).toBe("above below");
  });

  it("collapses a multi-line answer to a single line", () => {
    const answer = "## Watering\n\nMost herbs want **damp**, not wet:\n\n- check daily\n- water at the base\n";
    expect(stripMarkdown(answer)).toBe(
      "Watering Most herbs want damp, not wet: check daily water at the base",
    );
  });

  it("leaves plain prose untouched", () => {
    expect(stripMarkdown("How often should I water basil?")).toBe(
      "How often should I water basil?",
    );
  });

  it("returns an empty string for empty or syntax-only input", () => {
    expect(stripMarkdown("")).toBe("");
    expect(stripMarkdown("   \n\n  ")).toBe("");
    expect(stripMarkdown("## ")).toBe("");
    expect(stripMarkdown("```\n```")).toBe("");
  });
});
