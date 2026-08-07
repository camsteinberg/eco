// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { appendFigureRecaps, buildBranchFigureRecaps, statedText } from "./figure-recap";

/**
 * Recap of the DETAILS the user settled earlier in the conversation — the date,
 * the time, the place, the cost per person — appended to the end of each user
 * turn. The non-numeric sibling of `figure-recap.ts`, built on the same
 * contracts and for the same measured reason.
 *
 * ★ WHAT PROBLEM THIS SOLVES. Asked part-way through a conversation to write
 * the message she will paste into a family group chat — `convo-birthday-lunch-
 * message` in `__tests__/fixtures/everyday-conversation-corpus.ts`, probed at
 * turn 6 — the shipping 2B hands back an invitation with the specifics missing.
 * Measured over 10 real generations: the venue reached the message 1/10, the
 * right date 5/10, a WRONG weekday or date 5/10 (Saturday three times — the day
 * the conversation explicitly moved off), the price 5/10, and 7/10 left a
 * bracketed placeholder where the conversation had already given the answer.
 * Everything the message needed was in the prompt. It was present, not salient.
 * Two different families of instruction were tried against exactly this and
 * both failed; the record is the comment above `writing:` in `chat-intent.ts`.
 * Restating the settled details at generation time is the intervention that
 * worked for money in `figure-recap.ts`, and this is that mechanism extended to
 * the facts that are not amounts.
 *
 * ★★ MECHANICAL, NOT SALIENT — the same rule and the same reason. This never
 * decides which details MATTER. A detail counts iff the user typed a span whose
 * SHAPE names one: two or more adjacent calendar tokens, a clock time, a name
 * followed by a street/venue word, an amount followed by "a head". It will
 * sometimes recap a detail irrelevant to the current ask — `convo-insurance-
 * recall` yields the deposit date, which that conversation's final ask has no
 * use for. That is the same bounded, accepted cost `figure-recap.ts` takes, and
 * much cheaper than reintroducing the relevance judgment `eval/rubric.ts`
 * already proves cannot be written for this domain.
 *
 * ★★★ SUPERSESSION IS A FIRST-CLASS REQUIREMENT HERE, NOT AN EDGE CASE.
 * Measured on this very conversation (PR #113): a hint asking the model to
 * reuse "the words they were given in" pulled the CORRECTED-AWAY date back into
 * the reply 1/10 -> 5/10. Re-injecting the user's own wording is exactly what
 * this module does, so the corrected-away version must be incapable of reaching
 * the block. Two independent things stop it:
 *   1. LAST-STATED-WINS per slot. Each slot holds one value: the most recent
 *      span the user typed for it. "sunday 8th march" replaces anything said
 *      about the date before it, rather than sitting beside it.
 *   2. THE TWO-TOKEN SHAPE TEST. "her birthdays the 7th but thats a saturday"
 *      is two separate one-token spans — a bare ordinal and a bare weekday —
 *      and neither is a candidate at all. The superseded date in the
 *      conversation this was built for cannot enter the block even before
 *      supersession is consulted.
 *
 * ★ THE KV STRICT-PREFIX CONTRACT (`runtime/kv-cache.ts`), unchanged from its
 * sibling. Turn K's recap derives ONLY from user turns before K, so it
 * re-renders byte-identically once K becomes history. It must be derived from
 * the FULL branch, never from `selectMessagesForContext`'s output, so a moving
 * eviction boundary cannot silently rewrite an already-cached turn.
 *
 * ★ TWO BLOCKS, NOT ONE. A turn that has both gets the figure recap and then
 * this one, as separate labelled blocks. Merging them would either drop these
 * slot labels — "sunday 8th march" is unreadable in a list of bare amounts — or
 * invent labels for the figures, and it would rewrite the block `figure-recap`
 * was measured with. On today's corpus the two are never both non-empty
 * (`detail-recap.test.ts` pins that), so the cost of two blocks is currently
 * zero and the separation is free.
 *
 * ★ WHAT IS DELIBERATELY OUT OF SCOPE, and why. Each of these was considered
 * and left out rather than done badly:
 *   - WHO IS DOING WHAT ("kierans doing the cake"). Extractable, but it is
 *     stated after the turn this was measured at, so shipping it would mean
 *     shipping an unmeasured slot. The house rule is that nothing ships on
 *     reasoning alone.
 *   - HEADCOUNT ("about 14 of us"), dietary needs, seating. Real details, but
 *     no measured failure asks for them, and every slot added is prompt weight
 *     spent on every conversation.
 *   - VENUES WITH NO ADDRESS. The place rule anchors on a street or venue word.
 *     A restaurant named only as "Luigi's" is invisible to it. Anchoring on
 *     capitalisation instead was rejected: the corpus is typed lower-case
 *     throughout, and the one venue in it is described, never named.
 *   - RELATIVE DATES ("tomorrow", "next week"). One token by construction, and
 *     a recap that survives into later turns must not carry a value whose
 *     meaning moves.
 *   - "may" AND "mar" AS MONTH WORDS. "may" is a modal verb and "mar" is a
 *     verb; either would let ordinary prose form a two-token date span. The
 *     corpus makes the same call about `may` for its own scoring. The cost is a
 *     May date going unrecapped — silence, not a wrong date, which is the
 *     fail-safe direction.
 */

/** The kinds of detail this reads. One value each, latest statement wins. */
export type DetailSlot = "date" | "time" | "place" | "cost";

/** A detail the user typed, kept exactly as they wrote it. */
export type StatedDetail = {
  slot: DetailSlot;
  /** The span as it appeared in the user's turn, verbatim. */
  value: string;
};

const RECAP_PREFIX = "Details I gave earlier in this chat:";

/** Rendering order. Fixed, so the block is a pure function of the slot values. */
const SLOT_ORDER: readonly DetailSlot[] = ["date", "time", "place", "cost"];

const SLOT_LABEL: Record<DetailSlot, string> = {
  date: "date",
  time: "time",
  place: "place",
  cost: "cost",
};

/** Full weekday names only — "sat" is also a verb, "sun" and "mon" are nouns. */
const WEEKDAYS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/** Month names and the abbreviations that are not also ordinary words. */
const MONTHS = new Set([
  "january", "february", "march", "april", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/**
 * Words that may sit BETWEEN two calendar tokens without ending the span.
 *
 * Deliberately excludes the prepositions "in", "on" and "at": they lead INTO a
 * date rather than joining one, and admitting them lets an unrelated number
 * reach a month across them — "water 31 ... in october" would become the date
 * "31 in october". Measured on the budget conversation, that is the shape the
 * corpus's densest turn actually has.
 */
const DATE_JOINERS = new Set(["the", "of", "and", "or", "to"]);

/** Punctuation that may sit between two calendar tokens: "7th, 8th". */
const DATE_JOINER_PUNCTUATION = new Set([",", "-", "–", "—"]);

/**
 * Street and venue words a place name may end with. A closed list, the same
 * kind of small vocabulary `figure-recap.ts` allows itself for enumerations:
 * every entry is a noun that is not also a common verb, so "we drive to my
 * sisters" and "we way past it" cannot form a place. "st" is left out because
 * it is equally "saint".
 */
const PLACE_SUFFIXES = new Set([
  "road", "rd", "street", "lane", "avenue", "ave", "crescent", "terrace",
  "square", "restaurant", "cafe", "pub", "hotel", "church", "hall", "centre",
  "center", "club", "school", "hospital", "station", "library",
]);

/** Prepositions that put a thing AT a place: "an italian ON bridgford road". */
const LOCATIVES = new Set(["on", "at", "in", "off", "near", "opposite", "down"]);

/**
 * Words that carry no name of their own. Walking back from a place word these
 * are stepped over and they end a noun phrase — the same treatment
 * `figure-recap.labelEndingAt` gives them.
 */
const PHRASE_STOP = new Set([
  "a", "an", "the", "my", "our", "your", "his", "her", "their", "its", "it",
  "this", "that", "these", "those", "them", "they", "we", "you", "i", "he",
  "she", "theres", "there", "is", "was", "are", "were", "be", "been", "am",
  "has", "have", "had", "do", "does", "did", "got", "get", "and", "or", "but",
  "so", "then", "also", "just", "only", "well", "ok", "okay", "right",
  "about", "like", "of", "to", "for", "from", "with", "by", "per",
  "go", "going", "went", "book", "booked", "booking", "rung", "ring", "called",
  "weve", "ive", "im", "id", "hes", "shes", "theyre", "were",
]);

/**
 * A span preceded by one of these is a detail the user RULED OUT. The birthday
 * conversation contains the exact hazard — "not il pescatore thats the fish
 * one" — and a recap that emits the ruled-out venue is worse than no recap at
 * all. Only the three word-tokens immediately before a span are inspected, and
 * the walk stops at sentence punctuation, so "nobody can do more than about 25
 * quid a head" is untouched: "more than" is a ceiling, not a negation.
 *
 * ★ "no" IS DELIBERATELY ABSENT, and it was in this list until a test caught
 * it. Standalone "no" is a correction marker far more often than a negation —
 * "saturday 7th … no wait, sunday 8th" — so treating it as one drops the
 * SUPERSEDING statement and leaves the superseded one standing, which is the
 * single worst thing this module can do. "not" and the contracted negatives
 * carry the real cases.
 */
const NEGATORS = new Set([
  "not", "isnt", "wasnt", "arent", "werent", "dont", "doesnt", "didnt",
  "cant", "cannot", "never", "instead", "without", "avoid", "except",
]);

/** How far back from a span to look for a negation. */
const NEGATION_WINDOW = 3;

/** At most this many words of name before a street or venue word. */
const MAX_PLACE_NAME_WORDS = 2;

/** At most this many words of noun phrase before the locative preposition. */
const MAX_PLACE_HEAD_WORDS = 3;

/**
 * A clock time: "1pm", "1 p.m.", "6:15am", "13:30", and the three named hours.
 * A bare number is never a time — "hes no good saturdays til after 7" states an
 * hour in prose and reads as one only to a human.
 */
const TIME_RE =
  /\b(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]\.?m\.?)?|(?:1[0-2]|0?\d)(?::[0-5]\d)?\s?[ap]\.?m\.?|noon|midday|midnight)\b/gi;

/**
 * An amount stated per person: "25 quid a head", "£25 each", "30 pp".
 *
 * ★ WHY THIS IS A SLOT AND NOT A FIGURE. `figure-recap.ts` keys every amount on
 * the noun BEFORE it. This shape puts its label AFTER — "nobody can do more
 * than about 25 quid a head" walks back into "money wise nobody can" and is
 * then dropped for not looking like money, because "quid" is not a currency
 * symbol and "a head" is not a rate. The figure is structurally invisible to
 * that mechanism, which is what makes it a typed slot rather than a gap in the
 * other one.
 */
const PER_PERSON_RE =
  /(?:£\s?\d+(?:\.\d{2})?|\d+(?:\.\d{2})?\s?(?:quid|pounds?))\s*(?:a|per|each)\s*(?:head|person|adult|guest)\b|(?:£\s?\d+(?:\.\d{2})?|\d+(?:\.\d{2})?)\s?pp\b|£\s?\d+(?:\.\d{2})?\s+each\b/gi;

type Token = {
  kind: "word" | "number" | "ordinal" | "break" | "punct";
  text: string;
  lower: string;
  start: number;
  end: number;
  /** Numeric value for `number` and `ordinal` tokens. */
  value?: number;
};

const TOKEN_RE =
  /(?<num>\d+(?:\.\d+)?)|(?<word>\p{L}[\p{L}']*)|(?<brk>[.!?;\n])|(?<punct>[,\-–—:/])/gu;

const ORDINAL_WORDS = new Set(["st", "nd", "rd", "th"]);

function tokenize(text: string): Token[] {
  const raw: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const groups = match.groups;
    if (!groups) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (groups.num !== undefined) {
      raw.push({
        kind: "number",
        text: groups.num,
        lower: groups.num,
        start,
        end,
        value: Number(groups.num),
      });
    } else if (groups.word !== undefined) {
      raw.push({
        kind: "word",
        text: groups.word,
        lower: groups.word.toLowerCase(),
        start,
        end,
      });
    } else if (groups.brk !== undefined) {
      raw.push({ kind: "break", text: groups.brk, lower: groups.brk, start, end });
    } else {
      raw.push({ kind: "punct", text: match[0], lower: match[0], start, end });
    }
  }

  // "8" + "th" written together is one ordinal. Written apart it is two things.
  const tokens: Token[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i]!;
    const next = raw[i + 1];
    if (
      token.kind === "number" &&
      Number.isInteger(token.value) &&
      next?.kind === "word" &&
      ORDINAL_WORDS.has(next.lower) &&
      next.start === token.end
    ) {
      tokens.push({
        kind: "ordinal",
        text: `${token.text}${next.text}`,
        lower: `${token.text}${next.lower}`,
        start: token.start,
        end: next.end,
        value: token.value,
      });
      i++;
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}

function isDayValue(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 31;
}

function isJoiner(token: Token): boolean {
  if (token.kind === "word") return DATE_JOINERS.has(token.lower);
  if (token.kind === "punct") return DATE_JOINER_PUNCTUATION.has(token.text);
  return false;
}

function isMonth(token: Token | undefined): boolean {
  return token?.kind === "word" && MONTHS.has(token.lower);
}

/** The nearest token either side that is not a joiner, or undefined at a break. */
function neighbourAcrossJoiners(
  tokens: readonly Token[],
  index: number,
  step: -1 | 1,
): Token | undefined {
  for (let i = index + step; i >= 0 && i < tokens.length; i += step) {
    const token = tokens[i]!;
    if (token.kind === "break") return undefined;
    if (isJoiner(token)) continue;
    return token;
  }
  return undefined;
}

/**
 * Whether a token is part of a date.
 *
 * A bare number counts only when a month sits next to it ("8 march",
 * "march 8"), which is what keeps "water 31" and "about 14 of us" out. An
 * ordinal counts on its own shape, bounded to a real day of the month so
 * "my mums 60th" is not the 60th of anything.
 */
function isDateToken(tokens: readonly Token[], index: number): boolean {
  const token = tokens[index]!;
  if (token.kind === "word") return WEEKDAYS.has(token.lower) || MONTHS.has(token.lower);
  if (token.kind === "ordinal") return isDayValue(token.value);
  if (token.kind === "number") {
    if (!isDayValue(token.value)) return false;
    return (
      isMonth(neighbourAcrossJoiners(tokens, index, -1)) ||
      isMonth(neighbourAcrossJoiners(tokens, index, 1))
    );
  }
  return false;
}

/** Whether one of the few word-tokens before `index` rules the span out. */
function isNegated(tokens: readonly Token[], index: number): boolean {
  for (let i = index - 1, seen = 0; i >= 0 && seen < NEGATION_WINDOW; i--) {
    const token = tokens[i]!;
    if (token.kind === "break") return false;
    if (token.kind !== "word") continue;
    if (NEGATORS.has(token.lower)) return true;
    seen++;
  }
  return false;
}

/**
 * Date spans in a turn: maximal runs of two or more adjacent calendar tokens.
 *
 * ★ WHY TWO. A lone calendar token is prose far more often than it is a date —
 * "sunday lunch is actually a really good shout", "my mums 60th in march",
 * "rents going up to 790 in october". Requiring two is a test of SHAPE, not of
 * subject: it never asks whether the date is relevant, only whether the user
 * wrote enough of one to be stating it. It is also what makes the superseded
 * "the 7th … a saturday" unreachable in the conversation this was built for.
 */
function dateSpans(source: string, tokens: readonly Token[]): string[] {
  const spans: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!isDateToken(tokens, i)) {
      i++;
      continue;
    }
    const start = i;
    let lastDate = i;
    let count = 1;
    let j = i + 1;
    while (j < tokens.length) {
      const token = tokens[j]!;
      if (token.kind === "break") break;
      if (isJoiner(token)) {
        j++;
        continue;
      }
      if (!isDateToken(tokens, j)) break;
      lastDate = j;
      count++;
      j++;
    }
    if (count >= 2 && !isNegated(tokens, start)) {
      spans.push(source.slice(tokens[start]!.start, tokens[lastDate]!.end));
    }
    i = lastDate + 1;
  }
  return spans;
}

/** The name ending at `index`, walking back while words stay name-ish. */
function nameEndingAt(tokens: readonly Token[], index: number, maxWords: number): number {
  let first = index + 1;
  let words = 0;
  for (let i = index; i >= 0 && words < maxWords; i--) {
    const token = tokens[i]!;
    if (token.kind !== "word" || PHRASE_STOP.has(token.lower) || LOCATIVES.has(token.lower)) break;
    first = i;
    words++;
  }
  return first;
}

/**
 * Place spans: a name ending in a street or venue word, with the thing that
 * sits there when the user said which thing it was.
 *
 * "theres an italian on bridgford road" yields "italian on bridgford road" —
 * the head noun, the locative, and the address. The ruled-out venue in the same
 * sentence, "not il pescatore thats the fish one", has no street or venue word
 * after it and so is not a candidate at all; the negation guard is the second
 * line of defence, not the first.
 */
function placeSpans(source: string, tokens: readonly Token[]): string[] {
  const spans: string[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "word" || !PLACE_SUFFIXES.has(token.lower)) return;
    const nameStart = nameEndingAt(tokens, index - 1, MAX_PLACE_NAME_WORDS);
    // A bare "road" with nothing before it names nowhere.
    if (nameStart > index - 1) return;

    let spanStart = nameStart;
    const beforeName = tokens[nameStart - 1];
    if (beforeName?.kind === "word" && LOCATIVES.has(beforeName.lower)) {
      const headStart = nameEndingAt(tokens, nameStart - 2, MAX_PLACE_HEAD_WORDS);
      if (headStart <= nameStart - 2) spanStart = headStart;
    }
    if (isNegated(tokens, spanStart)) return;
    spans.push(source.slice(tokens[spanStart]!.start, token.end));
  });
  return spans;
}

function matchSpans(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0].trim());
}

/**
 * Every detail a single turn states, in the order the user typed them. A slot
 * stated twice in one turn keeps the later statement, by the same
 * last-stated-wins rule that applies across turns.
 */
export function extractStatedDetails(text: string): readonly StatedDetail[] {
  const source = statedText(text);
  if (source.length === 0) return [];
  const tokens = tokenize(source);

  const details: StatedDetail[] = [];
  const push = (slot: DetailSlot, values: readonly string[]) => {
    for (const value of values) if (value.length > 0) details.push({ slot, value });
  };
  push("date", dateSpans(source, tokens));
  push("time", matchSpans(source, TIME_RE));
  push("place", placeSpans(source, tokens));
  push("cost", matchSpans(source, PER_PERSON_RE));
  return details;
}

/**
 * The recap block for a turn, built from the user turns that came before it.
 *
 * LAST-STATED-WINS, per slot, across the whole branch: each slot carries only
 * the most recent span the user typed for it. There is no cap to tune — the
 * slot set is closed and each slot holds exactly one value, so the block is
 * bounded by construction at four short lines rather than by a ceiling that
 * has to be kept clear of real conversations.
 */
export function buildDetailRecap(priorUserTurns: readonly string[]): string {
  const bySlot = new Map<DetailSlot, string>();
  for (const turn of priorUserTurns) {
    for (const detail of extractStatedDetails(turn)) bySlot.set(detail.slot, detail.value);
  }
  if (bySlot.size === 0) return "";

  const lines = SLOT_ORDER.flatMap((slot) => {
    const value = bySlot.get(slot);
    return value === undefined ? [] : [`${SLOT_LABEL[slot]}: ${value}`];
  });
  return `${RECAP_PREFIX} ${lines.join("; ")}`;
}

/**
 * The recap each user turn in a branch should carry, indexed by user-turn
 * ordinal (0 = the first user turn, which always gets "").
 *
 * MUST be given the FULL branch, never `selectMessagesForContext`'s output —
 * see the KV note at the top of this file. Assistant turns contribute nothing,
 * so a date the model proposed can never come back as one the user gave.
 */
export function buildBranchDetailRecaps(
  messages: readonly { role: string; content: string }[],
): readonly string[] {
  const recaps: string[] = [];
  const priorUserTurns: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    recaps.push(buildDetailRecap(priorUserTurns));
    priorUserTurns.push(message.content);
  }
  return recaps;
}

/**
 * Append the branch's recaps to the user turns of a (possibly windowed) list.
 *
 * ★ APPLIED LAST, AFTER `applyTurnHints` AND AFTER the figure recap. Nothing
 * that classifies a turn may ever see recap text — measured on the budget
 * conversation, recapped text alone flips a turn's intent and so resolves
 * different sampling options. Deliberately kept as its own pass rather than
 * folded into `appendFigureRecaps`, so `figure-recap.ts` stays exactly the
 * module that was measured; the ten lines they have in common are cheaper than
 * the coupling.
 *
 * Alignment is by user-turn ordinal counted from the END, because the windowed
 * list is always a suffix of the branch.
 */
export function appendDetailRecaps<T extends { role: string; content: string }>(
  messages: readonly T[],
  branchRecaps: readonly string[],
): T[] {
  const userTurnCount = messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);
  let ordinal = branchRecaps.length - userTurnCount;
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const recap = branchRecaps[ordinal++] ?? "";
    if (recap.length === 0) return message;
    return { ...message, content: `${message.content}\n\n${recap}` };
  });
}

/**
 * Whole-branch convenience: derive the recaps and apply them in one step. Used
 * where the full branch IS the list being rendered (tests, and any caller that
 * does no windowing).
 */
export function applyDetailRecaps<T extends { role: string; content: string }>(
  messages: readonly T[],
): T[] {
  return appendDetailRecaps(messages, buildBranchDetailRecaps(messages));
}

/** Both recap blocks for a branch, by user-turn ordinal. */
export type BranchRecaps = {
  readonly figures: readonly string[];
  readonly details: readonly string[];
};

/**
 * Derive both recaps from the FULL branch in one call.
 *
 * The dispatch path and the eval harness each need both, always from the same
 * unwindowed branch and always in the same order, so the pairing lives in one
 * place rather than being reassembled at five call sites — that is exactly how
 * derived context has twice gone unwired from the harness before.
 */
export function buildBranchRecaps(
  messages: readonly { role: string; content: string }[],
): BranchRecaps {
  return {
    figures: buildBranchFigureRecaps(messages),
    details: buildBranchDetailRecaps(messages),
  };
}

/**
 * Attach both blocks to a (possibly windowed) list: figures first, then
 * details. The order is fixed here and nowhere else, because it is part of what
 * the KV prefix contract promises — a turn must render identically every time.
 */
export function appendBranchRecaps<T extends { role: string; content: string }>(
  messages: readonly T[],
  recaps: BranchRecaps,
): T[] {
  return appendDetailRecaps(appendFigureRecaps(messages, recaps.figures), recaps.details);
}
