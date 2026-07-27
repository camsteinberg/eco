// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The realistic-input sweep — does anything fire when it shouldn't?
 *
 * Every content-reading heuristic already has its own false-positive corpus, and
 * those corpora work. But each is written in the shape its feature expects: a person
 * typing a short question. This sweep runs the REAL dispatch path (`detectTool` over
 * `DEFAULT_TOOLS`, exactly as `runToolStep` calls it) against a corpus organised by
 * input SHAPE instead — pasted articles, drafted emails, stack traces, transcripts,
 * ordinary chat — so the defects that live outside every feature's mental model of
 * its input have somewhere to show up.
 *
 * THE BAR. Eco runs on-device; that is the product's whole promise. Two of the six
 * shipping tools reach the network when they match, so a spurious match is not a
 * cosmetic bug — it is an unrequested outbound request derived from text the user
 * pasted privately, plus an unrelated article injected at the front of the model's
 * system prompt. So the assertion is deliberately narrow and deliberately harsh:
 * NO network-backed tool may fire on input where a reasonable user would not expect
 * a lookup. The four local tools (calculator, datetime, unit, identity) are free to
 * match whatever they like here — they compute locally and send nothing.
 *
 * Both directions are asserted. Abstention alone is trivially satisfiable by never
 * grounding anything, which would destroy the feature that kills confident
 * hallucination on factual questions, so the corpus carries genuine factual asks
 * that MUST still reach a lookup.
 */

import { describe, it, expect } from "vitest";

import { detectTool, DEFAULT_TOOLS } from "../lib/tools";
import {
  shouldLookUp,
  shouldNotLookUp,
  REALISTIC_INPUTS,
} from "./fixtures/realistic-inputs";

/**
 * The tools that reach the network, derived rather than hardcoded.
 * `presentation: "citation"` is the registry's own marker for the network-backed
 * citation tools (see the DEFAULT_TOOLS doc comment) — the local tools use
 * `"host-answer"` or a ToolCallBlock. Deriving it means a future network tool is
 * covered by this sweep the moment it is registered.
 */
const NETWORK_BACKED: readonly string[] = DEFAULT_TOOLS.filter(
  (tool) => tool.presentation === "citation",
).map((tool) => tool.name);

/**
 * The detection a user would actually get, reduced to the only part that matters
 * here: did a tool that makes an outbound request claim this turn, and on what?
 * Returning the args (not just a boolean) is what makes a failure readable — the
 * report names the entity that would have been sent.
 */
function networkLookupFor(text: string): { tool: string; args: unknown } | null {
  const detection = detectTool(text);
  if (detection === null) {
    return null;
  }
  if (!NETWORK_BACKED.includes(detection.tool.name)) {
    return null;
  }
  return { tool: detection.tool.name, args: detection.args };
}

describe("realistic-input sweep — the network-backed tool set", () => {
  it("is exactly weather + wikipedia-grounding", () => {
    // Guards the derivation above: if a tool starts reaching the network, this
    // fails until someone confirms the sweep covers it.
    expect([...NETWORK_BACKED].sort()).toEqual(["weather", "wikipedia-grounding"]);
  });

  it("covers every input shape", () => {
    expect(REALISTIC_INPUTS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(REALISTIC_INPUTS.map((s) => s.domain)).size).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// The bar: no unrequested outbound lookup.
// ---------------------------------------------------------------------------

/**
 * Where today's behaviour still disagrees with the corpus, with the verified cause.
 *
 * The corpus records what a user EXPECTS; this map records what we currently
 * DELIVER. Keeping them apart matters — the corpus stays a durable statement about
 * people, and the shortfall stays visible instead of being quietly edited out of the
 * expectations. Every entry is asserted at its current behaviour, so closing a gap
 * fails this test and forces the fix to be acknowledged rather than absorbed.
 *
 * All six recall gaps below predate the ask-window work and were measured before it;
 * that change introduced no new ones.
 */
const KNOWN_GAPS: ReadonlyMap<string, string> = new Map([
  [
    "ordinary-chat/gift-advice-short",
    "Advice question ('what do you get someone who...') reaches the zero-entity " +
      "full-text path and searches the user's own question words. Low severity — the " +
      "only text leaving is six words the user typed — but it is still a lookup on a " +
      "turn that wanted none. Not fixed here: every rule tried cost a genuine factual " +
      "question elsewhere in the corpus, and trading a true positive for this is a bad " +
      "deal. Needs a real advice-vs-fact signal, not another pattern.",
  ],
  [
    "factual-questions/half-life-carbon-14",
    "Contains digits ('carbon-14'), and the file's locked digit posture hands " +
      "digit-bearing asks to the calculator. Pre-existing.",
  ],
  [
    "factual-questions/tell-me-about-krakatoa",
    "Same digit posture ('1883'). Pre-existing.",
  ],
  [
    "factual-questions/how-do-mrna-vaccines-work",
    "Short enough that the whole turn is the ask, so the zero-entity keyword query " +
      "exceeds MAX_QUERY_TOKENS. Pre-existing.",
  ],
  [
    "multilingual-and-mixed/french-explain-jaywalking-law",
    "Cue regexes are English-only, so a French factual question carries no cue at " +
      "all. Pre-existing, and the clearest signal that grounding is monolingual.",
  ],
  [
    "multilingual-and-mixed/japanese-osaka-trip-question",
    "English-only cue regexes, as above. Pre-existing.",
  ],
  [
    "code-and-logs/npm-install-error-with-lib-question",
    "Deny-set screens it as a code question ('should I', plus code terms). Arguably " +
      "correct — the tool deliberately never grounds code turns — but the user is " +
      "asking a checkable compatibility fact. Pre-existing.",
  ],
]);

describe("realistic-input sweep — no unrequested outbound lookup", () => {
  for (const sample of shouldNotLookUp()) {
    if (KNOWN_GAPS.has(sample.id)) {
      continue;
    }
    it(`sends nothing for ${sample.id}`, () => {
      expect(networkLookupFor(sample.text)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// The counterweight: genuine factual asks must still reach a lookup, or the fix
// above has simply broken the feature.
// ---------------------------------------------------------------------------

describe("realistic-input sweep — genuine factual asks still ground", () => {
  for (const sample of shouldLookUp()) {
    if (KNOWN_GAPS.has(sample.id)) {
      continue;
    }
    it(`still looks up for ${sample.id}`, () => {
      expect(networkLookupFor(sample.text)).not.toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// The gaps, pinned. Each asserts CURRENT behaviour so improving one is noticed.
// ---------------------------------------------------------------------------

describe("realistic-input sweep — known gaps stay visible", () => {
  it("documents a reason for every gap", () => {
    for (const [id, reason] of KNOWN_GAPS) {
      expect(REALISTIC_INPUTS.some((s) => s.id === id)).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  for (const [id] of KNOWN_GAPS) {
    const sample = REALISTIC_INPUTS.find((s) => s.id === id);
    if (sample === undefined) {
      continue;
    }
    // Pinned to today's behaviour, which is the OPPOSITE of the corpus label.
    // If this test fails, a gap closed: delete the entry rather than "fix" the test.
    const firesToday = sample.expectLookup === "should-not-look-up";
    it(`still ${firesToday ? "fires" : "abstains"} on ${id} (gap)`, () => {
      const result = networkLookupFor(sample.text);
      if (firesToday) {
        expect(result).not.toBeNull();
      } else {
        expect(result).toBeNull();
      }
    });
  }
});
