// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Two-pass repair: the model names the sentences it would change, the APP
 * changes them.
 *
 * ★ WHY THIS EXISTS. Ask a 2B model to "fix the mistakes in this and give it
 * back", and what comes back is frequently not the person's writing any more.
 * Measured on the everyday-use corpus: an ESL note to a teacher returns as
 * smooth institutional English with the writer's closing apology deleted; a
 * job application returns as a cover letter addressed to "Dear Hiring Manager"
 * with a `[Your Last Name]` placeholder and the applicant's honest admission
 * about lacking a certificate reversed. Four separate instruction arms have
 * been tried against this — "keep their voice", "only correct errors" — and
 * every one was reverted or measured worse. Instructions are persuasion, and
 * persuasion is what a 2B model is worst at holding across 300 tokens.
 *
 * So this stops asking the model to produce the answer. The app splits the
 * pasted text into numbered sentences, and the model is asked for ONLY the
 * numbers it would change, with the corrected sentence after each one. The app
 * substitutes those back. Every sentence the model does not name is not
 * regenerated at all — so voice replacement, `[Your Name]` placeholders and
 * invented facts in untouched spans stop being matters of persuasion and
 * become structurally impossible.
 *
 * ★ WHY NUMBERS AND NOT QUOTED SPANS. The obvious shape is `wrong phrase =>
 * corrected phrase`, applied by exact-match replacement. It requires the model
 * to reproduce the original span byte-exactly, which is precisely the thing
 * this model is unreliable at, and every near-miss quote is a correction
 * silently dropped. A number is one token and cannot be misquoted.
 *
 * ★ NOT A DIFF ENGINE, deliberately. There is no alignment, no fuzzy matching
 * and no merge. A sentence is either named and replaced wholesale, or left
 * exactly as the person typed it. When the model's reply yields no usable
 * numbered line, this reports a fallback and the caller runs today's
 * whole-text generation — no worse than the current behaviour, which is the
 * only bar a flagged path has to clear.
 *
 * ★★ KNOWN DEFECT — DO NOT TURN THE FLAG ON. Measured live on 2026-08-09
 * against qwen3.5-2b (evidence: `m2-evidence/two-pass-repair-runs-2026-08-09.json`,
 * label `two-pass-t3`). The model complies with the format, but ITS numbering
 * does not reliably agree with OURS: on both samples of the ESL note it
 * returned its corrections one line out, so the app substituted the "4th grade"
 * correction into her NEXT sentence — duplicating one line and DELETING the
 * apology about the reading log, which is the reason she wrote the note at all.
 *
 * The guarantee this module claims — an unnamed sentence is never regenerated —
 * holds only if the two numberings agree, and they do not. What is needed is an
 * alignment check: some way to confirm a returned line belongs to the unit it
 * names before substituting it. That is the "does this have to become
 * elaborate to work at all?" question, and it is a decision, not a detail.
 *
 * Note also that the ENTIRE scorecard read 1.00 on that output —
 * `preservesUserText`, `preservesUserRegister`, `noUnfilledSlots`,
 * `deliversUnburied`. A lost sentence is invisible to every dim we have.
 *
 * ★ EXACT REASSEMBLY IS THE LOAD-BEARING PROPERTY. Each unit carries the
 * whitespace that followed it, so re-joining units with no replacements
 * reproduces the source character for character — blank lines, line breaks and
 * all. `sentence-repair.test.ts` asserts that over every pasted block in the
 * corpus. If that stops holding, the guarantee this module exists for is gone.
 */

import { askPrefix, instructionParagraph, isTextRepairAsk, pastedBlock } from "./ask-text";
import { safeStorage } from "./local-storage";

export const SENTENCE_REPAIR_FLAG_KEY = "eco-sentence-repair";

/**
 * Whether the two-pass path is on. Off by default — this is a mechanism
 * change to the most sensitive job in the corpus, and it ships dark until it
 * is measured. Same sticky-flag shape as `dev-diagnostics.ts`:
 *
 *   /chat?eco-sentence-repair=1   → on now AND persisted
 *   /chat?eco-sentence-repair=0   → off now AND the sticky flag is cleared
 *   (no param)                    → whatever the sticky flag says (default off)
 */
export function isSentenceRepairEnabled(search?: string): boolean {
  const query = search ?? (typeof window === "undefined" ? null : window.location.search);
  if (query === null) return false;
  const param = new URLSearchParams(query).get("eco-sentence-repair");
  if (param === "0") return false;
  if (param === "1") return true;
  return safeStorage.get(SENTENCE_REPAIR_FLAG_KEY) === "1";
}

/** Persist ?eco-sentence-repair=1/0 into the sticky flag. */
export function syncSentenceRepairFlagFromUrl(search?: string): void {
  const query = search ?? (typeof window === "undefined" ? null : window.location.search);
  if (query === null) return;
  const param = new URLSearchParams(query).get("eco-sentence-repair");
  if (param === "1") safeStorage.set(SENTENCE_REPAIR_FLAG_KEY, "1");
  else if (param === "0") safeStorage.remove(SENTENCE_REPAIR_FLAG_KEY);
}

/**
 * One unit of the person's text plus the whitespace that followed it. The
 * trailer is what makes reassembly exact: replacing a body never disturbs the
 * line breaks around it.
 */
export type RepairUnit = { readonly body: string; readonly trailer: string };

export type SentenceRepairPass = {
  /** The units, in order. Numbering in the prompt is 1-based over this array. */
  readonly units: readonly RepairUnit[];
  /** The system instruction for the corrections pass. */
  readonly systemInstruction: string;
  /** The user turn for the corrections pass, numbered text included. */
  readonly userPrompt: string;
  /**
   * A repair is the most input-constrained job there is — every word of the
   * answer already exists in the paste — so it runs colder than the `writing`
   * profile it would otherwise inherit (0.48).
   *
   * `no_repeat_ngram_size` is deliberately ABSENT. Transformers.js applies it
   * across the full sequence, prompt included, so any value at all would
   * forbid the model from reusing the person's own spans — on the one job
   * whose entire requirement is reusing them.
   */
  readonly generationOptions: {
    readonly temperature: number;
    readonly top_p: number;
    readonly max_new_tokens: number;
  };
};

export type SentenceRepairOutcome =
  | {
      readonly status: "applied";
      /** The person's text with the named sentences substituted. */
      readonly text: string;
      /** How many units the model named and the app replaced. */
      readonly replaced: number;
      /** How many units there were. `replaced / total` reads as over-rewriting. */
      readonly total: number;
    }
  | {
      readonly status: "fallback";
      readonly reason: "no-numbered-lines" | "no-usable-numbers";
    };

/**
 * Below this, the paste is too small to be worth two passes — the whole-text
 * path handles a one-line caption fine, and numbering it reads as bureaucracy.
 */
const MIN_PASTE_CHARS = 120;

/** At least this many units, or numbering buys nothing over rewriting whole. */
const MIN_UNITS = 3;

/**
 * Above this, the numbered listing costs more prompt than the repair is worth
 * and the model starts losing track of the numbering. Silence (a null pass)
 * falls back to today's behaviour.
 */
const MAX_UNITS = 60;

/** Room for the corrections: most units, each once, plus the numbering. */
const TOKENS_PER_UNIT = 40;
const MIN_NEW_TOKENS = 256;
const MAX_NEW_TOKENS = 1536;

/**
 * Words that end in a full stop without ending a sentence. Without these,
 * "Dear Ms. Halbrook" numbers as two units and the model is asked to correct
 * a fragment.
 *
 * A single CAPITAL letter counts too, for initials — "J. Smith". Case is
 * load-bearing there: a lowercase single letter before a full stop is texting
 * shorthand, and treating "love u. i hope" as an initial merged two of the
 * birthday caption's sentences into one unit, which meant correcting one typo
 * regenerated both.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "rev", "sr", "jr", "st",
  "vs", "etc", "eg", "ie", "approx", "no", "dept", "inc", "ltd",
]);

const SENTENCE_END = new Set([".", "!", "?"]);
/** Closers that belong to the sentence they follow: he said "stop!" */
const TRAILING_CLOSERS = new Set(['"', "'", "’", "”", ")", "]"]);

function endsInAbbreviation(body: string): boolean {
  const match = /([\p{L}]+)\.$/u.exec(body);
  if (!match) return false;
  const word = match[1]!;
  if (word.length === 1) return word === word.toUpperCase();
  return ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Split text into units that reassemble exactly. Boundaries are a run of
 * newlines (which keeps paragraphs and line breaks intact) or sentence-ending
 * punctuation followed by spaces. Everything else — including a full stop with
 * no space after it, which in this corpus is usually a typo rather than a
 * boundary — stays inside its unit.
 */
export function segmentForRepair(source: string): RepairUnit[] {
  const units: RepairUnit[] = [];
  let bodyStart = 0;
  let index = 0;

  while (index < source.length) {
    const char = source[index]!;

    if (char === "\n") {
      const breakStart = index;
      while (index < source.length && /\s/.test(source[index]!)) index++;
      units.push({
        body: source.slice(bodyStart, breakStart),
        trailer: source.slice(breakStart, index),
      });
      bodyStart = index;
      continue;
    }

    if (SENTENCE_END.has(char)) {
      let end = index + 1;
      while (
        end < source.length
        && (SENTENCE_END.has(source[end]!) || TRAILING_CLOSERS.has(source[end]!))
      ) {
        end++;
      }
      let afterSpaces = end;
      while (afterSpaces < source.length && (source[afterSpaces] === " " || source[afterSpaces] === "\t")) {
        afterSpaces++;
      }
      const body = source.slice(bodyStart, end);
      if (afterSpaces > end && !endsInAbbreviation(body)) {
        units.push({ body, trailer: source.slice(end, afterSpaces) });
        bodyStart = afterSpaces;
      }
      index = afterSpaces > end ? afterSpaces : end;
      continue;
    }

    index++;
  }

  if (bodyStart < source.length) {
    units.push({ body: source.slice(bodyStart), trailer: "" });
  }
  return units;
}

/** Re-join units, substituting any replacement supplied by index. */
export function reassemble(
  units: readonly RepairUnit[],
  replacements: ReadonlyMap<number, string>,
): string {
  return units
    .map((unit, index) => (replacements.get(index) ?? unit.body) + unit.trailer)
    .join("");
}

function numberedListing(units: readonly RepairUnit[]): string {
  return units.map((unit, index) => `${index + 1}. ${unit.body}`).join("\n");
}

/**
 * The corrections pass for a turn, or null when this turn is not a candidate —
 * not a repair ask, no pasted block, or a paste too small or too large to be
 * worth numbering. Null means "use today's path", never "do nothing".
 */
export function buildSentenceRepairPass(turnText: string): SentenceRepairPass | null {
  if (!isTextRepairAsk(turnText)) return null;

  const paste = pastedBlock(turnText);
  if (paste.length < MIN_PASTE_CHARS) return null;

  const units = segmentForRepair(paste);
  if (units.length < MIN_UNITS || units.length > MAX_UNITS) return null;
  if (units.some((unit) => unit.body.trim().length === 0)) return null;

  // The person's own instruction is kept verbatim and placed first: it is
  // where constraints like "dont change the way i say things ok" live, and
  // they are the user's to state, not ours to paraphrase.
  const instruction = askPrefix(turnText) || instructionParagraph(turnText);

  return {
    units,
    systemInstruction:
      "The user has pasted their own writing and asked for the mistakes in it to be corrected. "
      + "Their text is given to you as numbered lines. "
      + "Reply with ONLY the lines that contain a mistake, one per line, in the form "
      + "`<number>: <corrected line>`. "
      + "Leave every other line out of your reply — a line you do not mention is kept exactly as they wrote it. "
      + "Correct only what is wrong. Keep their words, their order and their way of saying things. "
      + "Do not explain your changes, do not add a summary, and do not reply with the whole text.",
    userPrompt:
      `${instruction}\n\n${numberedListing(units)}\n\n`
      + "Reply with only the numbered lines that need correcting, "
      + "in the form `<number>: <corrected line>`.",
    generationOptions: {
      temperature: 0.2,
      top_p: 0.6,
      max_new_tokens: Math.min(
        MAX_NEW_TOKENS,
        Math.max(MIN_NEW_TOKENS, units.length * TOKENS_PER_UNIT),
      ),
    },
  };
}

/**
 * A numbered correction line. Tolerant about the shape the model writes it in
 * — "3: ", "3. ", "3) ", "<3>: ", "[3]: ", with or without a bullet — because
 * the number is the only part that has to be right, and strict parsing throws
 * away corrections over punctuation.
 *
 * ★ THE ANGLE BRACKETS ARE NOT HYPOTHETICAL. A first live run measured this
 * path falling back on 8 of 9 repair samples, which read exactly like "a 2B
 * model cannot produce this format". It could: it was writing `<3>: …` and the
 * parser was dropping every line. The lesson is the cheap one — read what the
 * model actually emitted before concluding anything about what it can do.
 */
const CORRECTION_LINE_RE =
  /^\s*(?:[-*+•]\s*)?(?:<(\d{1,3})>|\[(\d{1,3})\]|(\d{1,3}))\s*[:.)\]]\s+(.+?)\s*$/;

/**
 * A change-note the model appends to a corrected line — `(Corrected "lose" to
 * "lost")`, `(Kept as written)`. Substituting one into the person's text would
 * put our commentary inside their note to their son's teacher.
 *
 * ★ MATCHED ON THE ANNOTATION VERB, NEVER ON "ENDS IN A PARENTHESIS". The
 * birthday caption ends a line with `(ur not slick)` — her words. A rule that
 * stripped any trailing bracket would delete them.
 */
const CHANGE_NOTE_RE =
  /\s*\((?:corrected|changed|removed|added|kept|fixed|replaced|no change|unchanged|left)\b[^()]*\)\s*$/i;

/**
 * Apply the model's corrections to the person's text.
 *
 * Lines that are not numbered corrections — a preface, a closing note, a code
 * fence — are ignored rather than treated as failure: the model adding "Here
 * are the corrections:" is not a reason to throw away the corrections. A
 * number outside the range is dropped on its own. Only a reply with no usable
 * numbered line at all falls back.
 */
export function applySentenceRepair(
  pass: SentenceRepairPass,
  modelOutput: string,
): SentenceRepairOutcome {
  const replacements = new Map<number, string>();
  let sawNumberedLine = false;

  for (const line of modelOutput.split("\n")) {
    const match = CORRECTION_LINE_RE.exec(line);
    if (!match) continue;
    sawNumberedLine = true;
    const index = Number(match[1] ?? match[2] ?? match[3]) - 1;
    const body = match[4]!.replace(CHANGE_NOTE_RE, "");
    if (index < 0 || index >= pass.units.length) continue;
    if (body.length === 0) continue;
    // First mention wins: a model that repeats a number is drifting, and the
    // first answer is the one it gave before it started drifting.
    if (replacements.has(index)) continue;
    replacements.set(index, body);
  }

  if (replacements.size === 0) {
    return { status: "fallback", reason: sawNumberedLine ? "no-usable-numbers" : "no-numbered-lines" };
  }

  return {
    status: "applied",
    text: reassemble(pass.units, replacements),
    replaced: replacements.size,
    total: pass.units.length,
  };
}
