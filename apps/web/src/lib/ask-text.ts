// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * What the user ASKED, separated from what they PASTED — and whether the ask
 * is a request to repair their own text.
 *
 * ★ WHY THIS MODULE EXISTS. A turn like "can you fix my spelling in this" plus
 * a 400-word pasted letter is fifteen words of instruction and four hundred
 * words of subject. Every classifier that reads the whole turn therefore reads
 * the SUBJECT as the ask: measured on the everyday-use corpus, eleven of the
 * twelve paste-heavy turns classified as `deep` — the one intent whose turn
 * hint is "Use clear sections; include concrete recommendations and tradeoffs".
 * The model then does exactly that to a proofread request. The instruction is
 * the ask; the paste is what the ask points at.
 *
 * Leaf module by design: `artifact-frame` and `chat-intent` both depend on it
 * and neither depends on the other, so the frame stays invisible to anything
 * that classifies a turn (the purity contract `artifact-frame.ts` documents).
 */

/**
 * Turns at or below this length are all ask — nothing is a paste. Above it,
 * the first paragraph is where the instruction sits when a document follows.
 */
export const PASTED_TURN_MIN_CHARS = 600;

/**
 * The instruction the user typed, with any pasted document removed.
 *
 * Short turns are returned whole. Long turns return the first paragraph, and
 * "" when there isn't a credible one — no paragraph break at all, or a first
 * paragraph so long it is itself the paste. Silence is the fail-safe
 * direction: a caller that gets "" falls back to the whole turn rather than
 * guessing at a boundary that isn't there.
 */
export function askPrefix(text: string): string {
  const stripped = text.replace(/<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/gi, " ").trim();
  if (stripped.length <= PASTED_TURN_MIN_CHARS) return stripped;
  const breakIndex = stripped.indexOf("\n\n");
  if (breakIndex < 10) return "";
  const prefix = stripped.slice(0, breakIndex).trim();
  if (prefix.length > PASTED_TURN_MIN_CHARS) return "";
  return prefix;
}

/**
 * A paste must outweigh the instruction by this much, and be at least
 * `PASTE_MIN_CHARS` on its own, before the first paragraph is read as the ask.
 *
 * ★ WHY A RATIO AND NOT A LENGTH. `askPrefix` only looks below the surface of
 * turns over 600 characters, which misses the ordinary case: "can u make this
 * sound less passive aggressive" plus a 359-character email is 436 characters
 * total, and every classifier reading the whole turn reads the email. What
 * makes something a paste is not that the turn is long, it is that the
 * material after the instruction dominates it.
 *
 * The two constants are round numbers chosen so that a short two-line turn
 * ("does this sound rude" + a 96-character quote) is NOT split — at that size
 * the whole turn genuinely is the ask, and splitting it changed the routing of
 * a turn that was already being handled well.
 */
const PASTE_DOMINANCE_RATIO = 2;
const PASTE_MIN_CHARS = 200;

/**
 * The instruction paragraph of a turn that pastes material, or the whole turn.
 *
 * Differs from `askPrefix` on purpose. `askPrefix` answers "is there an
 * instruction I can safely gate an artifact frame on?" and prefers silence.
 * This answers "which part of this turn is the user asking?" for a classifier,
 * where the fallback is the whole turn — exactly today's behaviour — so a
 * wrong split costs nothing that is not already being paid.
 */
export function instructionParagraph(text: string): string {
  const stripped = text.replace(/<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/gi, " ").trim();
  const breakIndex = stripped.indexOf("\n\n");
  if (breakIndex < 10) return stripped;

  const instruction = stripped.slice(0, breakIndex).trim();
  const rest = stripped.slice(breakIndex).trim();
  if (instruction.length > PASTED_TURN_MIN_CHARS) return stripped;
  if (rest.length < PASTE_MIN_CHARS) return stripped;
  if (rest.length < instruction.length * PASTE_DOMINANCE_RATIO) return stripped;
  return instruction;
}

/**
 * Verbs that need a text-quality object to confirm they are about text —
 * "fix the typos" is a repair ask, "fix my wifi" is not.
 */
const REPAIR_VERB = "fix|correct|check|edit|clean ?up|tidy ?up|sort out";

/**
 * Verbs that mean text repair on their own. "proofread" cannot be about a
 * carburettor, and "reword" cannot ask for anything but text back. Same set
 * `artifact-frame` treats as self-qualifying, for the same reason.
 */
const SELF_QUALIFYING_REPAIR_VERB =
  "proof ?read|spell ?check|re-?write|re-?word|rephrase";

/** Objects that confirm a repair verb is about text quality. */
const TEXT_QUALITY_OBJECT =
  "typos?|spelling|grammar|grammer|punctuation|mistakes?|errors?|wording";

/** How far past the verb its object may sit, in characters, within one clause. */
const OBJECT_WINDOW = 30;

const TEXT_REPAIR_RE = new RegExp(
  `\\b(?:${SELF_QUALIFYING_REPAIR_VERB})\\b`
    + `|\\b(?:${REPAIR_VERB})\\b[^.?!]{0,${OBJECT_WINDOW}}?\\b(?:${TEXT_QUALITY_OBJECT})\\b`,
  "i",
);

/**
 * Whether the ask is "give me my text back, repaired" rather than "tell me
 * about my text". Reads the ASK ONLY, so a pasted document that happens to
 * discuss spelling cannot fire it.
 *
 * ★ DELIBERATELY NOT COVERED, on the anti-overfitting rule: "make this better",
 * "make this sound less passive aggressive", and "knock the spelling errors out
 * of it" are all repair asks in the corpus that this does not catch. They
 * belong to a separate family ("make this <different>", which needs the paste
 * to resolve "this") and adding them here would be fitting the rule to the
 * labelled items rather than to the category. Measure that family on its own.
 */
export function isTextRepairAsk(text: string): boolean {
  return TEXT_REPAIR_RE.test(instructionParagraph(text));
}
