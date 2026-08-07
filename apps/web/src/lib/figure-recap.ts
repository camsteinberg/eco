// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Recap of the figures the USER stated earlier in the conversation, appended to
 * the end of each user turn.
 *
 * ★ WHAT PROBLEM THIS SOLVES. Across 27 real generations of
 * `convo-four-day-budget-list` on the shipping default, the user's own take-home
 * pay — £2,180, stated once, in turn 1 of 8 — reached the final answer 0 times.
 * 22 of the 27 omitted an income line entirely: the task-shape the model infers
 * from the surrounding turns is "itemize the bills", which has no slot for money
 * coming IN. The other 5 attempted a slot and filled it wrongly in four
 * different ways (a relabelled expense total, "£0", two invented figures).
 * Facts the final turn restates itself survive fine; facts that exist only in an
 * earlier turn are what degrade. Re-stating those figures at generation time is
 * the intervention.
 *
 * ★★ MECHANICAL, NOT SALIENT — AND THAT IS THE WHOLE POINT. This never decides
 * which facts MATTER. `eval/rubric.ts` proves that judgment cannot be written
 * for this domain: a whole-history fact denominator scores a perfect answer near
 * zero on the teacher-email conversation (its history holds a punch recipe) and
 * penalises the budget answer for obeying "use the 790 rent not the old one".
 * So the rule here is grammatical, not semantic: a figure counts iff the user
 * attached a number to a noun. It will sometimes recap something irrelevant to
 * the current ask. That is a bounded, accepted cost — much cheaper than
 * reintroducing a relevance judgment that is known not to work.
 *
 * ★ THE KV STRICT-PREFIX CONTRACT (`runtime/kv-cache.ts`). Turn K's recap is
 * derived ONLY from user turns before K, so it is byte-identical whether it is
 * computed while K is the latest turn or later, when K is history. A recap that
 * grew as the conversation grew would rewrite an already-cached turn, break the
 * strict token prefix, and force a full reprefill on every turn of every
 * conversation that ever mentions a number. It also must be derived from the
 * FULL branch, never from `selectMessagesForContext`'s output — a shifting
 * eviction boundary would otherwise silently change an earlier turn's recap.
 * That is why callers hand this the whole branch, before windowing.
 *
 * ★ HONEST ABOUT ITS PRECISION, like `extractFacts` next door. It reads
 * "rent 745" and "take home was 2690 a month now its 2180"; it does not read
 * "i want to be putting 150 a month away" (no noun before the number) and it
 * labels "one of them plans 14.50" as "plans". Under-reading costs a recap
 * line. Over-reading is what the noun requirement and the cap bound.
 */

/** A figure the user attached to a noun, e.g. "rent 790" or "car tax 245". */
export type StatedFigure = {
  /** Normalized label, used to decide when a later figure restates an earlier one. */
  key: string;
  /** The label as the user first wrote it. */
  label: string;
  /** The figure as the user wrote it, currency symbol included when they used one. */
  value: string;
  /** The rate the user attached ("a month", "for the year"), or "" when none. */
  qualifier: string;
};

/**
 * How many distinct figures a recap may carry.
 *
 * This is a prompt-bloat ceiling, NOT a working limit, and it is deliberately
 * well clear of real conversations: the corpus's most figure-dense item
 * (`convo-four-day-budget-list`) reaches 18 distinct figures by its last turn,
 * and a cap that bound there would drop real numbers from an ordinary budget
 * chat. Worse, it would drop the WRONG ones — the take-home figure this exists
 * to preserve is the OLDEST figure in that conversation, so a small cap evicting
 * oldest-first deletes exactly the fact the recap is for. (A cap of 8–10 was
 * considered and rejected for precisely that reason.) 24 clears the densest
 * thing we have evidence for with headroom, and bounds the pathological case at
 * roughly 200 tokens.
 */
export const FIGURE_RECAP_CAP = 24;

const RECAP_PREFIX = "Figures I gave earlier in this chat:";

/** How far back from a number to look for its noun before giving up. */
const LABEL_SEARCH_WINDOW = 6;

/** At most this many words of noun phrase, so a label stays a label. */
const MAX_LABEL_WORDS = 3;

/**
 * Words that carry no label of their own. Walking back from a number, these are
 * stepped over rather than read as the noun, and they terminate a noun phrase.
 * A closed, mechanical list — not a stopword list anyone has to tune, because
 * anything missing from it simply becomes a slightly longer label.
 */
const CONNECTIVES = new Set([
  // determiners and pronouns
  "a", "an", "the", "my", "our", "your", "his", "her", "their", "its", "it",
  "this", "that", "these", "those", "them", "they", "we", "you", "i", "he",
  "she", "shes", "hes", "theyre", "weve", "youre", "im", "ive", "id", "ill",
  "one", "some", "any", "no", "there",
  // copulas and auxiliaries
  "is", "was", "are", "were", "be", "been", "am", "s", "has", "have", "had",
  "do", "does", "did", "get", "got", "gets", "getting",
  // hedges and discourse glue
  "about", "around", "roughly", "approx", "approximately", "like", "say",
  "says", "said", "think", "reckon", "guess", "maybe", "probably", "ok",
  "okay", "right", "well", "also", "and", "or", "plus", "then", "still",
  "just", "only", "actually", "genuinely", "so", "cos", "because", "but",
  // prepositions
  "at", "of", "to", "for", "in", "on", "from", "per", "by", "with", "each",
  // rate nouns
  "month", "months", "year", "years", "week", "weeks", "monthly", "yearly",
  "weekly", "annual", "annually", "pcm", "pa",
  // movement and payment verbs
  "going", "gone", "goes", "went", "up", "down", "rising", "rise", "risen",
  "changed", "changes", "moved", "now", "currently", "instead", "rather",
  "pay", "pays", "paying", "paid", "put", "putting", "want", "wants", "need",
  "needs", "save", "saving", "spend", "spending", "cost", "costs", "costing",
  "coming", "comes", "come", "use", "using", "used", "wait", "waiting",
  "thought", "turning", "splitting", "split", "sat", "sitting", "theres",
  // comparatives and time relatives, which attach to a number without naming it
  "under", "over", "than", "more", "less", "least", "most", "til", "till",
  "until", "after", "before", "barely", "bigger", "smaller", "another",
  "first", "last", "next", "another", "roughly",
]);

/**
 * Words that mark a number as REPLACING one just given under the same label —
 * "take home was 2690 a month now its 2180". Without a marker between them, two
 * numbers under one noun are two different things ("dogs insurance 29 shes 11
 * now" — 29 is the premium, 11 is the dog), and the second is dropped rather
 * than guessed at. Every marker is also a connective, so the walk steps over it.
 */
const SUPERSESSION_MARKERS = new Set([
  "now", "currently", "instead", "rather", "changed", "changes", "up", "down",
]);

/**
 * Nouns that enumerate rather than cost. "turn 3", "step 2", "option 4" pair a
 * number with a noun and would otherwise pass the grammatical test, so this is
 * the one place a small closed vocabulary earns its keep.
 */
const ENUMERATION_WORDS = new Set([
  "turn", "step", "item", "point", "line", "page", "part", "section",
  "chapter", "question", "option", "number", "version", "round", "phase",
  "level", "note", "rule", "paragraph", "column", "row",
]);

/** A label that names a date rather than a thing that costs money. */
const CALENDAR_WORDS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "jan", "feb", "mar", "apr",
  "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "today", "tomorrow",
  "yesterday",
]);

type Token =
  | { kind: "number"; text: string; end: number }
  | { kind: "word"; text: string; lower: string }
  | { kind: "break" };

// The digit run must END on a digit, or a trailing list comma is read as part
// of the amount ("hold luggage x 2," became the value "2,").
const TOKEN_RE =
  /(?<num>[£$€]\s?\d(?:[\d,]*\d)?(?:\.\d+)?|\d(?:[\d,]*\d)?(?:\.\d+)?)|(?<word>\p{L}[\p{L}']*)|(?<brk>[.!?;\n])/gu;

const ORDINAL_SUFFIX_RE = /^(?:st|nd|rd|th)\b/i;

const QUALIFIER_RE =
  /^[ \t]*(?:(?:a|per|each)\s+(?:month|year|week)|for\s+the\s+(?:month|year|week)|monthly|yearly|weekly|pcm)\b/i;

/**
 * A digit run touching one of these is part of a date, a time, or a reference
 * code — "06:15", "03/04/2026", "SVT/TRV/09-25" — not an amount. Same call
 * `rubric.numericFactKey` makes when it refuses to give such a run a value.
 */
const REFERENCE_PUNCTUATION = /[/:\-–—]/;

/** A figure written as money: "£790", "12.99". */
const CURRENCY_SYMBOL_RE = /^[£$€]/;
const TWO_DECIMAL_RE = /\.\d{2}$/;

/**
 * How many noun+number pairs make a turn a LIST of figures.
 *
 * ★ WHY A SHAPE TEST AT ALL. Without one this reads far too much: measured
 * across the conversation corpus it pulled "Departing 07" and "ATOL protected
 * 4471" out of a pasted booking confirmation, and the punch recipe
 * (`64 oz`) out of the teacher-email conversation — the exact history noise
 * `rubric.ts` warns a whole-history denominator drowns in. A figure therefore
 * has to look like money (a currency symbol, a two-decimal amount, or an
 * explicit rate) OR sit in a turn that is plainly a list of figures, which is
 * how people actually dump a budget: "rent 745. council tax 142. water 31."
 *
 * This is a test of SHAPE, not of subject: it never asks whether a figure is
 * relevant to the current question, only whether the user wrote it as a figure.
 */
const LIST_TURN_MIN_PAIRS = 3;

/**
 * A turn longer than this may be carrying shown content rather than only typed
 * words, so it gets scoped. Every user turn in the budget conversation — bill
 * dumps included — sits well under it; the pasted policy and booking
 * confirmation in `convo-insurance-recall` run several times over.
 */
const PASTED_TURN_MIN_CHARS = 600;

/**
 * The part of a turn the user actually TYPED, with attachments and pasted
 * documents removed.
 *
 * ★ SCOPE, NOT PATTERNS — the same conclusion `wikipedia-grounding-tool.ts`
 * reached about the same class of bug. Measured before this guard, a pasted
 * insurance policy and booking confirmation yielded 24 recap entries of pure
 * document debris ("Departing 07", "ATOL protected 4471", "policy SVT TRV 09").
 * No amount of better number-matching fixes that: those figures are real, they
 * are simply not figures the USER stated. Salvaging the short blocks of a long
 * turn was tried and still leaked ten of them, because a document's own lines
 * are short.
 *
 * Deliberately NOT `askWindows` itself, whose bound is tuned for a different
 * risk — it guards against sending pasted content to a third party, so it fails
 * closed and yields nothing for a long single block. A bill dump is exactly that
 * shape, so reusing it would delete the user's budget.
 *
 * The cost is a user who TYPES more than this in one turn getting no recap of
 * it. That is the fail-safe direction (silence, not noise), and it is well clear
 * of real behaviour: every user turn in the budget conversation, bill dumps
 * included, runs 195–387 characters.
 *
 * Exported because `detail-recap.ts` scopes itself the same way and for the
 * same reason: a pasted document's dates and addresses are real, and are just
 * as much not the USER's stated details.
 */
export function statedText(text: string): string {
  const stripped = text.replace(/<file\b[^>]*>[\s\S]*?(?:<\/file>|$)/gi, " ").trim();
  return stripped.length <= PASTED_TURN_MIN_CHARS ? stripped : "";
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const groups = match.groups;
    if (!groups) continue;
    if (groups.num !== undefined) {
      const end = match.index + match[0].length;
      // "the 19th" / "3rd" are positions and dates, not amounts.
      if (ORDINAL_SUFFIX_RE.test(text.slice(end))) continue;
      // "06:15", "09-25", "03/04/2026" — a date, a time or a reference code.
      const before = match.index > 0 ? text[match.index - 1]! : "";
      const after = text[end] ?? "";
      if (REFERENCE_PUNCTUATION.test(before) || REFERENCE_PUNCTUATION.test(after)) continue;
      tokens.push({ kind: "number", text: groups.num.replace(/\s+/g, ""), end });
    } else if (groups.word !== undefined) {
      tokens.push({ kind: "word", text: groups.word, lower: groups.word.toLowerCase() });
    } else {
      tokens.push({ kind: "break" });
    }
  }
  return tokens;
}

/** The noun phrase ending at `index`, walking backward while words stay label-ish. */
function labelEndingAt(tokens: readonly Token[], index: number): string {
  const parts: string[] = [];
  for (let i = index; i >= 0 && parts.length < MAX_LABEL_WORDS; i--) {
    const token = tokens[i];
    if (!token || token.kind !== "word" || CONNECTIVES.has(token.lower)) break;
    parts.unshift(token.text);
  }
  return parts.join(" ");
}

function normalizeKey(label: string): string {
  const words = label.toLowerCase().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1];
  if (last && last.length > 3 && last.endsWith("s")) words[words.length - 1] = last.slice(0, -1);
  return words.join(" ");
}

function qualifierAfter(text: string, end: number): string {
  const match = QUALIFIER_RE.exec(text.slice(end));
  return match ? match[0].trim() : "";
}

/** A figure the turn states, and whether it looks like money on its own. */
type FigureCandidate = { figure: StatedFigure; moneyShaped: boolean };

/**
 * Every noun+number pair a turn states, flagged with whether it passes the
 * money-shape test. Split out from `extractStatedFigures` because a restatement
 * of an ALREADY-TRACKED label has to count even when it fails that test on its
 * own: "rents going up to 790 in october" is one bare pair in a prose turn, and
 * dropping it would leave the recap quoting the superseded rent forever — the
 * corpus's own stated bounce condition for this conversation.
 */
function figureCandidates(text: string): readonly FigureCandidate[] {
  const source = statedText(text);
  const tokens = tokenize(source);
  const byKey = new Map<string, StatedFigure>();
  const order: string[] = [];
  /** Label resolved for each number token index, so a supersession can inherit it. */
  const labelAt = new Map<number, string>();

  tokens.forEach((token, index) => {
    if (token.kind !== "number") return;

    let label = "";
    let sawSupersession = false;
    for (let i = index - 1, steps = 0; i >= 0 && steps < LABEL_SEARCH_WINDOW; i--, steps++) {
      const previous = tokens[i]!;
      if (previous.kind === "break") break;
      if (previous.kind === "number") {
        // Two numbers under one noun mean one thing only if something marked the
        // second as a restatement of the first.
        if (sawSupersession) label = labelAt.get(i) ?? "";
        break;
      }
      if (SUPERSESSION_MARKERS.has(previous.lower)) {
        sawSupersession = true;
        continue;
      }
      if (CONNECTIVES.has(previous.lower)) continue;
      label = labelEndingAt(tokens, i);
      break;
    }

    if (label.length === 0) return;
    const key = normalizeKey(label);
    if (key.length === 0 || CALENDAR_WORDS.has(key) || ENUMERATION_WORDS.has(key)) return;

    labelAt.set(index, label);
    const existing = byKey.get(key);
    if (!existing) order.push(key);
    byKey.set(key, {
      key,
      // The label stays as the user FIRST named the thing; only the value moves.
      label: existing?.label ?? label,
      value: token.text,
      // The rate belongs to the LABEL, not to one statement of it: "take home
      // was 2690 a month now its 2180" states the rate once and then restates
      // only the amount. Dropping it there cost the recap its whole reason to
      // exist, since the rate is also what marks 2180 as money.
      qualifier: qualifierAfter(source, token.end) || existing?.qualifier || "",
    });
  });

  const figures = order.map((key) => byKey.get(key)!);
  const listShaped = figures.length >= LIST_TURN_MIN_PAIRS;
  return figures.map((figure) => ({
    figure,
    moneyShaped:
      listShaped ||
      CURRENCY_SYMBOL_RE.test(figure.value) ||
      TWO_DECIMAL_RE.test(figure.value) ||
      figure.qualifier.length > 0,
  }));
}

/**
 * The figures a single turn states, deduplicated so a label restated inside one
 * turn keeps its latest value. Order is first-mention order.
 */
export function extractStatedFigures(text: string): readonly StatedFigure[] {
  return figureCandidates(text)
    .filter((candidate) => candidate.moneyShaped)
    .map((candidate) => candidate.figure);
}

/**
 * The recap block for a turn, built from the user turns that came before it.
 *
 * Two independent rules, deliberately not conflated:
 *   - LAST-STATED-WINS: a label restated later keeps only its latest value, so
 *     the October rent replaces the old one rather than sitting beside it.
 *   - RECENCY-ORDER CAPPING: when more than `FIGURE_RECAP_CAP` distinct labels
 *     exist, the least recently stated are dropped.
 * Selection is by recency; RENDERING is chronological, because the figure a
 * conversation opens with is usually the one the whole question rests on (here,
 * take-home pay) and the answer that gets it right leads with it.
 */
export function buildFigureRecap(priorUserTurns: readonly string[]): string {
  const byKey = new Map<string, StatedFigure>();
  const firstSeen = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  let position = 0;

  for (const turn of priorUserTurns) {
    for (const { figure, moneyShaped } of figureCandidates(turn)) {
      const existing = byKey.get(figure.key);
      // A label already established as a figure stays one: a later bare
      // restatement updates it rather than being ignored as prose.
      if (!existing && !moneyShaped) continue;
      if (!existing) firstSeen.set(figure.key, position);
      lastSeen.set(figure.key, position);
      byKey.set(figure.key, {
        ...figure,
        label: existing?.label ?? figure.label,
        qualifier: figure.qualifier || existing?.qualifier || "",
      });
      position++;
    }
  }

  if (byKey.size === 0) return "";

  const kept = [...byKey.keys()]
    .sort((a, b) => lastSeen.get(b)! - lastSeen.get(a)!)
    .slice(0, FIGURE_RECAP_CAP)
    .sort((a, b) => firstSeen.get(a)! - firstSeen.get(b)!);

  const lines = kept.map((key) => {
    const figure = byKey.get(key)!;
    return [figure.label, figure.value, figure.qualifier].filter(Boolean).join(" ");
  });

  return `${RECAP_PREFIX} ${lines.join("; ")}`;
}

/**
 * The recap each user turn in a branch should carry, indexed by user-turn
 * ordinal (0 = the first user turn, which always gets "").
 *
 * MUST be given the FULL branch, never `selectMessagesForContext`'s output: the
 * window start moves in quantised jumps, and deriving from the window would let
 * an eviction silently rewrite an earlier turn's recap after it was cached.
 *
 * Assistant turns contribute nothing, so a total the model computed can never
 * come back as one of "the user's figures" — which is the precise shape of one
 * of the observed income failures (an outgoings total relabelled as income).
 */
export function buildBranchFigureRecaps(
  messages: readonly { role: string; content: string }[],
): readonly string[] {
  const recaps: string[] = [];
  const priorUserTurns: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    recaps.push(buildFigureRecap(priorUserTurns));
    priorUserTurns.push(message.content);
  }
  return recaps;
}

/**
 * Append the branch's recaps to the user turns of a (possibly windowed) list.
 *
 * ★ APPLIED LAST, AFTER `applyTurnHints`, AND THAT ORDERING IS LOAD-BEARING.
 * Classification must only ever see the user's own words: measured on
 * `convo-four-day-budget-list`, prepending the recap before `inferTurnIntent`
 * flips a turn from `explain` to `deep`, which resolves DIFFERENT sampling
 * options. The recap is context, not a new ask, so it enters after every
 * decision the turn's own text is supposed to make. `figure-recap.test.ts` pins
 * both halves of this.
 *
 * Alignment is by user-turn ordinal counted from the END, because the windowed
 * list is always a suffix of the branch. That keeps a turn's recap tied to its
 * position in the real conversation rather than its position in the window.
 */
export function appendFigureRecaps<T extends { role: string; content: string }>(
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
 * does no windowing). The dispatch path splits the two so the recap can be
 * applied after hints — see `appendFigureRecaps`.
 */
export function applyFigureRecaps<T extends { role: string; content: string }>(
  messages: readonly T[],
): T[] {
  return appendFigureRecaps(messages, buildBranchFigureRecaps(messages));
}
