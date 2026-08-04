// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { statedText } from "./figure-recap";

/**
 * A completion frame for correspondence asks: when a mid-conversation user turn
 * asks for a message/email to be written (or sent again), the turn's rendered
 * form ends with a noun phrase naming that artifact — "The message to send to
 * the family group chat:" — after the hint and the recap blocks.
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
 * The gate never judges whether the user "really" wants correspondence; it
 * fires on SHAPE: an author/send verb, in an ask rather than a question
 * (`isRequestShaped`), governing an artifact noun in the typed part of the
 * turn. Silence is the fail-safe direction: a missed frame costs nothing that
 * today's baseline doesn't already cost, a wrong frame invites the wrong
 * artifact.
 *
 * ★ KV STRICT-PREFIX CONTRACT (`runtime/kv-cache.ts`): the frame derives ONLY
 * from the turn's own text and its user-turn ordinal, so a past turn always
 * re-renders byte-identically. Classifiers never see it — frames are applied
 * after `applyTurnHints` and after both recap blocks (`appendBranchRecaps`).
 */

/** Nouns that name a piece of correspondence the user can ask for. */
const ARTIFACT_NOUNS = new Set([
  "message",
  "email",
  "letter",
  "invite",
  "invitation",
  "text",
  "reply",
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

function frameLine(noun: string, audience: string, again: boolean): string {
  if (again) return `The ${noun} again:`;
  if (audience.length > 0) return `The ${noun} to send to ${audience}:`;
  return `The ${noun}:`;
}

/**
 * The frame for one turn, or "" — a pure function of the turn's own text and
 * whether user turns precede it. First user turns never frame: the ask is the
 * whole turn there and nothing has yet displaced it. Runs over `statedText`,
 * so a pasted document can neither fire the gate nor supply an audience.
 */
export function buildArtifactFrame(turnText: string, hasPriorTurns: boolean): string {
  if (!hasPriorTurns) return "";
  const source = statedText(turnText);
  if (source.length === 0) return "";
  const tokens = tokenize(source);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "word" || !AUTHOR_VERBS.has(token.lower)) continue;
    const verb = token.lower;

    // "back to the email" is the NOUN "email", not the verb — a marker before
    // a verb that doubles as a noun disqualifies the occurrence entirely.
    if (VERB_AS_NOUN[verb] !== undefined) {
      const before = previousWord(tokens, i);
      if (before !== -1 && NOUN_MARKERS.has(tokens[before]!.lower)) continue;
    }

    // "did you send the email to dave" asks ABOUT correspondence and must not
    // be answered with any; only a request or an imperative gets a frame.
    if (!isRequestShaped(tokens, i)) continue;

    // "write the message", "resend the email" — a noun the verb governs.
    const nounIndex = nounAfterVerb(tokens, i);
    if (nounIndex !== -1) {
      const noun = tokens[nounIndex]!.lower;
      return frameLine(noun, audienceAfterNoun(tokens, nounIndex), verb === "resend");
    }

    // "email my sons teacher" — the verb names the artifact; the object is the
    // audience. No object, no ask — and the object must follow the verb
    // DIRECTLY: "Email, because ive got her address" is a fragment naming a
    // channel, and punctuation after the "verb" means the words beyond it are
    // not its object. Reading on from there frames a subordinate clause as the
    // recipient.
    const verbNoun = VERB_AS_NOUN[verb];
    if (verbNoun !== undefined) {
      const head = i + 1;
      if (tokens[head]?.kind !== "word") continue;
      const audience = nounPhraseFrom(tokens, head);
      if (audience.length === 0) continue;
      return frameLine(verbNoun, audience, false);
    }

    // "can u resend it" — the pronoun resolves to the turn's own earlier
    // artifact noun, or nothing. Never to another turn's, and never for plain
    // "send it" — a turn can ask ABOUT sending ("did you send it?"), and
    // silence is the fail-safe direction.
    if (verb === "resend") {
      const objectIndex = nextWord(tokens, i);
      if (objectIndex === -1 || !OBJECT_PRONOUNS.has(tokens[objectIndex]!.lower)) continue;
      const noun = latestNounBefore(tokens, i);
      if (noun.length === 0) continue;
      return frameLine(noun, "", true);
    }
  }
  return "";
}

/**
 * The frame each user turn in a branch should carry, indexed by user-turn
 * ordinal (0 = the first user turn, which always gets ""). Derived from the
 * FULL branch for the same KV reason as the recaps, though each frame reads
 * only its own turn.
 */
export function buildBranchArtifactFrames(
  messages: readonly { role: string; content: string }[],
): readonly string[] {
  const frames: string[] = [];
  let ordinal = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    frames.push(buildArtifactFrame(message.content, ordinal > 0));
    ordinal++;
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
