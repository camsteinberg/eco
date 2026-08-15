// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * RESEARCH_RE retirement — 2026-08-15.
 *
 * `RESEARCH_RE` was `/\b(research|sources|cite|latest|current|news|
 * 202[5-9]|up-to-date)\b/i`, tested as the FIRST branch in the intent
 * cascade. Its only effect was temp 0.35 + an explicit hedging hint
 * ("Distinguish supported claims from uncertain ones; cite sources only
 * when you can back the claim") — handed to a model with no sources,
 * no web access, and no retrieval. Bare words like "current", "latest",
 * "news" claimed everyday asks: "whats the latest with my order" got the
 * research treatment, "i saw it on the news last night" got the research
 * treatment.
 *
 * The regex disjunct is gone. The `options.researchMode` flag survives
 * for the type contract but production callers all pass false. These
 * tests pin the new behaviour: everyday asks that contain research-
 * trigger words now fall through to the normal cascade / shape classifier.
 */

import { describe, expect, it } from "vitest";

import { inferChatIntent } from "../chat-intent";

describe("research intent — retired RESEARCH_RE no longer claims everyday asks", () => {
  it.each([
    "whats the current balance on my account",
    "whats the latest with my order",
    "i saw it on the news last night",
    "how do i cite a book in an essay",
    "i was born in 2025 how old am i",
  ])("does not route to research: %s", (text) => {
    expect(inferChatIntent(text)).not.toBe("research");
  });
});

describe("research intent — the explicit researchMode flag still works", () => {
  it("researchMode: true still routes to research", () => {
    expect(inferChatIntent("tell me about batteries", { researchMode: true })).toBe("research");
  });

  it("researchMode: false does not route to research on its own", () => {
    expect(inferChatIntent("tell me about batteries", { researchMode: false })).not.toBe("research");
  });
});
