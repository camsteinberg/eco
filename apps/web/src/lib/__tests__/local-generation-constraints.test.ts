// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { buildLocalHardConstraintRepair } from "../local-generation-constraints";

describe("local generation hard-constraint repair", () => {
  it("builds a positive vegetarian repair prompt without seeding forbidden terms", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "Give me a complete vegetarian chili recipe for four people.",
      outputText: "Add beans, tomatoes, and chopped chicken, then simmer.",
    });

    expect(repair).toMatchObject({
      reason: "dietary-constraint",
      generationOptions: {
        temperature: 0.2,
        top_p: 0.65,
        repetition_penalty: 1.12,
        no_repeat_ngram_size: 4,
      },
    });
    expect(repair?.systemInstruction).toContain("closed plant-based ingredient set");
    expect(repair?.userPrompt).toContain("strictly vegetarian");
    expect(`${repair?.systemInstruction} ${repair?.userPrompt}`).not.toMatch(/\b(chicken|beef|pork|bacon|meat)\b/i);
  });

  it("does not repair unrelated prompts", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "Say hello.",
      outputText: "Hello there.",
    })).toBeNull();
  });

  it("repairs exact word requests when the draft adds extra text", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "Say only the word OK and stop.",
      outputText: "OK. I hope that helps.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0,
        top_p: 0.5,
        max_new_tokens: 16,
      },
    });
    expect(repair?.userPrompt).toContain("Return exactly: OK");
    expect(repair?.replacementText).toBe("OK");
    expect(repair?.generationOptions).not.toHaveProperty("repetition_penalty");
    expect(repair?.generationOptions).not.toHaveProperty("no_repeat_ngram_size");
  });

  it("preserves requested exact-token casing in the repair prompt", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "Reply with only the word eBay and nothing else.",
      outputText: "eBay is an online marketplace.",
    });

    expect(repair?.userPrompt).toContain("Return exactly: eBay");
    expect(repair?.userPrompt).not.toContain("Return exactly: EBAY");
    expect(repair?.replacementText).toBe("eBay");
  });

  it("prioritizes dietary repair over format-only repair when both are violated", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "No bullets: give me a vegetarian chili recipe.",
      outputText: "- Add chicken.\n- Simmer with beans.",
    });

    expect(repair).toMatchObject({
      reason: "dietary-constraint",
      generationOptions: {
        temperature: 0.2,
        top_p: 0.65,
      },
    });
    expect(repair?.systemInstruction).toContain("hard dietary constraint");
    expect(repair?.userPrompt).toContain("No bullets");
  });

  it("repairs generic one-word requests when the draft answers in a sentence", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "What color is a ripe banana? Reply with one word only.",
      outputText: "A ripe banana is yellow.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0,
        top_p: 0.5,
        max_new_tokens: 8,
      },
    });
    expect(repair?.userPrompt).toContain("exactly one word");
    expect(repair?.generationOptions).not.toHaveProperty("repetition_penalty");
    expect(repair?.generationOptions).not.toHaveProperty("no_repeat_ngram_size");
  });

  it("repairs exactly-one-word phrasing used by the felt probe", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "answer with exactly one word: what color is a ripe banana?",
      outputText: "A ripe banana is yellow.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0,
        top_p: 0.5,
        max_new_tokens: 8,
      },
    });
    expect(repair?.userPrompt).toContain("Regenerate as exactly one word");
  });

  it("repairs one-sentence requests when the draft has multiple sentences", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "Answer in exactly one sentence: why is the sky blue?",
      outputText: "The sky looks blue because air scatters blue light more than red light. This is called Rayleigh scattering.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 64,
      },
    });
    expect(repair?.systemInstruction).toContain("one sentence");
  });

  it("repairs one warm sentence requests when the draft adds bullets", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "In one warm sentence, explain why leaves are green.",
      outputText: "Leaves are green because of chlorophyll.\n\n- It absorbs light.\n- It helps photosynthesis.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 64,
      },
    });
    expect(repair?.systemInstruction).toContain("one sentence");
  });

  it("repairs one-sentence requests when the draft uses multiple bare lines", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "In one warm sentence, explain why leaves are green.",
      outputText: "Leaves are green because of chlorophyll\nIt helps plants make food",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 64,
      },
    });
  });

  it("does not treat one or two sentences as a one-sentence constraint", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "Give one or two sentences about leaves.",
      outputText: "Leaves are green because of chlorophyll. Photosynthesis uses light.",
    })).toBeNull();
  });

  it("repairs no-bullet requests when the draft uses bullets", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "No bullets: explain why sleep matters in two short sentences.",
      outputText: "- Sleep helps memory.\n- Sleep supports mood.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.15,
        top_p: 0.6,
        max_new_tokens: 96,
      },
    });
    expect(repair?.systemInstruction).toContain("Do not use bullets");
  });

  it("repairs no-bullet requests when the draft uses bullet glyph lines", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "No bullets: explain why sleep matters in two short sentences.",
      outputText: "• Sleep helps memory.\n• Sleep supports mood.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.15,
        top_p: 0.6,
        max_new_tokens: 96,
      },
    });
  });

  it("repairs exact bullet-line requests when the draft adds a preface", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "give exactly three short bullet lines: how can i get better at public speaking",
      outputText:
        "Here are three short tips to help you get better at public speaking:\n\n*   **Practice, Practice, Practice:** Rehearse your speech out loud multiple times.\n*   **Know Your Audience:** Tailor your content and tone to what your listeners need.\n*   **Focus on Connection, Not Perfection:** Concentrate on engaging your audience.",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 80,
      },
    });
    expect(repair?.systemInstruction).toContain("exactly 3 non-empty lines");
    expect(repair?.systemInstruction).toContain("No title, preface, explanation, or closing note");
  });

  it("does not repair exact bullet-line requests that already obey the shape", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "give exactly three short bullet lines: how can i get better at public speaking",
      outputText: "- Practice aloud daily.\n- Record and review yourself.\n- Ask trusted people for feedback.",
    })).toBeNull();
  });

  it("does not repair exact bullet-line requests that use bullet glyphs", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "give exactly three short bullet lines: how can i get better at public speaking",
      outputText: "• Practice aloud daily.\n• Record and review yourself.\n• Ask trusted people for feedback.",
    })).toBeNull();
  });

  it("repairs code-block-only requests when the draft adds prose", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt:
        "Reply with only a TypeScript code block that exports a function clamp(value: number, min: number, max: number): number.",
      outputText:
        "Here is the function:\n\n```ts\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n```",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 192,
      },
    });
    expect(repair?.systemInstruction).toContain("exactly one fenced code block");
    expect(repair?.userPrompt).toContain("Regenerate as exactly one fenced code block");
  });

  it("repairs code-block-only requests when the draft omits the fence", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "Return only a Python code block that prints hello.",
      outputText: "print('hello')",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 192,
      },
    });
  });

  it("repairs trailing code-block-only phrasing", () => {
    const repair = buildLocalHardConstraintRepair({
      userPrompt: "Give me a TypeScript code block only that exports a constant.",
      outputText: "Sure:\n\n```ts\nexport const value = 1;\n```",
    });

    expect(repair).toMatchObject({
      reason: "concise-format",
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 192,
      },
    });
  });

  it("repairs only-with code-block phrasing", () => {
    const cases = [
      "Reply only with a TypeScript code block that exports a constant.",
      "Return only with a Python code block that prints hello.",
      "Answer only with a fenced code block.",
      "Respond only with a markdown code block.",
    ];

    for (const userPrompt of cases) {
      const repair = buildLocalHardConstraintRepair({
        userPrompt,
        outputText: "Sure:\n\n```ts\nexport const value = 1;\n```",
      });

      expect(repair, userPrompt).toMatchObject({
        reason: "concise-format",
        generationOptions: {
          temperature: 0.1,
          top_p: 0.55,
          max_new_tokens: 192,
        },
      });
    }
  });

  it("does not treat unrelated only-with requests as code-block-only constraints", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "Reply only with a short answer.",
      outputText: "A short answer.",
    })).toBeNull();
  });

  it("does not repair code-block-only requests that already obey the shape", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "Reply with only a TypeScript code block that exports a constant.",
      outputText: "```ts\nexport const value = 1;\n```",
    })).toBeNull();
  });

  it("does not repair exact word requests that already obey the constraint", () => {
    expect(buildLocalHardConstraintRepair({
      userPrompt: "Reply with only the word READY and nothing else.",
      outputText: "READY",
    })).toBeNull();
  });
});
