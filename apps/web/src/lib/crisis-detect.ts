// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Deterministic self-harm / suicide phrasing detection for the host-side crisis card.
 *
 * This is NOT a classifier and NOT a filter. It never touches the model, the prompt, or
 * the network: it reads the text the person just typed and answers one question — does
 * this say, explicitly, that they are thinking about ending their life or hurting
 * themselves? A `true` answer adds a small static card with support resources above the
 * reply. The reply itself is unchanged; nothing is blocked, rewritten, or sent anywhere.
 *
 * The patterns are phrase-level on purpose. A bare keyword ("die", "dead", "kill",
 * "suicide") is everywhere in ordinary and technical writing — "kill the server", "the
 * battery is dead", "suicide rates fell" — so every pattern here carries the first-person
 * or explicit framing that makes the statement about the person typing it. The cost of a
 * miss is a missing card; the cost of a false positive is a jarring card on a sentence
 * about a build failure. Both are worth avoiding, and the phrase level is where the two
 * are cheapest.
 */

/**
 * Explicit self-harm / suicide phrasings, one per line with what it is for.
 * All matched case-insensitively against apostrophe-normalised text.
 */
const CRISIS_PATTERNS: readonly RegExp[] = [
  // "i want to kill myself", "kill myself", "killing myself"
  /\bkill(ing)?\s+my\s?self\b/,
  // "end my life", "ending my own life", "end it all"
  /\bend(ing)?\s+(my\s+(own\s+)?life|it\s+all)\b/,
  // "take my life", "taking my own life"
  /\btak(e|ing)\s+my\s+(own\s+)?life\b/,
  // "i want to die", "i just wanna die"
  /\bi\s+(just\s+)?(want|wanna)\s+(to\s+)?die\b/,
  // "i want to be dead", "i wish i was dead"
  /\bi\s+(want\s+to\s+be|wish\s+i\s+(was|were))\s+dead\b/,
  // "better off dead" — deliberately not a bare "dead"
  /\bbetter\s+off\s+dead\b/,
  // "i don't want to be alive", "don't want to live anymore", "don't want to go on"
  /\bdon't\s+want\s+to\s+(be\s+alive|live\s+anymore|go\s+on)\b/,
  // "no reason to live", "no reason to go on"
  /\bno\s+reason\s+to\s+(live|go\s+on)\b/,
  // "hurt myself", "harming myself"
  /\b(hurt|harm)(ing)?\s+my\s?self\b/,
  // "self-harm", "self harm", "selfharm"
  /\bself[-\s]?harm(ing)?\b/,
  // "cutting myself" — the idiom "cut the cord" has no "myself"
  /\bcut(ting)?\s+my\s?self\b/,
  // "i'm suicidal", "suicidal thoughts". News-style prose says "suicide", not "suicidal".
  /\bsuicidal\b/,
  // "commit suicide", "attempted suicide"
  /\b(commit|committing|committed|attempt|attempting|attempted)\s+suicide\b/,
  // "thinking about suicide", "thought of ending it", "think about hurting myself"
  /\b(thinking|think|thought|thoughts)\s+(about|of)\s+(suicide|killing\s+my\s?self|ending\s+(it|my\s+life)|hurting\s+my\s?self)\b/,
  // "how to overdose", "how do i overdose"
  /\bhow\s+(to|can\s+i|do\s+i)\s+overdose\b/,
];

/** How many phrasings the matcher carries — surfaced for tests and diagnostics. */
export const CRISIS_PATTERN_COUNT = CRISIS_PATTERNS.length;

/**
 * True when the text explicitly states self-harm or suicidal intent.
 *
 * Deterministic and side-effect free: same input, same answer, no network, no storage.
 */
export function detectCrisisPhrasing(text: string): boolean {
  if (text.trim() === "") return false;
  // Curly apostrophes reach us from iOS smart punctuation; fold them so a single
  // straight-quote pattern covers both.
  const normalised = text.toLowerCase().replace(/[‘’]/g, "'");
  return CRISIS_PATTERNS.some((pattern) => pattern.test(normalised));
}
