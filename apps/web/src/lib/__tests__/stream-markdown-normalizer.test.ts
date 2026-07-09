// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from "vitest";
import { normalizeStreamMarkdown } from "../stream-markdown-normalizer";

/** Convenience: normalize a fully-arrived (non-streaming) message. */
function done(text: string): string {
  return normalizeStreamMarkdown(text, { complete: true });
}

/** Convenience: normalize a still-streaming partial buffer. */
function streaming(text: string): string {
  return normalizeStreamMarkdown(text, { complete: false });
}

// ---------------------------------------------------------------------------
// Artifact class 1 — heading discipline
// ---------------------------------------------------------------------------

describe("heading discipline", () => {
  it("inserts a space after a single glued hash", () => {
    expect(done("#Heading")).toBe("# Heading");
  });

  it("inserts a space after two glued hashes", () => {
    expect(done("##Heading")).toBe("## Heading");
  });

  it("handles 1–6 hash levels", () => {
    expect(done("###Three")).toBe("### Three");
    expect(done("######Six")).toBe("###### Six");
  });

  it("leaves an already-spaced heading untouched", () => {
    expect(done("# Heading")).toBe("# Heading");
    expect(done("## Section")).toBe("## Section");
  });

  it("does not treat 7+ hashes as a heading", () => {
    // CommonMark caps headings at 6 hashes; #######x is not a heading.
    expect(done("#######Seven")).toBe("#######Seven");
  });

  it("fixes a glued heading anywhere in the document, line-anchored", () => {
    expect(done("Intro line\n\n##Body title\n\nMore text")).toBe(
      "Intro line\n\n## Body title\n\nMore text",
    );
  });

  it("preserves a glued heading title that contains a space", () => {
    expect(done("#Step 1: begin")).toBe("# Step 1: begin");
  });

  // --- CSS hex-color safety (the carefully-decided carve-out) ---
  it("does NOT rewrite a standalone CSS hex color line", () => {
    expect(done("#fff")).toBe("#fff");
    expect(done("#2d5a3d")).toBe("#2d5a3d");
    expect(done("#aabbcc")).toBe("#aabbcc");
    expect(done("#AABBCCDD")).toBe("#AABBCCDD");
  });

  it("still fixes a heading whose title merely starts with hex-like letters but is prose", () => {
    // "#faces" is not a pure hex run (contains 's') → treated as a heading.
    expect(done("#faces of design")).toBe("# faces of design");
  });

  it("does not touch a hash that is not at line start", () => {
    expect(done("a tag #Heading inline")).toBe("a tag #Heading inline");
  });
});

// ---------------------------------------------------------------------------
// Artifact class 2 — list marker well-formedness
// ---------------------------------------------------------------------------

describe("unordered list markers", () => {
  it("inserts a space after a glued dash bullet", () => {
    expect(done("-item")).toBe("- item");
  });

  it("fixes every glued dash bullet in a run", () => {
    expect(done("-one\n-two\n-three")).toBe("- one\n- two\n- three");
  });

  it("leaves a correct dash bullet untouched", () => {
    expect(done("- item")).toBe("- item");
  });

  it("does NOT touch a thematic break (---)", () => {
    expect(done("---")).toBe("---");
    expect(done("----")).toBe("----");
  });

  it("does NOT touch an arrow-like --> ", () => {
    expect(done("-->go")).toBe("-->go");
  });

  it("preserves leading indentation on a nested bullet", () => {
    expect(done("  -nested")).toBe("  - nested");
  });

  // --- emphasis ambiguity: * and + are deliberately NOT auto-fixed ---
  it("does NOT rewrite a line-start emphasis run as a list", () => {
    // "*note*: ..." must not become "* note*: ..." (would break the emphasis).
    expect(done("*note*: be careful")).toBe("*note*: be careful");
  });

  it("does NOT touch a glued asterisk bullet (scoped out for safety)", () => {
    expect(done("*item")).toBe("*item");
  });

  it("does NOT touch a glued plus bullet (scoped out for safety)", () => {
    expect(done("+item")).toBe("+item");
  });
});

describe("ordered list markers", () => {
  it("inserts a space after a glued ordered marker", () => {
    expect(done("1.item")).toBe("1. item");
  });

  it("handles multi-digit counters", () => {
    expect(done("12.item")).toBe("12. item");
  });

  it("fixes a run of glued ordered items", () => {
    expect(done("1.first\n2.second\n3.third")).toBe(
      "1. first\n2. second\n3. third",
    );
  });

  it("leaves a correct ordered marker untouched", () => {
    expect(done("1. first")).toBe("1. first");
  });

  // --- decimal safety: digit after the dot is never a list marker ---
  it("does NOT rewrite a decimal number at line start", () => {
    expect(done("3.14 is pi")).toBe("3.14 is pi");
    expect(done("1.5 hours later, we left")).toBe("1.5 hours later, we left");
  });

  it("preserves leading indentation on a nested ordered item", () => {
    expect(done("   1.nested")).toBe("   1. nested");
  });
});

// ---------------------------------------------------------------------------
// Artifact class 3 — table well-formedness
// ---------------------------------------------------------------------------

describe("table separator insertion", () => {
  it("inserts a missing separator after a two-row pipe table", () => {
    const input = "| Name | Age |\n| Alice | 30 |";
    expect(done(input)).toBe("| Name | Age |\n| --- | --- |\n| Alice | 30 |");
  });

  it("matches the header column count in the inserted separator", () => {
    const input = "| A | B | C |\n| 1 | 2 | 3 |";
    expect(done(input)).toBe(
      "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |",
    );
  });

  it("leaves a table that already has a separator untouched", () => {
    const input = "| Name | Age |\n| --- | --- |\n| Alice | 30 |";
    expect(done(input)).toBe(input);
  });

  it("does NOT insert a separator for a single pipe row (ambiguous)", () => {
    const input = "value | other";
    expect(done(input)).toBe(input);
  });

  it("recognizes rows by >=2 pipes even without leading/trailing pipes", () => {
    const input = "Name | Age | City\nAlice | 30 | NYC";
    expect(done(input)).toBe(
      "Name | Age | City\n--- | --- | ---\nAlice | 30 | NYC",
    );
  });

  it("does NOT treat a single internal pipe as a table row (ambiguous)", () => {
    // One pipe, no bounding pipes — could be prose ("cmd | grep") → leave alone.
    const input = "Name | Age\nAlice | 30";
    expect(done(input)).toBe(input);
  });

  it("does not corrupt a table inside a code fence", () => {
    const input = "```\n| Name | Age |\n| Alice | 30 |\n```";
    expect(done(input)).toBe(input);
  });

  it("only inserts after the first row of the run", () => {
    const input = "| H1 | H2 |\n| a | b |\n| c | d |";
    expect(done(input)).toBe(
      "| H1 | H2 |\n| --- | --- |\n| a | b |\n| c | d |",
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact class 4 — conservative spacing artifacts
// ---------------------------------------------------------------------------

describe("collapse double spaces between words", () => {
  it("collapses a double space inside a sentence", () => {
    expect(done("hello  world")).toBe("hello world");
  });

  it("collapses runs of 3+ spaces", () => {
    expect(done("a     b")).toBe("a b");
  });

  it("does NOT touch leading indentation", () => {
    expect(done("    indented code-ish line")).toBe("    indented code-ish line");
  });

  it("does NOT touch a trailing hard-break (two trailing spaces)", () => {
    // Markdown hard line break = two trailing spaces; must survive.
    expect(done("line one  \nline two")).toBe("line one  \nline two");
  });
});

describe("punctuation spacing", () => {
  it("removes a space before a comma", () => {
    expect(done("word , word")).toBe("word, word");
  });

  it("removes a space before sentence punctuation", () => {
    expect(done("done . next")).toBe("done. next");
    expect(done("really ? yes")).toBe("really? yes");
    expect(done("wow ! ok")).toBe("wow! ok");
    expect(done("note : here")).toBe("note: here");
    expect(done("a ; b")).toBe("a; b");
  });

  it("does NOT touch an ellipsis", () => {
    expect(done("wait ...")).toBe("wait ...");
  });

  it("does NOT mangle a decimal number with surrounding spaces", () => {
    // Digit-before guard: "5 . 0" stays put rather than becoming "5. 0".
    expect(done("5 . 0")).toBe("5 . 0");
  });
});

// ---------------------------------------------------------------------------
// Hard safety — code fences
// ---------------------------------------------------------------------------

describe("code-fence safety", () => {
  it("never modifies content inside a fenced block", () => {
    const input = "```\n#NotAHeading\n-notalist\nword  ,  word\n```";
    expect(done(input)).toBe(input);
  });

  it("normalizes text outside a fence but not inside", () => {
    const input = "#Title\n\n```\n#Inside\n```\n\n-after";
    expect(done(input)).toBe("# Title\n\n```\n#Inside\n```\n\n- after");
  });

  it("respects tilde fences too", () => {
    const input = "~~~\n#Inside\n~~~";
    expect(done(input)).toBe(input);
  });

  it("treats an unclosed fence's body as opaque", () => {
    const input = "#Title\n```\n#Inside";
    expect(done(input)).toBe("# Title\n```\n#Inside");
  });

  it("does not modify content inside an inline code span", () => {
    expect(done("Use `a  ,  b` literally")).toBe("Use `a  ,  b` literally");
  });

  it("normalizes around an inline code span", () => {
    expect(done("see `code` here , now")).toBe("see `code` here, now");
  });
});

// ---------------------------------------------------------------------------
// Hard safety — math
// ---------------------------------------------------------------------------

describe("math safety", () => {
  it("does not touch inline math content", () => {
    expect(done("the value $a  ,  b$ holds")).toBe("the value $a  ,  b$ holds");
  });

  it("does not touch display math content", () => {
    const input = "$$\nx  =  y , z\n$$";
    expect(done(input)).toBe(input);
  });

  it("normalizes prose around inline math", () => {
    expect(done("before , $x^2$ after")).toBe("before, $x^2$ after");
  });

  it("handles a self-contained $$…$$ on a single line without opening a block", () => {
    // Even number of $$ on the line → inline-handled; following prose still normalizes.
    expect(done("see $$a=b$$ then\n#Title")).toBe("see $$a=b$$ then\n# Title");
  });

  it("does not normalize a glued-looking line inside a multi-line math block", () => {
    const input = "$$\n-x + y\n$$\n\n#After";
    expect(done(input)).toBe("$$\n-x + y\n$$\n\n# After");
  });

  it("does not touch a pipe table that lives inside a math block", () => {
    const input = "$$\n| a | b |\n| c | d |\n$$";
    expect(done(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// Streaming partial-tail safety
// ---------------------------------------------------------------------------

describe("streaming partial-tail safety", () => {
  it("leaves the trailing (unterminated) line untouched while streaming", () => {
    // The last line is still arriving — do not rewrite it.
    expect(streaming("# Title\n\n#Partial")).toBe("# Title\n\n#Partial");
  });

  it("normalizes completed lines even while streaming", () => {
    expect(streaming("#Done\n#StillGoing")).toBe("# Done\n#StillGoing");
  });

  it("does not insert a table separator until the second full row arrives", () => {
    // Header complete, row 2 still streaming as the tail → no separator yet.
    expect(streaming("| H1 | H2 |\n| a | b")).toBe("| H1 | H2 |\n| a | b");
  });

  it("inserts the separator once two complete rows exist mid-stream", () => {
    expect(streaming("| H1 | H2 |\n| a | b |\n")).toBe(
      "| H1 | H2 |\n| --- | --- |\n| a | b |\n",
    );
  });

  it("normalizes the whole text including the last line when complete", () => {
    expect(done("# Title\n\n#Final")).toBe("# Title\n\n# Final");
  });

  it("treats empty input safely", () => {
    expect(done("")).toBe("");
    expect(streaming("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Idempotence — normalize(normalize(x)) === normalize(x) over all fixtures
// ---------------------------------------------------------------------------

const FIXTURES: string[] = [
  "#Heading",
  "##Heading",
  "###### Six",
  "#fff",
  "#2d5a3d",
  "-item",
  "-one\n-two\n-three",
  "---",
  "*note*: careful",
  "1.item",
  "12.item",
  "3.14 is pi",
  "1.5 hours later, we left",
  "| Name | Age |\n| Alice | 30 |",
  "| A | B | C |\n| 1 | 2 | 3 |",
  "Name | Age\nAlice | 30",
  "hello  world",
  "word , word",
  "wait ...",
  "5 . 0",
  "line one  \nline two",
  "```\n#NotAHeading\n-notalist\n```",
  "#Title\n\n```\n#Inside\n```\n\n-after",
  "Use `a  ,  b` literally",
  "the value $a  ,  b$ holds",
  "$$\nx  =  y , z\n$$",
  "see $$a=b$$ then\n#Title",
  "$$\n-x + y\n$$\n\n#After",
  "$$\n| a | b |\n| c | d |\n$$",
  "Plain prose with nothing to fix.",
  "",
  "\n\n\n",
  "| H1 | H2 |\n| a | b |\n| c | d |",
];

describe("idempotence", () => {
  it("normalize(normalize(x)) === normalize(x) for every fixture (complete)", () => {
    for (const fixture of FIXTURES) {
      const once = done(fixture);
      const twice = done(once);
      expect(twice).toBe(once);
    }
  });

  it("normalize(normalize(x)) === normalize(x) for every fixture (streaming)", () => {
    for (const fixture of FIXTURES) {
      const once = streaming(fixture);
      const twice = streaming(once);
      expect(twice).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// Stability under growth — line-complete streamed prefixes stay prefix-consistent
// with the final normalized output.
// ---------------------------------------------------------------------------

describe("stability under growth", () => {
  const STREAM = [
    "#Intro\n",
    "\n",
    "Here is a list:\n",
    "-one\n",
    "-two\n",
    "\n",
    "| Name | Age |\n",
    "| Alice | 30 |\n",
    "| Bob | 25 |\n",
    "\n",
    "Done , finally.\n",
  ];

  it("each line-complete prefix is a prefix of the final normalized output", () => {
    const full = STREAM.join("");
    const finalNormalized = done(full);

    let acc = "";
    for (const chunk of STREAM) {
      acc += chunk;
      // `acc` always ends in \n here → every line is complete.
      const partialNormalized = streaming(acc);
      expect(finalNormalized.startsWith(partialNormalized)).toBe(true);
    }
  });

  it("does not rewrite already-displayed lines as later text arrives", () => {
    // The normalized header line must be identical at every step once emitted.
    const a = streaming("#Intro\n");
    const b = streaming("#Intro\n\nmore text\n");
    expect(b.startsWith(a)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined real-world artifact sample
// ---------------------------------------------------------------------------

describe("combined real-world sample", () => {
  it("cleans a reply mixing several artifact classes", () => {
    const input = [
      "##Summary",
      "",
      "Key points :",
      "-first point",
      "-second  point",
      "",
      "| Metric | Value |",
      "| Speed | fast |",
    ].join("\n");

    const expected = [
      "## Summary",
      "",
      "Key points:",
      "- first point",
      "- second point",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      "| Speed | fast |",
    ].join("\n");

    expect(done(input)).toBe(expected);
  });
});
