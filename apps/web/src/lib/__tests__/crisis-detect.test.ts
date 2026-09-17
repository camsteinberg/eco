// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, expect, it } from "vitest";
import { detectCrisisPhrasing, CRISIS_PATTERN_COUNT } from "../crisis-detect";

// Explicit statements the card exists for. Written as a person types them, mixed case
// and punctuation included, because that is what reaches the matcher.
const POSITIVES = [
  "i want to kill myself",
  "I want to die",
  "I think I'm going to end my life",
  "I want to take my own life",
  "I feel suicidal",
  "I've had suicidal thoughts for weeks",
  "I tried to commit suicide last year",
  "sometimes I want to hurt myself",
  "I've been thinking about self-harm",
  "I have been cutting myself again",
  "I don't want to be alive anymore",
  "I don’t want to live anymore", // curly apostrophe, as iOS sends it
  "there's no reason to live",
  "I'd be better off dead",
  "I wish I was dead",
  "I keep thinking about killing myself",
  "I can't stop thinking about ending it",
  "how to overdose on pills",
] as const;

// Ordinary and technical writing that must NEVER surface the card. Every one of these
// contains a keyword a naive matcher would trip on.
const NEGATIVES = [
  "kill this process",
  "kill the server",
  "this deadline is killing me",
  "my phone died",
  "die() in php",
  "suicide squad",
  "the battery is dead",
  "I'm dying to see that film",
  "dead code",
  "kill -9 1234",
  "cut the cord",
  // Third-person, news-style prose about the subject.
  "the article says suicide rates fell",
  "summarise this report on suicide prevention funding",
  "he died peacefully in his sleep in the novel",
  // Ordinary requests with no self-harm content at all.
  "what's the capital of Norway?",
  "",
  "   ",
] as const;

describe("detectCrisisPhrasing", () => {
  it.each(POSITIVES)("matches explicit phrasing: %s", (text) => {
    expect(detectCrisisPhrasing(text)).toBe(true);
  });

  it.each(NEGATIVES)("does not match: %s", (text) => {
    expect(detectCrisisPhrasing(text)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(detectCrisisPhrasing("I WANT TO KILL MYSELF")).toBe(true);
  });

  it("matches phrasing embedded in a longer message", () => {
    expect(
      detectCrisisPhrasing(
        "work has been impossible and honestly I want to die, I don't know who to talk to",
      ),
    ).toBe(true);
  });

  it("is deterministic across repeated calls", () => {
    expect(detectCrisisPhrasing("I feel suicidal")).toBe(true);
    expect(detectCrisisPhrasing("I feel suicidal")).toBe(true);
    expect(detectCrisisPhrasing("kill the server")).toBe(false);
  });

  it("carries the documented pattern count", () => {
    expect(CRISIS_PATTERN_COUNT).toBe(15);
  });
});
