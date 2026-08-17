// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export type LocalHardConstraintRepairReason =
  | "dietary-constraint"
  | "concise-format"
  | "conversation-integrity";

export type LocalHardConstraintRepair = {
  reason: LocalHardConstraintRepairReason;
  systemInstruction: string;
  userPrompt: string;
  replacementText?: string;
  generationOptions: {
    temperature: number;
    top_p: number;
    max_new_tokens?: number;
    repetition_penalty?: number;
    no_repeat_ngram_size?: number;
  };
};

const VEGETARIAN_REQUEST_RE = /\b(vegetarian|vegan|plant[-\s]?based|meatless)\b/i;
const ANIMAL_INGREDIENT_RE = /\b(chicken|beef|pork|bacon|turkey|ham|sausage|fish|shrimp|seafood|lamb|meat)\b/i;
const EXACT_ONLY_WORD_RE =
  /\b(?:say|reply|answer|respond)(?:\s+with)?\s+only\s+the\s+word\s+["'`]?([a-z0-9_-]+)["'`]?\b/i;
const ONE_WORD_RE =
  /\b(?:say|reply|answer|respond)(?:\s+with)?\s+(?:exactly\s+)?(?:one|1)\s+word\s+only\b|\b(?:say|reply|answer|respond)(?:\s+with)?\s+exactly\s+(?:one|1)\s+word\b|\b(?:exactly\s+)?(?:one|1)\s+word\s+answer\b/i;
const ONE_SENTENCE_RE =
  /\b(?:in|as|with|answer in)\s+(?:exactly\s+)?(?:one|a single|1)(?:\s+(?:short|clear|concise|warm|brief|plain|simple))*\s+sentence\b|\bexactly\s+one\s+sentence\b|\bone[-\s]sentence\b/i;
const NO_BULLETS_RE = /\b(?:no|without)\s+bullets?\b|\bdo not use bullets?\b|\bdon't use bullets?\b/i;
const CODE_BLOCK_ONLY_RE = /\b(?:reply|return|answer|respond)(?:\s+(?:with\s+only|only\s+with|only))\s+(?:a\s+)?(?:(?:[a-z]+)\s+){0,3}code\s+block\b|\b(?:(?:[a-z]+)\s+){0,3}code\s+block\s+only\b|\bonly\s+(?:a\s+)?(?:(?:[a-z]+)\s+){0,3}code\s+block\b/i;
const FENCED_CODE_BLOCK_RE = /^\s*```[\s\S]*```\s*$/;
const BULLET_LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\u2022\s+)/;
const EXACT_LINE_COUNT_RE =
  /\bexactly\s+(one|two|three|four|five|\d+)\s+(short\s+)?((?:bullet|numbered)\s+)?lines?\b/i;

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function stripOutputDecoration(text: string): string {
  return text
    .trim()
    .replace(/^["'`*_]+/, "")
    .replace(/["'`*_]+$/, "")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(
    1,
    trimmed
      .split(/[.!?]+\s+/)
      .map((part) => part.trim())
      .filter(Boolean).length,
  );
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function usesListShape(text: string): boolean {
  const lines = nonEmptyLines(text);
  return lines.length > 1 || lines.some((line) => BULLET_LINE_RE.test(line));
}

function isOnlyFencedCodeBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!FENCED_CODE_BLOCK_RE.test(trimmed)) return false;
  return (trimmed.match(/```/g) ?? []).length === 2;
}

function parseExactLineCount(prompt: string): {
  count: number;
  requireBullets: boolean;
} | null {
  const match = EXACT_LINE_COUNT_RE.exec(prompt);
  if (!match) return null;
  const raw = match[1]?.toLowerCase();
  if (!raw) return null;
  const count = NUMBER_WORDS[raw] ?? Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 8) return null;
  return {
    count,
    requireBullets: match[3] !== undefined,
  };
}

function buildConciseFormatRepair(input: {
  userPrompt: string;
  outputText: string;
}): LocalHardConstraintRepair | null {
  const exact = EXACT_ONLY_WORD_RE.exec(input.userPrompt);
  const exactTarget = exact?.[1];
  const exactTargetForCompare = exactTarget?.toUpperCase();
  if (
    exactTarget
    && exactTargetForCompare
    && stripOutputDecoration(input.outputText).toUpperCase() !== exactTargetForCompare
  ) {
    return {
      reason: "concise-format",
      systemInstruction:
        "Previous local draft missed an exact-output constraint. Return only the requested token. No explanation, markdown, punctuation, or extra words.",
      userPrompt: `Return exactly: ${exactTarget}\nDo not add anything else.`,
      replacementText: exactTarget,
      generationOptions: {
        temperature: 0,
        top_p: 0.5,
        max_new_tokens: 16,
      },
    };
  }

  if (ONE_WORD_RE.test(input.userPrompt) && countWords(stripOutputDecoration(input.outputText)) > 1) {
    return {
      reason: "concise-format",
      systemInstruction:
        "Previous local draft missed a one-word constraint. Return exactly one word. No explanation, markdown, punctuation, or extra words.",
      userPrompt: `${input.userPrompt}\n\nRegenerate as exactly one word.`,
      generationOptions: {
        temperature: 0,
        top_p: 0.5,
        max_new_tokens: 8,
      },
    };
  }

  if (
    ONE_SENTENCE_RE.test(input.userPrompt)
    && (countSentences(input.outputText) > 1 || usesListShape(input.outputText))
  ) {
    return {
      reason: "concise-format",
      systemInstruction:
        "Previous local draft missed a one sentence constraint. Regenerate as exactly one sentence. Do not add a second sentence, list, preface, or closing note.",
      userPrompt: `${input.userPrompt}\n\nRegenerate as exactly one sentence.`,
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 64,
      },
    };
  }

  if (NO_BULLETS_RE.test(input.userPrompt) && nonEmptyLines(input.outputText).some((line) => BULLET_LINE_RE.test(line))) {
    return {
      reason: "concise-format",
      systemInstruction:
        "Previous local draft used bullets despite a no-bullets constraint. Do not use bullets, numbering, markdown lists, or headings. Return concise prose only.",
      userPrompt: `${input.userPrompt}\n\nRegenerate without bullets or numbered lines.`,
      generationOptions: {
        temperature: 0.15,
        top_p: 0.6,
        max_new_tokens: 96,
      },
    };
  }

  if (CODE_BLOCK_ONLY_RE.test(input.userPrompt) && !isOnlyFencedCodeBlock(input.outputText)) {
    return {
      reason: "concise-format",
      systemInstruction:
        "Previous local draft missed a code-block-only constraint. Return exactly one fenced code block and nothing else. No intro, explanation, bullets, headings, or closing note.",
      userPrompt: `${input.userPrompt}\n\nRegenerate as exactly one fenced code block and nothing else.`,
      generationOptions: {
        temperature: 0.1,
        top_p: 0.55,
        max_new_tokens: 192,
      },
    };
  }

  const lineCount = parseExactLineCount(input.userPrompt);
  if (lineCount) {
    const lines = nonEmptyLines(input.outputText);
    const bulletLines = lines.filter((line) => BULLET_LINE_RE.test(line)).length;
    const wrongLineCount = lines.length !== lineCount.count;
    const wrongBulletShape = lineCount.requireBullets && bulletLines !== lineCount.count;

    if (wrongLineCount || wrongBulletShape) {
      return {
        reason: "concise-format",
        systemInstruction:
          `Previous local draft missed an exact line-count constraint. Return exactly ${lineCount.count} non-empty lines. Each line must be short. No title, preface, explanation, or closing note.`,
        userPrompt: `${input.userPrompt}\n\nRegenerate as exactly ${lineCount.count} short ${lineCount.requireBullets ? "bullet " : ""}lines and nothing else.`,
        generationOptions: {
          temperature: 0.1,
          top_p: 0.55,
          max_new_tokens: 80,
        },
      };
    }
  }

  return null;
}

export function buildLocalHardConstraintRepair(input: {
  userPrompt: string;
  outputText: string;
}): LocalHardConstraintRepair | null {
  if (VEGETARIAN_REQUEST_RE.test(input.userPrompt) && ANIMAL_INGREDIENT_RE.test(input.outputText)) {
    return {
      reason: "dietary-constraint",
      systemInstruction:
        "Previous local draft missed a hard dietary constraint. Regenerate from scratch. Use only this closed plant-based ingredient set: beans, lentils, tofu, tempeh, chickpeas, vegetables, grains, tomatoes, spices, and vegetable broth. Do not add substitutions, alternatives, or parenthetical ingredient swaps. Return the corrected final answer only.",
      userPrompt:
        `${input.userPrompt}\n\nRegenerate from scratch as a strictly vegetarian answer. Use only plant proteins, vegetables, grains, tomatoes, spices, and vegetable broth. Keep the ingredient list short and avoid extra substitutions or alternatives.`,
      generationOptions: {
        temperature: 0.2,
        top_p: 0.65,
        repetition_penalty: 1.12,
        // Kept, unlike the `writing` profile overrides. Transformers.js bans
        // n-grams across the prompt too, which is why those were removed — but
        // this repair regenerates a recipe FROM SCRATCH against a closed
        // ingredient set and deliberately wants different phrasing from the
        // draft that broke the constraint. Nothing here has to be reproduced
        // verbatim, so the ban costs nothing and discourages re-deriving the
        // failed answer. (`buildConciseFormatRepair` correctly sets none.)
        no_repeat_ngram_size: 4,
      },
    };
  }

  return buildConciseFormatRepair(input);
}
