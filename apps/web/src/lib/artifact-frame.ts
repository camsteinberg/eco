// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { askPrefix } from "./ask-text";

/**
 * A completion frame for artifact asks: when a user turn asks for an artifact
 * to be produced (correspondence, corrected text, etc.), the turn's rendered
 * form ends with a noun phrase naming that artifact — "The message to send to
 * the family group chat:" or "The corrected version:" — after the hint and
 * the recap blocks.
 *
 * THREE PATTERN FAMILIES:
 *   1. Correspondence — an author/send verb governing an artifact noun:
 *      "write the message to Dave", "can u resend it".
 *   2. Correction — a correction verb (fix, proofread, correct, rewrite) with
 *      a text-correction object (typos, spelling, grammar): "fix the typos",
 *      "proofread this before i send it". Frame: "The corrected [noun]:" or
 *      "The corrected version:" when no artifact noun is named.
 *   3. Transform — a self-qualifying transform verb ("summarise this",
 *      "shorten it", "tidy/polish/soften/translate this"), "bullet point this",
 *      or "make <this|it> <more|less|sound|comparative> X" ("make this more
 *      formal", "make this shorter"): give the transformed text back, don't
 *      explain how. Frame: "The summary:" (summarise), "The translation:"
 *      (translate), "As a bulleted list:" (bullet point), else "The rewritten
 *      version:".
 *
 * ★ WHY A FRAME AND NOT AN INSTRUCTION. Measured (PR #113, n=10 per arm): two
 * different instruction clauses appended to exactly these asks both FAILED —
 * one shortened replies by deletion and revived a superseded date, the other
 * produced a nine-placeholder blank template. What moved the needle was
 * context construction (figure/detail recap, PR #111/#115), and the detail
 * recap improved artifact delivery 3/10 -> 5/10 as a side effect, plausibly by
 * anchoring message shape. This module extends that family: the ask itself is
 * restated as a typed slot for the artifact, placed nearest the generation
 * boundary, where the recap block's list shape would otherwise be the last
 * thing the model reads.
 *
 * ★ MECHANICAL, NOT SALIENT — the recap modules' rule, for the same reason.
 * The gate never judges whether the user "really" wants an artifact; it fires
 * on SHAPE: a recognised verb in a request context, governing a recognised
 * noun or correction object. Silence is the fail-safe direction: a missed
 * frame costs nothing that today's baseline doesn't already cost, a wrong
 * frame invites the wrong artifact.
 *
 * ★ KV STRICT-PREFIX CONTRACT (`runtime/kv-cache.ts`): the frame derives ONLY
 * from the turn's own text, so a past turn always re-renders
 * byte-identically. Classifiers never see it — frames are applied after
 * `applyTurnHints` and after both recap blocks (`appendBranchRecaps`).
 */

/**
 * Nouns that name an artifact the user can ask for. Correspondence plus the
 * kinds proofread/rewrite/decode jobs produce.
 */
const ARTIFACT_NOUNS = new Set([
  "message",
  "email",
  "letter",
  "invite",
  "invitation",
  "text",
  "reply",
  "post",
  "ad",
  "essay",
  "version",
  "summary",
]);

/**
 * Verbs that ask for correspondence to be produced. "mail" is deliberately
 * absent (parcels), and so is "written"/"say" (prose about writing, not an
 * ask to write).
 */
const AUTHOR_VERBS = new Set(["write", "draft", "compose", "email", "send", "resend"]);

/** Verbs that themselves name the artifact they ask for: "email my sons teacher". */
const VERB_AS_NOUN: Readonly<Record<string, string>> = { email: "email", text: "text" };

/** Pronouns a resend verb may govern instead of a noun: "can u resend it". */
const OBJECT_PRONOUNS = new Set(["it", "that", "this"]);

/**
 * A word before "email"/"text" that marks NOUN usage — "back to the email" must
 * not read as the verb "email" with "the email's" neighbours as its object.
 */
const NOUN_MARKERS = new Set([
  "the", "a", "an", "my", "our", "your", "his", "her", "their", "its",
  "that", "this", "another", "one",
]);

/**
 * Words that mark what follows as a request: "can you write the message",
 * "i need to email my sons teacher", "can u resend it". Kept to the everyday
 * spoken forms the corpus is typed in, contractions included.
 */
const REQUEST_LEADS = new Set([
  "can", "could", "would", "will", "please", "pls",
  "need", "want", "have", "gonna", "going",
]);

/**
 * Words that may stand between the start of a sentence and a clause-initial
 * imperative without making it something other than one: "go on then write the
 * letter". Anything else in front of the verb and the sentence is doing
 * something else with it.
 */
const IMPERATIVE_LEAD_IN = new Set([
  "ok", "okay", "right", "so", "then", "now", "just", "and", "go", "on",
]);

/**
 * Verbs that ask for text to be corrected/improved. "proofread" is
 * self-qualifying; the others need a CORRECTION_OBJECT in the verb's window
 * to confirm the verb is about text, not about fixing a car or rewriting
 * history.
 */
const CORRECTION_VERBS = new Set(["fix", "correct"]);
const SELF_QUALIFYING_CORRECTION_VERBS = new Set(["proofread", "rewrite"]);

/**
 * Objects that confirm a correction verb is about TEXT correction:
 * "fix the typos", "correct the grammar". Without one of these in the
 * verb's window, "fix" could mean anything.
 */
const CORRECTION_OBJECTS = new Set([
  "typos", "typo", "spelling", "grammar", "punctuation", "mistakes",
]);

/** How many words past the correction verb an object may sit. */
const CORRECTION_OBJECT_WINDOW = 4;

/**
 * Verbs that name a TEXT-OUTPUT transform — "summarise this", "shorten it".
 * Unlike the correction verbs these are NOT self-qualifying: "summarize" /
 * "simplify" / "condense" can govern an external subject ("summarize what a vpn
 * does"), so the scan additionally requires a reference to the user's own text
 * (`hasTransformTarget`). Ambiguous transforms are left out on the anti-
 * overfitting rule — "expand"/"lengthen" overlap the explain intent — and
 * silence stays the fail-safe direction.
 *
 * TR-1 widening (2026-08-16, measured on the real 1.2B): added tidy/polish/
 * soften (rewrite), translate (its own frame), and the "bullet point" reformat
 * below — the natural phrasings the audit found routing to `explain`. "clean"
 * is intentionally out (unmeasured, and "clean this room" is a real non-text
 * sense). Keep in sync with ask-text.ts TEXT_TRANSFORM_RE.
 */
const SELF_QUALIFYING_TRANSFORM_VERBS = new Set([
  "shorten", "condense", "summarize", "summarise", "paraphrase",
  "rephrase", "reword", "simplify", "tighten", "formalize", "formalise",
  "tidy", "polish", "soften", "translate",
]);

/** The transform verbs whose output is named a summary, not a rewrite. */
const SUMMARY_VERBS = new Set(["summarize", "summarise"]);

/** Transform verbs whose output is a translation, not a same-language rewrite. */
const TRANSLATE_VERBS = new Set(["translate"]);

/**
 * The "make <this|it> <degree> X" rewrite pattern — "make this more formal",
 * "make it less wordy", "make this sound professional". "make" alone is far too
 * common to gate on ("make a study guide", "make spaghetti"): the demonstrative
 * AND a degree word together are what mark it as a rewrite of existing text.
 *
 * TR-1 (2026-08-16): the bare comparative "make this shorter/punchier" — once
 * deliberately excluded — IS now covered, but via a CURATED prose-comparative
 * set (`MAKE_COMPARATIVES`), not a blanket "-er" match. A blanket rule would
 * pull in "make it easier" (explain) and "make it bigger" (not text); the
 * curated set is category-level (prose length/tone) and was measured to flip
 * the 1.2B from lecturing to delivering. Keep in sync with ask-text.ts.
 */
const MAKE_TARGETS = new Set(["this", "it"]);
const MAKE_QUALIFIERS = new Set(["more", "less", "sound"]);
const MAKE_COMPARATIVES = new Set([
  "shorter", "punchier", "tighter", "snappier", "crisper",
  "wordier", "bolder", "leaner", "softer", "sharper",
]);

/**
 * How many words past the "this"/"it" a degree word may sit. 3 (was 2) so the
 * frame matches the routing regex's tolerance for a filler like "make it a bit
 * shorter" (this→a→bit→shorter), keeping the two predicates in sync.
 */
const MAKE_QUALIFIER_WINDOW = 3;

/**
 * References to the user's OWN text that a transform verb must govern —
 * "summarise THIS", "reword IT". Without one, "summarize what a vpn does" is a
 * knowledge ask that happens to use the verb, not a text transform.
 */
const TRANSFORM_TARGETS = new Set(["this", "it", "that", "these", "those"]);

/** How many words past the transform verb its text reference may sit. */
const TRANSFORM_TARGET_WINDOW = 3;

/** How many word tokens back from the verb a request lead may sit. */
const REQUEST_LEAD_WINDOW = 4;

/** Words that may sit between the verb and its artifact noun: "write the message". */
const VERB_NOUN_WINDOW = 3;

/** At most this many words of audience after "to"/"for". */
const MAX_AUDIENCE_WORDS = 5;

type Token = {
  kind: "word" | "break" | "punct";
  text: string;
  lower: string;
};

/** Sentence breaks end an audience scan; commas end a noun phrase. */
const TOKEN_RE = /(?<word>\p{L}[\p{L}']*)|(?<brk>[.!?;\n])|(?<punct>[,—–:\-/])/gu;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const groups = match.groups;
    if (!groups) continue;
    if (groups.word !== undefined) {
      tokens.push({ kind: "word", text: groups.word, lower: groups.word.toLowerCase() });
    } else if (groups.brk !== undefined) {
      tokens.push({ kind: "break", text: groups.brk, lower: groups.brk });
    } else {
      tokens.push({ kind: "punct", text: match[0], lower: match[0] });
    }
  }
  return tokens;
}

/** Index of the next word token, or -1 at a sentence break / end. */
function nextWord(tokens: readonly Token[], from: number): number {
  for (let i = from + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "break") return -1;
    if (token.kind === "word") return i;
  }
  return -1;
}

/** The nearest word token before `index`, ignoring punctuation, or -1. */
function previousWord(tokens: readonly Token[], index: number): number {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.kind === "word") return i;
    if (token.kind === "break") return -1;
  }
  return -1;
}

/** The word tokens before `index` in its sentence, nearest first. */
function precedingWords(tokens: readonly Token[], index: number): string[] {
  const words: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.kind === "break") break;
    if (token.kind === "word") words.push(token.lower);
  }
  return words;
}

/**
 * Whether the verb at `index` sits in a request for correspondence rather than
 * a question about some. "did you send the email to dave" has exactly the same
 * verb-governs-noun shape as "can you send the email to dave", and the shape
 * test alone reads both as an ask — so a turn asking whether a message went out
 * would end with a frame inviting one nobody wanted. Two readings qualify: a
 * request lead in the four word tokens before the verb, in the same sentence
 * ("can you write the message", "i need to email my sons teacher"), or a
 * clause-initial imperative, where the verb opens its sentence or only lead-in
 * words stand in front of it ("go on then write the letter"). Everything else
 * is silence.
 */
function isRequestShaped(tokens: readonly Token[], index: number): boolean {
  const before = precedingWords(tokens, index);
  if (before.slice(0, REQUEST_LEAD_WINDOW).some((word) => REQUEST_LEADS.has(word))) return true;
  return before.every((word) => IMPERATIVE_LEAD_IN.has(word));
}

/** The artifact noun within the verb's window, or -1. */
function nounAfterVerb(tokens: readonly Token[], verbIndex: number): number {
  let index = verbIndex;
  for (let seen = 0; seen < VERB_NOUN_WINDOW; seen++) {
    index = nextWord(tokens, index);
    if (index === -1) return -1;
    if (ARTIFACT_NOUNS.has(tokens[index]!.lower)) return index;
  }
  return -1;
}

/**
 * The audience noun phrase starting at `from`: word tokens up to the cap,
 * stopping at any break or punctuation (a comma ends "my sons teacher,").
 * Verbatim casing, joined with single spaces.
 */
function nounPhraseFrom(tokens: readonly Token[], from: number): string {
  const parts: string[] = [];
  for (let i = from; i < tokens.length && parts.length < MAX_AUDIENCE_WORDS; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") break;
    parts.push(token.text);
  }
  return parts.join(" ");
}

/**
 * How far past the artifact noun a "to"/"for" may sit and still be naming the
 * audience. "the message i send to the family group chat" is two words of gap;
 * "proper letter, ive not done one of these before and i dont want to sound
 * like an idiot" has a "to" too, and an unbounded scan would make the
 * recipient "sound like an idiot". Past the window, the honest answer is that
 * no audience was named — a bare frame, not a guessed one.
 */
const AUDIENCE_TO_WINDOW = 3;

/**
 * The audience named after the artifact noun: a "to"/"for" within the window,
 * in the same sentence, skipping a "to" that leads into a verb ("to send")
 * rather than a recipient.
 */
function audienceAfterNoun(tokens: readonly Token[], nounIndex: number): string {
  let gap = 0;
  for (let i = nounIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "break") return "";
    if (token.kind !== "word") continue;
    if (token.lower !== "to" && token.lower !== "for") {
      gap++;
      if (gap > AUDIENCE_TO_WINDOW) return "";
      continue;
    }
    const head = nextWord(tokens, i);
    if (head === -1) return "";
    if (AUTHOR_VERBS.has(tokens[head]!.lower)) continue;
    return nounPhraseFrom(tokens, head);
  }
  return "";
}

/** The most recent artifact noun before `index`, anywhere in the turn. */
function latestNounBefore(tokens: readonly Token[], index: number): string {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.kind === "word" && ARTIFACT_NOUNS.has(token.lower)) return token.lower;
  }
  return "";
}

/** Whether a CORRECTION_OBJECT sits within the verb's window. */
function hasCorrectionObject(tokens: readonly Token[], verbIndex: number): boolean {
  let index = verbIndex;
  for (let seen = 0; seen < CORRECTION_OBJECT_WINDOW; seen++) {
    index = nextWord(tokens, index);
    if (index === -1) return false;
    if (CORRECTION_OBJECTS.has(tokens[index]!.lower)) return true;
  }
  return false;
}

/**
 * Whether "make" at `index` is a command TO the assistant, not a "would make"
 * inside a statement. "make" is common enough ("that would make this more
 * complicated") that `isRequestShaped`'s any-lead-nearby test isn't tight
 * enough: a rewrite ask has the assistant as the direct addressee — the verb
 * opens the clause ("make this more formal"), or "you"/"please" governs it
 * ("can you make it less wordy", "please make this formal").
 */
function makeIsDirected(tokens: readonly Token[], index: number): boolean {
  const before = precedingWords(tokens, index);
  if (before.every((word) => IMPERATIVE_LEAD_IN.has(word))) return true;
  const nearest = before[0]!;
  return nearest === "you" || nearest === "u" || nearest === "please" || nearest === "pls";
}

/**
 * Whether "make" at `index` is a rewrite ask: a "this"/"it" governed by the
 * verb, then a degree word (more/less/sound) within the window. This is what
 * separates "make this more formal" from "make a study guide" and "make
 * spaghetti" — all three are request-shaped "make", only the first rewrites
 * existing text.
 */
function makeIsRewrite(tokens: readonly Token[], index: number): boolean {
  const target = nextWord(tokens, index);
  if (target === -1 || !MAKE_TARGETS.has(tokens[target]!.lower)) return false;
  let cursor = target;
  for (let seen = 0; seen < MAKE_QUALIFIER_WINDOW; seen++) {
    cursor = nextWord(tokens, cursor);
    if (cursor === -1) return false;
    const word = tokens[cursor]!.lower;
    if (MAKE_QUALIFIERS.has(word) || MAKE_COMPARATIVES.has(word)) return true;
  }
  return false;
}

/** Whether a transform verb at `index` governs a reference to the user's text. */
function hasTransformTarget(tokens: readonly Token[], index: number): boolean {
  let cursor = index;
  for (let seen = 0; seen < TRANSFORM_TARGET_WINDOW; seen++) {
    cursor = nextWord(tokens, cursor);
    if (cursor === -1) return false;
    if (TRANSFORM_TARGETS.has(tokens[cursor]!.lower)) return true;
  }
  return false;
}

/** The first ARTIFACT_NOUN anywhere in the token stream. */
function anyArtifactNoun(tokens: readonly Token[]): string {
  for (const token of tokens) {
    if (token.kind === "word" && ARTIFACT_NOUNS.has(token.lower)) return token.lower;
  }
  return "";
}

function frameLine(noun: string, audience: string, again: boolean): string {
  if (again) return `The ${noun} again:`;
  if (audience.length > 0) return `The ${noun} to send to ${audience}:`;
  return `The ${noun}:`;
}

function correctionFrame(noun: string): string {
  return `The corrected ${noun}:`;
}

const TRANSFORM_SUMMARY_FRAME = "The summary:";
const TRANSFORM_REWRITE_FRAME = "The rewritten version:";
const TRANSFORM_TRANSLATION_FRAME = "The translation:";
const TRANSFORM_LIST_FRAME = "As a bulleted list:";

/**
 * The frame for one turn, or "" — a pure function of the turn's own text.
 * Runs over `askPrefix`, so a pasted document can neither fire the gate nor
 * supply an audience.
 *
 * Three scans run in order (first match wins):
 *   1. Correspondence — AUTHOR_VERB + ARTIFACT_NOUN → "The [noun]:" / "… to send to [audience]:"
 *   2. Correction — CORRECTION_VERB + CORRECTION_OBJECT → "The corrected [noun]:" / "The corrected version:"
 *   3. Transform — SELF_QUALIFYING_TRANSFORM_VERB, "bullet point <this>", or
 *      "make <this|it> <degree|comparative>" → "The summary:" (summarise),
 *      "The translation:" (translate), "As a bulleted list:" (bullet point),
 *      else "The rewritten version:"
 */
export function buildArtifactFrame(turnText: string): string {
  const source = askPrefix(turnText);
  if (source.length === 0) return "";
  const tokens = tokenize(source);

  // ── Scan 1: correspondence ──────────────────────────────────────────────
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || !AUTHOR_VERBS.has(token.lower)) continue;
    const verb = token.lower;

    if (VERB_AS_NOUN[verb] !== undefined) {
      const before = previousWord(tokens, i);
      if (before !== -1 && NOUN_MARKERS.has(tokens[before]!.lower)) continue;
    }

    if (!isRequestShaped(tokens, i)) continue;

    const nounIndex = nounAfterVerb(tokens, i);
    if (nounIndex !== -1) {
      const noun = tokens[nounIndex]!.lower;
      return frameLine(noun, audienceAfterNoun(tokens, nounIndex), verb === "resend");
    }

    const verbNoun = VERB_AS_NOUN[verb];
    if (verbNoun !== undefined) {
      const head = i + 1;
      if (tokens[head]?.kind !== "word") continue;
      const audience = nounPhraseFrom(tokens, head);
      if (audience.length === 0) continue;
      return frameLine(verbNoun, audience, false);
    }

    if (verb === "resend") {
      const objectIndex = nextWord(tokens, i);
      if (objectIndex === -1 || !OBJECT_PRONOUNS.has(tokens[objectIndex]!.lower)) continue;
      const noun = latestNounBefore(tokens, i);
      if (noun.length === 0) continue;
      return frameLine(noun, "", true);
    }
  }

  // ── Scan 2: correction ──────────────────────────────────────────────────
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") continue;

    if (SELF_QUALIFYING_CORRECTION_VERBS.has(token.lower)) {
      if (!isRequestShaped(tokens, i)) continue;
      const noun = anyArtifactNoun(tokens);
      return correctionFrame(noun.length > 0 ? noun : "version");
    }

    if (CORRECTION_VERBS.has(token.lower)) {
      if (!isRequestShaped(tokens, i)) continue;
      if (!hasCorrectionObject(tokens, i)) continue;
      const noun = anyArtifactNoun(tokens);
      return correctionFrame(noun.length > 0 ? noun : "version");
    }
  }

  // ── Scan 3: transform ─────────────────────────────────────────────────────
  // "Do the transform, don't explain it" — the family `ask-text.ts` left for
  // its own measurement. Runs after correspondence and correction so a write or
  // repair ask keeps its own, more specific frame.
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word") continue;

    if (SELF_QUALIFYING_TRANSFORM_VERBS.has(token.lower)) {
      if (!isRequestShaped(tokens, i)) continue;
      if (!hasTransformTarget(tokens, i)) continue;
      if (SUMMARY_VERBS.has(token.lower)) return TRANSFORM_SUMMARY_FRAME;
      if (TRANSLATE_VERBS.has(token.lower)) return TRANSFORM_TRANSLATION_FRAME;
      return TRANSFORM_REWRITE_FRAME;
    }

    // "bullet point this" / "bullet-point this" — a reformat into a list.
    if (token.lower === "bullet") {
      const point = nextWord(tokens, i);
      if (point !== -1 && tokens[point]!.lower === "point") {
        if (isRequestShaped(tokens, i) && hasTransformTarget(tokens, point)) {
          return TRANSFORM_LIST_FRAME;
        }
      }
    }

    if (token.lower === "make") {
      if (!makeIsDirected(tokens, i)) continue;
      if (!makeIsRewrite(tokens, i)) continue;
      return TRANSFORM_REWRITE_FRAME;
    }
  }

  return "";
}

/**
 * The frame each user turn in a branch should carry, indexed by user-turn
 * ordinal. Derived from the FULL branch for the same KV reason as the
 * recaps, though each frame reads only its own turn.
 */
export function buildBranchArtifactFrames(
  messages: readonly { role: string; content: string }[],
): readonly string[] {
  const frames: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    frames.push(buildArtifactFrame(message.content));
  }
  return frames;
}

/**
 * Append the branch's frames to the user turns of a (possibly windowed) list.
 * Applied LAST — after `applyTurnHints` and after both recap blocks — so the
 * frame is the final line the model reads, and nothing that classifies a turn
 * ever sees it. Alignment by user-turn ordinal counted from the END, exactly
 * as `appendDetailRecaps`.
 */
export function appendArtifactFrames<T extends { role: string; content: string }>(
  messages: readonly T[],
  branchFrames: readonly string[],
): T[] {
  const userTurnCount = messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);
  let ordinal = branchFrames.length - userTurnCount;
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const frame = branchFrames[ordinal++] ?? "";
    if (frame.length === 0) return message;
    return { ...message, content: `${message.content}\n\n${frame}` };
  });
}
