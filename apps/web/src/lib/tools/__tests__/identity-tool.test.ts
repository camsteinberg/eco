// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Unit tests for the host-authoritative identity/privacy tool (Finding G).
 *
 * Two properties matter and are exhaustively covered here: (1) the matcher fires on
 * the identity / privacy / "are you <product>?" frames it must own, extracting the
 * right intent (and canonical subject casing for are-you-x); and (2) — the load-
 * bearing half — it ABSTAINS on the deny-battery of look-alikes ("where does
 * Dropbox store my data?", "tell me about ChatGPT", "are you sure?"), because a
 * false positive would replace a real answer with the identity boilerplate. The
 * execute output is a constant per intent (the on-device truth stated verbatim).
 */

import { describe, it, expect } from "vitest";
import {
  identityTool,
  IDENTITY_HOST_ANSWER,
  DATA_LOCATION_HOST_ANSWER,
  areYouXHostAnswer,
  type IdentityArgs,
} from "../identity-tool";

function match(text: string): IdentityArgs | null {
  return identityTool.match(text);
}

describe("identityTool.match — identity intent", () => {
  const cases = [
    "what are you",
    "What are you?",
    "who are you",
    "who are you, really?",
    "who are you really",
    "what's your name",
    "what is your name?",
    "whats your name",
    "what model are you",
    "what ai is this",
    "what llm is this",
    "what ai model is this",
    "what llm model is this",
    "what model is this",
    "who made you",
    "who created you?",
    // Leading fillers are peeled before matching.
    "hey, what are you?",
    "so who made you",
    "ok, what's your name",
  ];
  for (const text of cases) {
    it(`matches identity: "${text}"`, () => {
      expect(match(text)).toEqual({ intent: "identity" });
    });
  }
});

describe("identityTool.match — data-location intent", () => {
  const cases = [
    "where does my data go",
    "where does my data go?",
    "where is my data stored",
    "where is my data saved",
    "where is my data kept",
    "where are my conversations stored",
    "where are my chats saved",
    "where are my messages kept",
    "is my data sent to the cloud",
    "is my data uploaded to the cloud",
    "do you send my data",
    "do you upload my data anywhere",
    "do you share my data with anyone",
    "is this private",
    "is this confidential?",
    "are my conversations private",
    "are my messages private",
    "who can see my messages",
    "who can see my data",
    "does my data leave this device",
    "does my data leave my computer",
    "is my data stored in the cloud",
  ];
  for (const text of cases) {
    it(`matches data-location: "${text}"`, () => {
      expect(match(text)).toEqual({ intent: "data-location" });
    });
  }
});

describe("identityTool.match — are-you-x intent (with canonical subject)", () => {
  const cases: [string, string][] = [
    ["are you ChatGPT?", "ChatGPT"],
    ["are you chatgpt", "ChatGPT"],
    ["are you gpt", "GPT"],
    ["are you gpt-4", "GPT-4"],
    ["are you gpt4", "GPT-4"],
    ["are you openai", "OpenAI"],
    ["are you Claude?", "Claude"],
    ["are you anthropic", "Anthropic"],
    ["are you gemini", "Gemini"],
    ["are you bard", "Bard"],
    ["are you llama", "Llama"],
    ["are you mistral", "Mistral"],
    ["are you copilot", "Copilot"],
  ];
  for (const [text, subject] of cases) {
    it(`matches are-you-x "${text}" → ${subject}`, () => {
      expect(match(text)).toEqual({ intent: "are-you-x", subject });
    });
  }
});

describe("identityTool.match — MUST ABSTAIN (the deny-battery)", () => {
  const cases = [
    // Third-party data questions — NOT about Eco.
    "where does Dropbox store my data?",
    "how does Google Cloud work?",
    "does Signal send my data to servers?",
    "how do I store data in localStorage?",
    // "who/what/are-you" frames that are not identity questions.
    "who are you voting for?",
    "what are you doing this weekend?",
    "are you sure?",
    "are you able to help with math?",
    // Talking ABOUT a product, not asking if we ARE it.
    "tell me about ChatGPT",
    // A name that isn't ours.
    "my name is Alex, what's a good gift for him?",
    "what's the name of the tallest mountain?",
    // Mixed turn — the whole-turn anchor fails, so identity abstains.
    "what model are you and what's 2+2?",
    // Empty / whitespace.
    "",
    "   ",
  ];
  for (const text of cases) {
    it(`abstains on: "${text}"`, () => {
      expect(match(text)).toBeNull();
    });
  }
});

describe("identityTool.execute — verbatim on-device truth per intent", () => {
  it("identity → IDENTITY_HOST_ANSWER", async () => {
    const result = await identityTool.execute({ intent: "identity" });
    expect(result).toMatchObject({ display: IDENTITY_HOST_ANSWER, ok: true });
  });

  it("data-location → DATA_LOCATION_HOST_ANSWER", async () => {
    const result = await identityTool.execute({ intent: "data-location" });
    expect(result).toMatchObject({ display: DATA_LOCATION_HOST_ANSWER, ok: true });
  });

  it("are-you-x → areYouXHostAnswer(subject) with an honest, self-identifying denial", async () => {
    const result = await identityTool.execute({ intent: "are-you-x", subject: "ChatGPT" });
    expect(result.display).toBe(areYouXHostAnswer("ChatGPT"));
    expect(result.display).toContain("No — I'm not ChatGPT");
    expect(result.display).toContain("Eco");
    expect(result.ok).toBe(true);
  });

  it("is presentation:'host-answer' and produces an empty forModel (model never runs)", async () => {
    expect(identityTool.presentation).toBe("host-answer");
    const result = await identityTool.execute({ intent: "identity" });
    expect(result.forModel).toBe("");
  });
});

describe("identityTool — answers honor the privacy-accuracy constraint", () => {
  it("names local persistence honestly (never claims 'nothing is stored')", () => {
    // Conversations DO persist locally; the answers must say so rather than overclaim.
    expect(IDENTITY_HOST_ANSWER).toContain("saved locally");
    expect(DATA_LOCATION_HOST_ANSWER).toContain("stored locally");
  });

  it("data-location discloses the one honest web-lookup exception", () => {
    expect(DATA_LOCATION_HOST_ANSWER).toContain("web lookups");
  });
});
