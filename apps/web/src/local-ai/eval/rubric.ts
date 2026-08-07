// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Automated rubric scoring for the eval harness.
 *
 * Pure functions: given a prompt spec and the model's output (plus minimal
 * generation context), produce deterministic 0..1 sub-scores. The harness
 * applies only the checks whose spec fields are present; the rest stay `null`.
 *
 * Judge dimensions (coherence, taskFit) are deliberately left `null` here —
 * a human or LLM judge fills them later. Likewise `appropriateUncertainty`
 * is a WEAK heuristic that a judge confirms (see scoreUncertaintyHeuristic).
 */

import { hasCjkScript } from '../../lib/cjk-script';
import type { EvalPromptSpec, RubricContext, RubricScores } from './types';

// ─── small helpers ───────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Lowercase + collapse runs of whitespace to a single space, trimmed. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function ngrams(tokens: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Escape a literal string for use inside a RegExp, then build a whole-token
 * matcher. Tokens may contain spaces/punctuation (e.g. "5 cents"), so we
 * anchor on `\w` boundaries via lookarounds rather than `\b`. This keeps
 * numbers from matching as substrings of a longer number ("408" is NOT inside
 * "1408" because the leading "4" is preceded by the word char "1"), while
 * still allowing ordinary trailing punctuation ("Paris." matches "paris").
 */
function wholeTokenRegex(token: string): RegExp {
  const escaped = token.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\w)${escaped}(?!\\w)`, 'i');
}

function matchesWholeToken(haystack: string, token: string): boolean {
  return wholeTokenRegex(token).test(haystack);
}

// ─── repetition ──────────────────────────────────────────────────────────

/**
 * A line that's pure divider punctuation (---, ***, ___, or a spaced variant
 * like "- - -") carries no content — using one to separate sections three
 * times over a long reply is normal Markdown structure, not the degenerate
 * loop the line-repeat cap exists to catch.
 */
const DIVIDER_LINE_RE = /^([-*_=~])(?:\s?\1)+$/;

/**
 * Word-level repetition score. 1.0 = no repetition, →0.0 = severe loop.
 *
 * Method (deterministic):
 *   - Tokenize on whitespace. If <8 words, return 1.0 (too short to judge).
 *   - ratio = 1 - uniqueTrigrams/totalTrigrams; score = clamp(1 - 2*ratio, 0, 1).
 *   - Hard cap at 0.3 if any single non-empty line repeats >=3x, OR any word
 *     4-gram repeats >=4x (catches degenerate loops the trigram ratio softens).
 *     Pure-punctuation divider lines are exempt from the line-repeat cap.
 */
export function scoreRepetition(text: string): number {
  const tokens = words(text);
  if (tokens.length < 8) return 1;

  const trigrams = ngrams(tokens, 3);
  let ratio = 0;
  if (trigrams.length > 0) {
    const unique = new Set(trigrams).size;
    ratio = 1 - unique / trigrams.length;
  }
  let score = clamp(1 - 2 * ratio, 0, 1);

  // Hard caps for degenerate loops.
  const lineCounts = new Map<string, number>();
  for (const line of nonEmptyLines(text)) {
    if (DIVIDER_LINE_RE.test(line)) continue;
    lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  }
  const lineRepeats = [...lineCounts.values()].some((c) => c >= 3);

  const fourgramCounts = new Map<string, number>();
  for (const g of ngrams(tokens, 4)) {
    fourgramCounts.set(g, (fourgramCounts.get(g) ?? 0) + 1);
  }
  const fourgramRepeats = [...fourgramCounts.values()].some((c) => c >= 4);

  if (lineRepeats || fourgramRepeats) {
    score = Math.min(score, 0.3);
  }
  return score;
}

// ─── canned / template leakage ─────────────────────────────────────────────

/**
 * Disclaimer + chat-template/role-tag patterns that should never reach the
 * user. Exported so the harness and tests can introspect the rule set.
 */
export const CANNED_LEAKAGE_PATTERNS: RegExp[] = [
  /as an ai/i,
  /as a language model/i,
  /as an artificial intelligence/i,
  /i am just an ai/i,
  /i'm just an ai/i,
  /i cannot provide/i,
  /i cannot and will not/i,
  /i do not have personal/i,
  /i don't have personal feelings/i,
  // template / role leakage
  /<\|[a-z0-9_]+\|>/i,
  /^\s*(system|assistant|user)\s*:/im,
];

/**
 * 1.0 if clean. Each DISTINCT pattern that matches costs 0.34; floored at 0.
 */
export function scoreCannedLeakage(text: string): number {
  let hits = 0;
  for (const pattern of CANNED_LEAKAGE_PATTERNS) {
    if (pattern.test(text)) hits++;
  }
  return Math.max(0, 1 - 0.34 * hits);
}

// ─── think-tag leakage ─────────────────────────────────────────────────────

/** 0 if a <think> / </think> tag leaked into the visible text, else 1. */
export function scoreThinkLeakage(text: string): number {
  return /<\/?think>/i.test(text) ? 0 : 1;
}

// ─── CJK script leakage ────────────────────────────────────────────────────

/**
 * The CJK predicate moved to `lib/cjk-script.ts` so the runtime's
 * deterministic CJK-token suppression gate (runtime/cjk-suppression.ts) and
 * this rubric dimension share ONE definition of "CJK script" — the instrument
 * must measure exactly what the fix suppresses. Re-exported so harness/tests
 * keep their import site.
 */
export { hasCjkScript } from '../../lib/cjk-script';

/**
 * Detects the multilingual-model CJK leak (e.g. Qwen3.5 emitting "甲烷" mid-
 * English; see local-model-generation-profiles QWEN35_GEN). 0 when the OUTPUT
 * contains CJK script while the PROMPT-side text (this turn's prompt + any
 * replayed history the check can see) contains NONE; 1 otherwise.
 *
 * A genuinely CJK conversation (CJK anywhere in the prompt/history) legitimately
 * yields CJK output, so the check returns 1 there — it never penalizes an
 * on-language reply. Always computed (no spec gating).
 */
export function scoreCjkLeak(spec: EvalPromptSpec, text: string): number {
  if (!hasCjkScript(text)) return 1;
  const promptSide = [spec.prompt, ...(spec.history ?? []).map((t) => t.content)].join('\n');
  // CJK in output is legitimate when the prompt side already speaks CJK.
  return hasCjkScript(promptSide) ? 1 : 0;
}

// ─── exactness ─────────────────────────────────────────────────────────────

/**
 * Whole-token any-of match against `expectedAnswers`, guarded by
 * `forbiddenAnswers`. null when the spec defines no `expectedAnswers`.
 *
 *   - 1   if any expected matches and no forbidden matches
 *   - 0.5 if an expected AND a forbidden both match
 *   - 0   if no expected matches
 */
export function scoreExactness(spec: EvalPromptSpec, text: string): number | null {
  if (!spec.expectedAnswers || spec.expectedAnswers.length === 0) return null;
  const haystack = normalize(text);

  const expectedHit = spec.expectedAnswers.some((a) => matchesWholeToken(haystack, a));
  const forbiddenHit = (spec.forbiddenAnswers ?? []).some((a) => matchesWholeToken(haystack, a));

  if (!expectedHit) return 0;
  return forbiddenHit ? 0.5 : 1;
}

// ─── format adherence ──────────────────────────────────────────────────────

/**
 * Find the first balanced `{...}` substring, or null if none.
 *
 * NOTE: the depth counter does not skip string contents, so a JSON string
 * value containing a literal `}` truncates extraction early (false negative).
 * The current prompt set never elicits such output; revisit if it does.
 */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Format check. null unless `requireCodeBlock` or `requireJsonKeys` is set.
 *
 *   CodeBlock: 1 if a ```fenced block``` is present, else 0.
 *   JsonKeys:  1 if the first balanced object parses and has all keys,
 *              0.5 if it parses but is missing some, 0 if none parses.
 */
export function scoreFormat(spec: EvalPromptSpec, text: string): number | null {
  if (!spec.requireCodeBlock && !spec.requireOnlyCodeBlock && !spec.requireJsonKeys) return null;

  if (spec.requireCodeBlock || spec.requireOnlyCodeBlock) {
    const hasCodeBlock = /```[\s\S]*?```/.test(text);
    if (spec.requireOnlyCodeBlock) return isOnlyFencedCodeBlock(text) ? 1 : 0;
    return hasCodeBlock ? 1 : 0;
  }

  // requireJsonKeys
  const keys = spec.requireJsonKeys ?? [];
  const candidate = firstBalancedObject(text);
  if (candidate === null) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return 0;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 0;
  const present = Object.keys(parsed as Record<string, unknown>);
  const hasAll = keys.every((k) => present.includes(k));
  return hasAll ? 1 : 0.5;
}

// ─── instruction following ─────────────────────────────────────────────────

/** Strip surrounding quotes, markdown emphasis, and trailing punctuation. */
function stripDecoration(text: string): string {
  let t = text.trim();
  // Strip surrounding matched quotes (straight or smart) and backticks.
  t = t.replace(/^["'`“‘]+/, '').replace(/["'`”’]+$/, '');
  // Strip surrounding markdown emphasis markers.
  t = t.replace(/^[*_]+/, '').replace(/[*_]+$/, '');
  // Strip trailing sentence punctuation.
  t = t.replace(/[.!?,;:]+$/, '');
  return t.trim();
}

/**
 * NOTE: naive sentence splitter — abbreviations ("Dr.", "e.g.") and decimals
 * over-count. Backstopped by the judge dims (taskFit/coherence); do not treat
 * the count as authoritative.
 */
function countSentences(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  // Split on sentence-final punctuation followed by whitespace; the trailing
  // fragment (or a single unterminated sentence) still counts as one.
  const parts = trimmed
    .split(/[.!?]+\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Math.max(1, parts.length);
}

const BULLET_LINE_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\u2022\s+)/m;
const FENCED_CODE_BLOCK_RE = /^\s*```[\s\S]*```\s*$/;

function isOnlyFencedCodeBlock(text: string): boolean {
  const trimmed = text.trim();
  if (!FENCED_CODE_BLOCK_RE.test(trimmed)) return false;
  return (trimmed.match(/```/g) ?? []).length === 2;
}

/**
 * Instruction-following. null unless `exactReply`, `maxSentences`,
 * `requireLineCount`, or `forbidBullets` is set. When multiple apply, returns
 * the minimum.
 *
 *   exactReply:       1 if equal (case-insensitive, decoration-stripped),
 *                     0.5 if the token is present but extra text was added, else 0.
 *   maxSentences:     1 if <= max, else graduated (max/count).
 *   requireLineCount: 1 if equals N, else max(0, 1 - 0.5*abs(count-N)).
 *   forbidBullets:    1 if no bullet/list marker appears at line start, else 0.
 */
export function scoreInstructionFollowing(
  spec: EvalPromptSpec,
  text: string,
): number | null {
  const checks: number[] = [];

  if (spec.exactReply !== undefined) {
    const target = stripDecoration(spec.exactReply).toLowerCase();
    const stripped = stripDecoration(text).toLowerCase();
    if (stripped === target) {
      checks.push(1);
    } else if (matchesWholeToken(normalize(text), spec.exactReply)) {
      checks.push(0.5);
    } else {
      checks.push(0);
    }
  }

  if (spec.maxSentences !== undefined) {
    const count = countSentences(text);
    checks.push(count <= spec.maxSentences ? 1 : clamp(spec.maxSentences / count, 0, 1));
  }

  if (spec.requireLineCount !== undefined) {
    const lines = nonEmptyLines(text);
    const count = lines.length;
    const lineCountScore = count === spec.requireLineCount
      ? 1
      : Math.max(0, 1 - 0.5 * Math.abs(count - spec.requireLineCount));
    const bulletLineScore = spec.requireBulletLines === true && lines.some((line) => !BULLET_LINE_RE.test(line))
      ? 0
      : 1;
    checks.push(Math.min(lineCountScore, bulletLineScore));
  }

  if (spec.forbidBullets === true) {
    checks.push(BULLET_LINE_RE.test(text) ? 0 : 1);
  }

  if (checks.length === 0) return null;
  return Math.min(...checks);
}

// ─── appropriate uncertainty ───────────────────────────────────────────────

const HEDGE_PATTERNS: RegExp[] = [
  /i don't know/i,
  /i do not know/i,
  /i'm not sure/i,
  /i am not sure/i,
  /i can't verify/i,
  /i cannot verify/i,
  /i don't have access/i,
  /i don't have information/i,
  /no way to know/i,
  /unable to determine/i,
  /i can't know/i,
  /i have no way/i,
];

/**
 * WEAK heuristic for whether the model appropriately hedged/declined.
 * null unless `expectDecline` is set. Returns 1 if any hedge phrase is
 * present, else 0.
 *
 * NOTE: This is intentionally a weak proxy — a model can decline without
 * using these exact phrases, and can hedge while still confabulating. A
 * judge (taskFit) confirms; do not treat this score as authoritative.
 */
export function scoreUncertaintyHeuristic(
  spec: EvalPromptSpec,
  text: string,
): number | null {
  if (!spec.expectDecline) return null;
  return HEDGE_PATTERNS.some((p) => p.test(text)) ? 1 : 0;
}

// ─── answer depth (richness floor) ─────────────────────────────────────────

/**
 * Graduated word-count floor for richness probes. null unless `minWords` is
 * set. min(1, words/minWords) — a FLOOR for catching the terse failure mode
 * ("super short and not helpful"), not a length target: anything at or above
 * the floor scores 1, so verbosity is never rewarded beyond it. Quality of the
 * content is the judge's job (taskFit); this only catches "too thin to help."
 */
export function scoreAnswerDepth(spec: EvalPromptSpec, text: string): number | null {
  if (spec.minWords === undefined) return null;
  if (spec.minWords <= 0) return 1;
  return clamp(words(text).length / spec.minWords, 0, 1);
}

// ─── depth match (answer-shape band) ───────────────────────────────────────

/**
 * Graduated word-count BAND for answer-shape probes (Wave 2.6). null unless
 * `depthBand` is set. Unlike `answerDepth` (floor only), this penalizes BOTH
 * failure directions:
 *
 *   - under-shoot (words < minWords): words/minWords — a stub on a teach-me ask;
 *   - over-shoot  (words > maxWords): maxWords/words — a lecture on a simple ask
 *     (the bake-off "padded READY / lectured on a 3-item list" failure class);
 *   - inside the band (or the band side that's unset): 1.
 *
 * Word count is a deliberate proxy for shape — cheap, deterministic, and
 * direction-correct. It cannot see structure quality (sections vs rambling);
 * the judge dims confirm that. Bands are calibrated per probe and documented
 * in each spec's `notes`.
 */
export function scoreDepthMatch(spec: EvalPromptSpec, text: string): number | null {
  const band = spec.depthBand;
  if (band === undefined) return null;
  const count = words(text).length;
  // Empty output: a floor violation when the band has one; on a ceiling-only
  // band it is NOT a perfect fit — it's no signal at all (null, excluded from
  // means). Other dims (smokePass/taskFit/exactness) own the empty failure.
  if (count === 0) {
    return band.minWords !== undefined && band.minWords > 0 ? 0 : null;
  }
  if (band.minWords !== undefined && band.minWords > 0 && count < band.minWords) {
    return clamp(count / band.minWords, 0, 1);
  }
  if (band.maxWords !== undefined && band.maxWords > 0 && count > band.maxWords) {
    return clamp(band.maxWords / count, 0, 1);
  }
  return 1;
}

// ─── delivers first (does the answer survive the questions?) ───────────────

/**
 * Naive sentence/line splitter that keeps each segment's offset, so a caller can
 * ask what came BEFORE something. Same abbreviation/decimal weaknesses as
 * `countSentences`; both dims that use it are graduated or backstopped by a
 * judge, so an occasional extra boundary costs nothing.
 */
type Segment = { text: string; start: number };

function splitSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  const push = (end: number): void => {
    const seg = text.slice(start, end);
    if (seg.trim().length > 0) out.push({ text: seg, start });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n') {
      push(i);
      start = i + 1;
      continue;
    }
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let j = i;
    while (j + 1 < text.length && '.!?'.includes(text[j + 1]!)) j++;
    const next = text[j + 1];
    if (next === undefined || /\s/.test(next)) {
      push(j + 1);
      start = j + 1;
    }
    i = j;
  }
  push(text.length);
  return out;
}

/**
 * Openers that carry no deliverable. Stripped as a PREFIX rather than dropped as
 * a whole sentence: "Of course, here is a shorter version: Hi Dave, …" is one
 * sentence in which everything after the comma is the answer, and dropping it
 * whole would score a good reply as empty.
 */
export const FILLER_PREFIX_PATTERNS: readonly RegExp[] = [
  /^(?:sure|certainly|absolutely|of course|okay|ok|no problem|no worries|got it|understood)\b[\s!,.…—–-]*/i,
  /^i'?(?:d|ll| would| am|'m)? ?(?:be )?(?:\w+ )?(?:happy|glad|delighted|pleased) to help\b[^.!?]*/i,
  /^(?:i'?m )?happy to help\b[^.!?]*/i,
  /^i can (?:certainly |definitely |absolutely )?help\b[^.!?]*/i,
  /^(?:that'?s a )?great question\b[\s!,.…—–-]*/i,
  /^let'?s (?:dive in|get started|take a look|begin)\b[\s!,.…—–-]*/i,
  /^thanks? (?:for|so much for) (?:asking|sharing|the)\b[^.!?]*/i,
  /^i (?:understand|see)\b[\s!,.…—–-]*/i,
  /^i'?m sorry (?:to hear|for the confusion|about that)\b[^.!?]*/i,
  /^i apologi[sz]e\b[^.!?]*/i,
];

/**
 * Statements that request information from the user without asking a question.
 * These count as interrogation too — otherwise the cheapest way to satisfy the
 * dim would be to drop the question mark, which helps nobody.
 */
export const INFO_REQUEST_PATTERNS: readonly RegExp[] = [
  /\blet me know\b/i,
  /\btell me\b/i,
  /\bsend me\b/i,
  /\bi(?:'ll| will)? ?(?:just )?need to know\b/i,
  /\bbefore i (?:can )?(?:write|start|help|begin|do)\b/i,
  /\bi need (?:a bit )?more (?:detail|info|context)/i,
  /\b(?:a few|some|two|three|four) (?:quick |follow-up )?questions\b/i,
  /\bcould you (?:provide|share|tell|clarify|confirm)\b/i,
  /\bplease (?:provide|share|confirm|specify|clarify)\b/i,
  /\bwhat(?:'s| is) (?:his|her|their|its) name\b/i,
];

const SECOND_PERSON_RE = /\b(?:you|your|you're|youre|yours|u|ur)\b/i;
const TABLE_ROW_RE = /^\s*\|.*\|/m;
const BLOCKQUOTE_RE = /^\s*>/m;
/**
 * Six words of non-filler content. Deliberately low: the floor's job is to stop
 * pleasantries from counting, and the filler stripper already does that. Set it
 * high enough to feel safe and it starts failing the corpus's own good answers —
 * "a bit, yes — mainly 'per my last email'" is a complete, correct verdict in
 * eight words.
 */
const MIN_DELIVERABLE_WORDS = 6;

/** Whether a segment asks the user for something rather than answering them. */
function isUserRequest(segment: string): boolean {
  const trimmed = stripDecoration(segment).trim();
  if (/\?\s*$/.test(segment.trim()) && SECOND_PERSON_RE.test(segment)) return true;
  return INFO_REQUEST_PATTERNS.some((p) => p.test(trimmed));
}

function stripFillerPrefix(sentence: string): string {
  let s = sentence.trim();
  for (let pass = 0; pass < FILLER_PREFIX_PATTERNS.length; pass++) {
    let changed = false;
    for (const pattern of FILLER_PREFIX_PATTERNS) {
      const match = pattern.exec(s);
      if (match && match[0].length > 0) {
        s = s.slice(match[0].length).replace(/^[\s,;:—–-]+/, '');
        changed = true;
      }
    }
    if (!changed) break;
  }
  return s;
}

/**
 * Words of actual content in a chunk: filler prefixes and requests removed.
 *
 * ANY question is excluded, not just the ones aimed at the user. A question is
 * never a deliverable, and counting the unaddressed ones as content let
 * "What's your dog's name? What breed is he?" score as though it had answered —
 * the second question is not addressed to anyone by the letter of the rule, but
 * it is plainly not an answer.
 */
function deliverableWordCount(chunk: string): number {
  let total = 0;
  for (const segment of splitSegments(chunk)) {
    if (/\?\s*$/.test(segment.text.trim())) continue;
    if (isUserRequest(segment.text)) continue;
    total += words(stripFillerPrefix(segment.text)).length;
  }
  return total;
}

/** A code block, table, blockquote or list is a deliverable whatever its length. */
function hasStructuralDeliverable(chunk: string): boolean {
  return (
    /```[\s\S]*?```/.test(chunk) ||
    TABLE_ROW_RE.test(chunk) ||
    BLOCKQUOTE_RE.test(chunk) ||
    BULLET_LINE_RE.test(chunk)
  );
}

function containsDeliverable(chunk: string): boolean {
  return hasStructuralDeliverable(chunk) || deliverableWordCount(chunk) >= MIN_DELIVERABLE_WORDS;
}

/** What `scoreDeliversFirst` saw. Exported so a run can report the counts. */
export type DeliversFirstAnalysis = {
  /** Segments that ask the user for something. */
  requestCount: number;
  /** Character offset of the first such segment, or null. */
  firstRequestAt: number | null;
  deliverableBeforeFirstRequest: boolean;
  deliverableAfterFirstRequest: boolean;
  score: number;
};

/**
 * Did the deliverable survive the questions?
 *
 *   1   — nothing was asked of the user, or a deliverable precedes the first ask;
 *   0.5 — the reply asks first but still delivers in the same turn;
 *   0   — it asks and never delivers. The corpus writes this bounce forty ways,
 *         and every one of them ends "…before writing anything".
 *
 * NOT first-sentence position. A two-word preamble ahead of a real answer is not
 * a defect, and a dim that scored it as one would be measuring politeness.
 */
export function analyzeDeliversFirst(text: string): DeliversFirstAnalysis {
  const segments = splitSegments(text);
  const requests = segments.filter((s) => isUserRequest(s.text));
  const first = requests[0];

  if (first === undefined) {
    return {
      requestCount: 0,
      firstRequestAt: null,
      deliverableBeforeFirstRequest: containsDeliverable(text),
      deliverableAfterFirstRequest: false,
      score: 1,
    };
  }

  const before = containsDeliverable(text.slice(0, first.start));
  const after = containsDeliverable(text.slice(first.start + first.text.length));
  return {
    requestCount: requests.length,
    firstRequestAt: first.start,
    deliverableBeforeFirstRequest: before,
    deliverableAfterFirstRequest: after,
    score: before ? 1 : after ? 0.5 : 0,
  };
}

/** null unless the spec sets `expectDeliverable`. */
export function scoreDeliversFirst(spec: EvalPromptSpec, text: string): number | null {
  if (!spec.expectDeliverable) return null;
  return analyzeDeliversFirst(text).score;
}

// ─── preserves user text (the n-gram-ban readout) ──────────────────────────

/**
 * The block the user PASTED, as opposed to what they typed around it: real
 * inputs separate the two with a blank line, and the typed ask can sit at
 * EITHER end — "does this sound rude\n\nPer my last email …" puts it first, a
 * pasted chat thread followed by "tldr" puts it last. With no blank line the
 * whole input is the pasted text.
 *
 * ★ THE CONSTRAINT THE RULE HAS TO SATISFY: the block returned must CONTAIN the
 * words a caller is looking for. Hand back the ask instead and a reply that
 * preserved every word of the paste measures as though it preserved none — the
 * ask is a handful of tokens, so overlap against it is near zero whatever the
 * model did. Over-including the ask is the milder error (it can only lengthen a
 * match, never shorten one), so the rule drops an end block only when it is the
 * minority of the turn, and otherwise falls back to the whole input.
 *
 * Lives here rather than beside the probe derivation so the instrument and the
 * probes share ONE definition of "the text the user handed us" — the same reason
 * the CJK predicate is shared with the runtime's suppression gate.
 */
export function pastedBlockOf(userInput: string): string {
  const blocks = userInput.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  if (blocks.length < 2) return userInput;

  const size = (parts: readonly string[]): number => words(parts.join(' ')).length;
  const afterFirst = blocks.slice(1);
  const beforeLast = blocks.slice(0, -1);

  if (size([blocks[0]!]) < size(afterFirst)) return afterFirst.join('\n\n');
  if (size([blocks[blocks.length - 1]!]) < size(beforeLast)) return beforeLast.join('\n\n');
  return userInput;
}

/**
 * Whitespace tokens, lowercased, with surrounding punctuation trimmed but
 * INTERNAL punctuation kept: "£45," → "£45" and "1,450.00" survives intact,
 * because reproducing a figure exactly is the whole point on these items.
 */
export function tokenizeForReuse(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}£$€%]+/u, '').replace(/[^\p{L}\p{N}%]+$/u, ''))
    .filter((t) => t.length > 0);
}

/** Guard against a pathological prompt turning an O(n·m) scan into a hang. */
const MAX_REUSE_TOKENS = 4000;

/** Longest run of tokens appearing contiguously in BOTH sequences. */
export function longestCommonTokenSpan(a: readonly string[], b: readonly string[]): number {
  const left = a.length > MAX_REUSE_TOKENS ? a.slice(0, MAX_REUSE_TOKENS) : a;
  const right = b.length > MAX_REUSE_TOKENS ? b.slice(0, MAX_REUSE_TOKENS) : b;
  if (left.length === 0 || right.length === 0) return 0;

  let best = 0;
  let previous = new Int32Array(right.length + 1);
  let current = new Int32Array(right.length + 1);
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      if (left[i - 1] === right[j - 1]) {
        const run = previous[j - 1]! + 1;
        current[j] = run;
        if (run > best) best = run;
      } else {
        current[j] = 0;
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return best;
}

/**
 * Span length that scores a full 1.0 — roughly a clause. The values this dim
 * exists to tell apart are all below it and stay on distinct points: a
 * prompt-inclusive ban at n=3 caps the span at 2 (0.25), n=4 caps it at 3
 * (0.375), and an unbanned model reproducing a phrase clears 8 (1.0).
 */
const REUSE_SPAN_TARGET = 8;

/**
 * Fraction of the OUTPUT covered by one single copied span, above which the
 * reply is a copy rather than a response.
 *
 * 0.7 rather than something near 1.0 because of what it has to catch: echoing
 * the input and appending a sentence is the cheapest way to satisfy a reuse
 * metric without doing the task. It is safe at 0.7 because every good-answer
 * shape this dim applies to shatters long spans — an edit, a table, a summary
 * and a translation all interleave new tokens, so their single-span coverage
 * sits far below it.
 */
const ECHO_COVERAGE = 0.7;

/** What `scorePreservesUserText` saw. */
export type PreservesUserTextAnalysis = {
  longestSpan: number;
  outputTokens: number;
  /** The reply is a copy of the input rather than a response to it. */
  echo: boolean;
  score: number;
};

export function analyzePreservesUserText(
  userText: string,
  output: string,
): PreservesUserTextAnalysis {
  const userTokens = tokenizeForReuse(pastedBlockOf(userText));
  const outputTokens = tokenizeForReuse(output);
  const longestSpan = longestCommonTokenSpan(userTokens, outputTokens);
  const echo = outputTokens.length > 0 && longestSpan / outputTokens.length >= ECHO_COVERAGE;
  return {
    longestSpan,
    outputTokens: outputTokens.length,
    echo,
    score: echo ? 0 : clamp(longestSpan / REUSE_SPAN_TARGET, 0, 1),
  };
}

/**
 * How much of the user's own phrasing came back. null unless the spec sets
 * `expectUserTextReuse`.
 *
 * ★ The only dim that can read out a PROMPT-INCLUSIVE n-gram ban: Transformers.js
 * applies `no_repeat_ngram` across the full sequence, prompt included, so with
 * n set the model is hard-banned from copying n consecutive prompt tokens at
 * every position. Nothing else in the rubric can see that, which is why "does
 * the ban cost us anything?" has never been answerable.
 *
 * Read it COMPARATIVELY — the delta between arms. The absolute level is not a
 * grade: an answer can be excellent while quoting only a figure or two.
 */
export function scorePreservesUserText(spec: EvalPromptSpec, text: string): number | null {
  if (!spec.expectUserTextReuse) return null;
  return analyzePreservesUserText(spec.prompt, text).score;
}

// ─── preserves facts (the OTHER half of faithful reproduction) ─────────────

/**
 * ★ WHY THIS IS NOT A SPAN MEASURE.
 *
 * `preservesUserText` above reads a longest-common-span, which means what its
 * name says on exactly one kind of job: the ones where handing the user's own
 * WORDING back IS the deliverable. On the other kind — a summary, a tone
 * rewrite, a hospital letter translated out of jargon — the wording is supposed
 * to CHANGE and only the facts have to survive. There a long shared span often
 * means the model failed: `health-hospital-letter` bounces on "Parrots the
 * jargon back with a definition list", which is precisely the answer a span
 * score rewards.
 *
 * So this dim measures ENTITY AND FIGURE SURVIVAL instead: pull the concrete
 * facts out of the block the user pasted, then ask how many of them are still
 * in the answer. A good summary that keeps "£25", "£180", "7 not 8" and the
 * names but reformats the whole thing into bullets scores 1.0.
 *
 * ★★ IT IS ONE-SIDED AND STAYS ONE-SIDED. It scores fact survival only. A
 * verbatim parrot of the paste therefore scores 1.0 BY DESIGN — parroting is a
 * failure of a different kind, and the dims that own it are `depthMatch` (a
 * summary as long as the thread breaches the ceiling), `preservesUserText`'s
 * echo guard on the wording items, and the judge. Teaching this dim to also
 * score "and explained it well" would be a second spec bug wearing a better
 * name; the previous one cost a whole gate.
 */

/** What kind of fact was lifted out of the user's pasted block. */
export type PreservedFactKind = 'number' | 'date' | 'name';

export type PreservedFact = {
  kind: PreservedFactKind;
  /** As it appears in the paste. For reporting and pinning — never for matching. */
  text: string;
  /** What presence is tested against: a normalized value, or a lowercased word. */
  key: string;
};

/**
 * Month and weekday names, matched case-insensitively because real pastes write
 * them both ways ("Friday 8 August" in a school letter, "that was october" in a
 * column of expenses).
 *
 * ⚠ `may` is deliberately ABSENT. It is a modal verb far more often than it is a
 * month, and a false fact costs more than a missed one here: a fact nobody
 * extracted is simply not scored, whereas a fact that was never a fact penalizes
 * every answer that sensibly left it out. Every guard in this dim fails toward
 * extracting LESS.
 */
const DATE_WORDS: readonly string[] = [
  'january', 'february', 'march', 'april', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

/**
 * ⚠ Assembled with `+` rather than a template literal: an interpolated regex
 * const is folded wrong by Turbopack and only `next build` catches it.
 */
const DATE_WORD_PATTERN =
  '(?<![\\p{L}\\p{N}])(?:' + DATE_WORDS.join('|') + ')(?![\\p{L}\\p{N}])';

/**
 * A digit run, kept whole: `1,450.00`, `342.19`, `07:00`, `14/7`, `3/4`, and the
 * `6` of `6mm`. Anchored on digits at both ends so ordinary trailing punctuation
 * ("…£45.") never joins the token.
 */
const NUMERIC_TOKEN_PATTERN = '\\d[\\d,.:/]*\\d|\\d';

/**
 * A template SLOT the writer left for someone else to fill: `[Teacher]`,
 * `[Son]`, `[Your Name]`, `[INSERT DETAIL]`. One line, no nesting — a bracket
 * pair spanning a newline is punctuation, not a slot.
 *
 * ★ WHY A SLOT IS THE OPPOSITE OF A FACT, WITH THE NUMBERS THAT SHOW IT.
 * `convo-teacher-email-resend` carries the drafted email forward, and that draft
 * reads "Hi [Teacher] — … [Son] will be out Thursday and Friday". Read as facts,
 * `Teacher` joins `Thursday` and `Friday` in the denominator — so the answer that
 * hands the email back with the real names in it ("Ms. Patel", "Ben") scored
 * 0.667 while a verbatim parrot that left the brackets alone scored 1.000. The
 * dim ranked the mechanical reply ABOVE the one the corpus asks for, and the
 * bounce condition names filling the slots as the whole job: "she … just needs
 * the same message with Thursday and Friday in it".
 *
 * So a token inside a slot is dropped before it can become a fact. This fails in
 * the same direction as every other guard here — toward extracting LESS.
 */
const PLACEHOLDER_SLOT_PATTERN = '\\[[^\\[\\]\\n]*\\]';

/** Half-open [start, end) ranges of every template slot in the text. */
function placeholderSlotRanges(text: string): readonly (readonly [number, number])[] {
  return [...text.matchAll(new RegExp(PLACEHOLDER_SLOT_PATTERN, 'g'))].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
}

/**
 * A Titlecase word, whole-token. `\p{Ll}{2,}` (so, three characters minimum)
 * excludes "I" and — deliberately — ALL-CAPS acronyms: "CT", "TSH" and "NOTICE
 * OF RENT INCREASE" are exactly the jargon a plain-English translation is
 * supposed to drop, so requiring them would penalize the good answer. The
 * lookarounds also drop internal-caps compounds like "ParentPay".
 */
const NAME_CANDIDATE_PATTERN = '(?<![\\p{L}\\p{N}])\\p{Lu}\\p{Ll}{2,}(?![\\p{L}\\p{N}])';

/**
 * The value a digit run is compared on. Thousands separators are stripped and
 * the rest is read as a NUMBER, so "£1,450.00" and "1450" are the same fact —
 * dropping a comma is a reformat, not a corruption. Anything holding a `/` or a
 * `:` (a date, a time, a fraction) has no single value, so it is compared as the
 * literal string.
 *
 * ★ This is what makes a corrupted figure a MISS: "332,062" normalizes to
 * 332062, which is not 332026, so the fact is simply absent.
 */
function numericFactKey(raw: string): string | null {
  if (raw.includes('/') || raw.includes(':')) return raw;
  const ungrouped = raw.replace(/,/g, '');
  // Two or more dots is a version/reference string, not a quantity.
  if ((ungrouped.match(/\./g) ?? []).length > 1) return raw;
  const value = Number(ungrouped);
  return Number.isFinite(value) ? String(value) : null;
}

/** Skipped when looking back for the end of the previous sentence. */
const OPENING_PUNCTUATION = '("\'“‘[';

/**
 * Whether the word starting at `index` opens a sentence or a line. Used to drop
 * capitalized function words ("The witches…", "In conclusion…", "Please be
 * advised…") without a stopword list, which would have to be maintained and
 * argued about. A word that ALSO appears mid-sentence is kept — that occurrence
 * is the evidence it is a name.
 */
function opensSentence(block: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = block[i]!;
    if (ch === '\n') return true;
    if (/\s/.test(ch)) continue;
    if (OPENING_PUNCTUATION.includes(ch)) continue;
    return ch === '.' || ch === '!' || ch === '?';
  }
  return true;
}

/**
 * A chat transcript's speaker label ("Tom: yes ill sort it"). These are line
 * initial and never appear mid-sentence, so the rule above would drop every name
 * in a pasted group chat — which is the one paste in this corpus made almost
 * entirely OF names.
 */
function isSpeakerLabel(block: string, index: number, length: number): boolean {
  return block[index + length] === ':' && opensSentence(block, index);
}

/**
 * The concrete facts in a pasted block, in appearance order: figures first, then
 * dates, then names. Deduplicated by key, so a figure quoted twice is one fact.
 *
 * ⚠ HONEST ABOUT ITS PRECISION. It over-extracts institutional Titlecase nouns
 * ("Key Stage 2", "Appendix B") and under-extracts names the writer never
 * capitalized ("has anyone told steve"). Both are visible rather than hidden:
 * `everyday-probes.test.ts` pins the extracted list for every gated item, so the
 * denominator can be read and argued with. Over-extraction inflates the
 * denominator identically in every arm, which is why this dim is read as a delta
 * and why its absolute level is not a grade.
 *
 * Template slots are the one over-extraction that is NOT harmless, because it
 * inverts the ranking rather than inflating both arms — see
 * `PLACEHOLDER_SLOT_PATTERN`.
 */
export function extractFacts(pasted: string): readonly PreservedFact[] {
  const facts: PreservedFact[] = [];
  const seen = new Set<string>();
  const slots = placeholderSlotRanges(pasted);
  const inSlot = (index: number): boolean =>
    slots.some(([start, end]) => index >= start && index < end);
  const push = (kind: PreservedFactKind, text: string, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ kind, text, key });
  };

  for (const match of pasted.matchAll(new RegExp(NUMERIC_TOKEN_PATTERN, 'g'))) {
    if (inSlot(match.index)) continue;
    const key = numericFactKey(match[0]);
    if (key !== null) push('number', match[0], key);
  }

  for (const match of pasted.matchAll(new RegExp(DATE_WORD_PATTERN, 'giu'))) {
    if (inSlot(match.index)) continue;
    push('date', match[0], match[0].toLowerCase());
  }

  for (const match of pasted.matchAll(new RegExp(NAME_CANDIDATE_PATTERN, 'gu'))) {
    const index = match.index;
    if (inSlot(index)) continue;
    if (opensSentence(pasted, index) && !isSpeakerLabel(pasted, index, match[0].length)) continue;
    push('name', match[0], match[0].toLowerCase());
  }

  return facts;
}

/** Every figure the OUTPUT contains, normalized the same way the facts were. */
function outputNumericKeys(output: string): Set<string> {
  const keys = new Set<string>();
  for (const match of output.matchAll(new RegExp(NUMERIC_TOKEN_PATTERN, 'g'))) {
    const key = numericFactKey(match[0]);
    if (key !== null) keys.add(key);
  }
  return keys;
}

/** What `scoreFactPreservation` saw. */
export type FactPreservationAnalysis = {
  facts: readonly PreservedFact[];
  /** The facts that did not survive — dropped outright, or corrupted. */
  missing: readonly PreservedFact[];
  /** null when the paste carried no facts at all: no signal, not a perfect score. */
  score: number | null;
};

/**
 * The facts that did not survive: figures compared on their normalized VALUE,
 * dates and names on a whole token. Shared by the single-turn dim and its
 * conversation sibling below so the two can never drift on what "survived" means.
 */
function factsMissingFrom(
  facts: readonly PreservedFact[],
  output: string,
): readonly PreservedFact[] {
  const numericKeys = outputNumericKeys(output);
  const haystack = normalize(output);
  return facts.filter((fact) =>
    fact.kind === 'number'
      ? !numericKeys.has(fact.key)
      : !matchesWholeToken(haystack, fact.key),
  );
}

export function analyzeFactPreservation(
  userText: string,
  output: string,
): FactPreservationAnalysis {
  const facts = extractFacts(pastedBlockOf(userText));
  if (facts.length === 0) return { facts, missing: [], score: null };

  const missing = factsMissingFrom(facts, output);
  return { facts, missing, score: (facts.length - missing.length) / facts.length };
}

/**
 * Did the user's own figures, dates and names survive the answer? null unless
 * the spec sets `expectFactPreservation`.
 *
 * A verbatim parrot of the paste scores 1.0 — deliberately. See the block
 * comment at the top of this section: this dim is one-sided on purpose, and the
 * parrot is other dims' failure to catch.
 */
export function scoreFactPreservation(spec: EvalPromptSpec, text: string): number | null {
  if (!spec.expectFactPreservation) return null;
  return analyzeFactPreservation(spec.prompt, text).score;
}

// ─── preserves HISTORY facts (the conversation half) ───────────────────────

/**
 * ★ WHY A SECOND FACT DIM, AND WHY IT CANNOT DERIVE ITS OWN WINDOW.
 *
 * `preservesFacts` above reads `spec.prompt`, and in a conversation the words
 * that have to survive are almost never in the probed turn — they are in a paste
 * eight turns up, a bill list two turns up, or a draft the assistant wrote four
 * turns up. `everyday-conversation-probes.ts` says exactly this about itself and
 * calls it a gap in the instrument. This dim closes the FACT half of it. (The
 * span half — `preservesUserText` over the history — is still open, and still
 * stated there.)
 *
 * ★★ THE WINDOW IS QUOTED, NOT DERIVED, AND THAT IS THE WHOLE DESIGN PROBLEM.
 * Pointing `extractFacts` at the entire history was tried on paper and is
 * fatally wrong: the teacher-email conversation carries a hotdog argument and a
 * punch recipe (4 1/4 cups, 64 oz, 25 servings) in the turns around the draft,
 * and a PERFECT resend of that email — the answer the corpus asks for — would
 * reproduce none of them. Scored that way the right answer measures near zero.
 * The budget conversation is worse: its history holds £745, the rent figure the
 * probed turn explicitly SUPERSEDES ("use the 790 rent not the old one"), so a
 * whole-history denominator would penalise the answer for obeying the user.
 *
 * So the scope is authored and the facts are derived. The caller hands over
 * verbatim spans of the history (`spec.historyFactSources`); `extractFacts` —
 * the same rule, unchanged — decides what counts as a fact inside them. The
 * author picks WHICH WORDS OF THE RECORD, never which facts, and
 * `everyday-conversation-probes.test.ts` asserts every span is present verbatim
 * in that probe's own history and pins the derived fact list per item, so the
 * denominator can be read and argued with rather than taken on trust.
 *
 * ★ ONE-SIDED, exactly like its sibling. It scores fact survival and nothing
 * else, so a reply that recites "Thursday and Friday" without handing back the
 * email scores 1.0 here. That is not this dim's failure to catch — `answerDepth`,
 * `deliversFirst` and the judge own it. Teaching a fact dim to also grade the
 * shape of the answer is how the previous spec bug happened.
 *
 * ⚠ AND THE NAMED CATCHERS DO NOT ALWAYS CATCH IT — measured, not assumed. Paste
 * the budget conversation's six carried-forward spans back verbatim, as one
 * block, and the automated mean is 1.000: this dim 1.0, `answerDepth` 1.0 (the
 * spans run to 95 words, over the 60-word floor), `deliversFirst` 1.0 (it opens
 * with content). A recital of the record is not an answer, and nothing automated
 * owns it today — the judge is the only thing watching. Stated rather than
 * patched, and pinned as an executing case in
 * `conversation-history-recall-mirror.test.ts`: a recital detector built into a
 * fact dim would be the same spec bug the paragraph above is about.
 *
 * COMPARATIVE, like its sibling: read the delta between arms. The absolute level
 * carries the known imprecision of `extractFacts` (it cannot see a name the user
 * never capitalised — "bridgford road" — and it reads a rounded "£13" for
 * "12.99" as a miss, which it arguably is).
 */
export type HistoryFactPreservationAnalysis = {
  facts: readonly PreservedFact[];
  /** The facts that did not survive — dropped outright, or corrupted. */
  missing: readonly PreservedFact[];
  /** null when the quoted spans carried no facts at all: no signal, not a pass. */
  score: number | null;
};

export function analyzeHistoryFactPreservation(
  sources: readonly string[],
  output: string,
): HistoryFactPreservationAnalysis {
  // Joined with a single newline, never a blank one: `extractFacts` reads line
  // starts as sentence starts (that is what drops "The witches…" from the name
  // list), so each span gets the same treatment it would get on its own line.
  const facts = extractFacts(sources.join('\n'));
  if (facts.length === 0) return { facts, missing: [], score: null };

  const missing = factsMissingFrom(facts, output);
  return { facts, missing, score: (facts.length - missing.length) / facts.length };
}

/**
 * Did the facts this conversation already established come back? null unless the
 * spec names the spans that carry them.
 */
export function scoreHistoryFactPreservation(
  spec: EvalPromptSpec,
  text: string,
): number | null {
  const sources = spec.historyFactSources;
  if (!sources || sources.length === 0) return null;
  return analyzeHistoryFactPreservation(sources, text).score;
}

// ─── honors ruled out (the other shape: a thing that must NOT come back) ───

/**
 * ★ STRUCTURALLY DIFFERENT FROM FACT SURVIVAL, WHICH IS WHY IT IS ITS OWN DIM.
 * "The figure has to reappear" and "the thing they ruled out must not reappear"
 * are opposite tests, and averaging them into one number would let a reply earn
 * back a violated instruction by quoting an extra date.
 *
 * ★★★ THE GATING RULE, AND THE ONLY ONE: a term is gated where TOKEN ABSENCE
 * EQUALS CORRECTNESS. This dim tests presence, not use, so it can only be
 * pointed at a term whose every mention is a mistake. Two shapes of ruled-out
 * thing occur in the corpus and only one of them clears that bar:
 *
 *   - a REFUSED thing — gated. "i dont have a thermometer. thats the whole
 *     problem." The item's own good answer is defined as having "No thermometer
 *     anywhere in the answer", so token absence is not our reading of it, it is
 *     the corpus's, and every mention really is the failure.
 *   - a SUPERSEDED value — NOT gated, and this is a correction. "£745" after
 *     "use the 790 rent not the old one", "saturday" after the party moved to
 *     Sunday, both read as bans until they were run against the answers the
 *     corpus actually wants. `"Rent — £790 (up from £745 in October)"` scored 0,
 *     and so did `"Sunday 8th March, not the Saturday, since you moved it"` —
 *     both correct replies, both flagged, because the bounce is the old value
 *     coming back AS THE ANSWER, which is not what a token check sees. The
 *     violation and the correct reply are indistinguishable to this function.
 *     Descoped rather than patched: see the corpus's `mentionNotViolation`,
 *     which keeps the record and the evidence and takes the wrong check off.
 *
 * ★★ WHY NOT DETECT THE REFUSAL AUTOMATICALLY. A negation parser was the obvious
 * design and it is the wrong one: the same corpus contains "im not giving up the
 * gym before you say it", where the ruled-out reading is exactly BACKWARDS — the
 * gym is a bill that must stay in the list. A pattern set that fires on "not X"
 * would mark the correct answer as a violation. So the term is authored, and the
 * guard against an author inventing one is machine-checked instead:
 * `everyday-conversation-probes.test.ts` requires every ruled-out term to appear
 * in the user sentence quoted as its evidence, by THIS function, and requires
 * that sentence to be verbatim in the probe's own history.
 *
 * ★ WHAT IS DELIBERATELY NOT GATED. The mailable-gift item rules out candles and
 * spa vouchers, and its bounce is a reply that "quietly re-includes" them — but
 * there the failure is RECOMMENDING them, not naming them, and a good reply that
 * opens "skipping the candles you said she throws away" would be flagged. Mention
 * is not violation on that item, so it is left uncovered rather than covered
 * wrongly. That reading was always in this block; the superseded values above
 * belong to the same class and now sit with it.
 *
 * ⚠ WHAT WAS NOT BUILT INSTEAD. A context-aware violation detector — "£745 as
 * the rent value" rather than "£745 anywhere" — needs to know which figure a
 * clause is asserting, which is reading prose, and a dim that measures prose is
 * how the previous spec bug happened. One honest term beats three that flag the
 * right answer. What is left uncovered is stated, in the corpus, per term.
 */

/**
 * Whole-token match tolerating a simple plural: `candle` matches "candles",
 * `surprise` matches "surprises". Deliberately NOT a prefix match — that would
 * make `spa` fire on "Spain" and "spare", and a false violation costs more than
 * a missed one (it penalises the answer that obeyed).
 */
export function mentionsRuledOutTerm(text: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\w)${escaped}(?:e?s)?(?!\\w)`, 'i').test(text);
}

/** What `scoreHonorsRuledOut` saw. */
export type RuledOutAnalysis = {
  terms: readonly string[];
  /** The ruled-out terms the reply used anyway. */
  resurfaced: readonly string[];
  /** null when the spec names no ruled-out terms. */
  score: number | null;
};

export function analyzeRuledOut(
  terms: readonly string[],
  output: string,
): RuledOutAnalysis {
  if (terms.length === 0) return { terms, resurfaced: [], score: null };
  const haystack = normalize(output);
  const resurfaced = terms.filter((term) => mentionsRuledOutTerm(haystack, term));
  return { terms, resurfaced, score: (terms.length - resurfaced.length) / terms.length };
}

/** null unless the spec names ruled-out terms. */
export function scoreHonorsRuledOut(spec: EvalPromptSpec, text: string): number | null {
  const terms = spec.historyRuledOut;
  if (!terms || terms.length === 0) return null;
  return analyzeRuledOut(terms, text).score;
}

// ─── delivers the asked-for artifact ───────────────────────────────────────

/**
 * ★ WHY THIS IS NOT `deliversFirst`, AND WHY BOTH HAVE TO EXIST.
 *
 * `deliversFirst` asks whether a deliverable survived the reply's questions, and
 * its `containsDeliverable` helper counts ANY bullet list, table, blockquote or
 * six words of non-filler prose as one. That is the right instrument for the
 * bounce it was built from — "asks four clarifying questions before writing
 * anything" — and it is blind to the failure this dim measures.
 *
 * Asked mid-conversation to "write the message I send to the family group chat",
 * the shipping default model frequently returns ORGANISER NOTES instead: emoji
 * section headers, a "Next steps" list, "Your 14 guests", a briefing written to
 * the person who asked rather than a message they can paste. All of that is
 * bullets, so `deliversFirst` scores it 1. Measured across thirty real
 * generations on two corpus conversations, `deliversFirst` scored 1 on
 * twenty-nine of them and 0.5 on one, while the asked-for artifact actually
 * arrived in ten.
 *
 * So: `deliversFirst` measures "delivered SOMETHING rather than interrogating".
 * This measures "delivered THE ASKED-FOR THING". The two axes stay apart — the
 * interrogation axis is deliberately NOT re-scored here, and this shape axis is
 * deliberately not folded into there.
 *
 * ── WHAT IT LOOKS FOR, AND WHY THOSE TWO SIGNALS ────────────────────────────
 *
 * A piece of correspondence has two ends: it opens by addressing someone, and it
 * closes by signing off. Notes have neither — they are written ABOUT the event,
 * for the organiser. Over the thirty hand-labelled generations those two ends
 * separate the classes completely, and they separate the BORDERLINE class too:
 *
 *   addressed, with a body    → 1.0   a message somebody could send
 *   signed but never addressed → 0.5  an announcement or flyer: recipient-facing
 *                                     register, but nobody is being written to
 *   neither                    → 0    notes, advice, or a deflection
 *
 * The middle rung was not invented to make a number come out. It is where the two
 * samples a reader independently called borderline landed on their own — an
 * invitation flyer signed "[Your Name]", and an announcement signed
 * "— Organiser" — and it is why the scale is graded rather than binary.
 *
 * ★ IT IS TWO-SIDED, and the mirror cases are pinned in `rubric.test.ts`:
 *
 *   - "Just hit send now." scores 0. A short reply MUST be able to fail, or the
 *     cheapest way to satisfy the dim is to stop writing.
 *   - A delivered draft inside assistant framing — "Here's the version to send:
 *     'Hi [Teacher] — …'" — scores 1. The frame is not the failure; its absence
 *     is not the success.
 *   - Emoji do not fail a group-chat message. Nine of the ten delivered samples
 *     carry markdown, bullets or emoji. The failure is structure and audience,
 *     never tone.
 *   - The corpus's own scripted reply uses "[Your Name]", so a placeholder is not
 *     a defect here. Whether the user's real facts survived is `preservesFacts`.
 *
 * ── THE LIMITS, STATED RATHER THAN ROUNDED OFF ──────────────────────────────
 *
 * Each has an executing case in `artifact-delivery.test.ts`, asserting current
 * behaviour and marked as a limit. A limit that is only described decays.
 *
 * 1. THE ADDRESS ANCHOR CAN BE ACQUIRED CHEAPLY. A reply that opens "Hi
 *    everyone," and then hands over the same organiser notes, unheaded, scores 1.
 *    Nothing in the measured set does that — every notes-shaped sample in thirty
 *    real generations omitted the salutation entirely, and every sample scoring 0
 *    is now asserted to address nobody — so no rule here is founded on it. A
 *    reply BUILT to do it scores 1: salutation, fifteen words, then "**Next
 *    steps:** Send the confirmation to Mum" with the headers left standing. The
 *    headers need no stripping, because the artifact simply ends at the first one.
 * 2. IT CANNOT READ A TWO-LINE TEXT. "Not going to make it in today, food
 *    poisoning" is a perfectly good text to a boss and carries neither end of the
 *    correspondence shape, so this dim would fail it. That is why the annotation
 *    is hand-authored per item and why `work-sick-text` is pinned as an
 *    UNMEASURED artifact ask rather than gated (see `everyday-probes.ts`).
 * 3. IT CANNOT SEE THE AUDIENCE. "Hi Trina," followed by a briefing written to
 *    the person who ASKED — "you will want to chase the two who have not
 *    replied" — is well-formed correspondence to the wrong reader, and scores 1.
 *    Audience matching was rejected in the design and stays rejected: the
 *    annotation's audience is prose, and matching a reply against it would score
 *    the wording of the annotation. The judge owns that axis.
 * 4. A STANDALONE BOLD LABEL INSIDE A MESSAGE TRUNCATES IT. "**Details:**" on
 *    its own line reads as a section boundary, so the message under it falls
 *    outside the artifact and scores 0 on a body of zero words. It is the same
 *    shape as "**Next steps:**", which really is a notes header on the captured
 *    generations, and nothing mechanical separates the two without matching the
 *    words. Left as it is, deliberately: a rule invented to tell those apart
 *    would be founded on nothing.
 *
 * ── ONE WIDENING, RECORDED SO IT IS NOT MISTAKEN FOR TUNING ─────────────────
 *
 * The salutation and sign-off VOCABULARIES were widened once, after the labelled
 * set had already been reproduced, against a further thirty captured generations
 * held out of the tree. Three real forms were being missed: a leading emoji
 * ("👋 Hi everyone,"), an ampersand in the addressee ("Dear family & friends,")
 * and "Warm wishes," as a closer. No threshold and no scoring rule moved — only
 * the word lists, and only in the direction of recognising MORE correspondence,
 * which can raise a score and can never lower one. The labelled set scores
 * identically before and after, which is asserted rather than asserted-to.
 *
 * ── AND ONE ADVERSARIAL PASS, RECORDED THE SAME WAY ─────────────────────────
 *
 * A later pass attacked the dim with replies built to break it, and found two
 * kinds of good answer being failed. Both are fixed above; both are recognition
 * changes, so the thirty hand labels still reproduce exactly.
 *
 *   - THE ADDRESSEE VOCABULARY WAS A BUSINESS LETTER'S. One of the two gated
 *     conversations is a family group chat, and "Hi both," "Hi guys," "Hi mum,"
 *     "Hiya lovely," "Hey you two," "Afternoon everyone," "Evening all," "To the
 *     family," and "Alright everyone," each scored 0 carrying a real 63-word
 *     message, because an addressee had to be Titlecase or one of six
 *     collectives. Widened, with the closed-list guard asserted.
 *   - THE FIRST POLITE LINE WAS BEING READ AS THE SIGNATURE. "Hi Dave," /
 *     "Thanks." / then the whole email scored 0 on a body of zero words. A
 *     sign-off now has to actually END the artifact — see `closesTheArtifact`.
 */

/** Whether the reply carried the artifact, and the two ends that decided it. */
export type ArtifactDeliveryAnalysis = {
  /** The salutation that opens the artifact, verbatim, or null. */
  addressOpening: string | null;
  /** The closing signature line, verbatim, or null. */
  signOff: string | null;
  /** Words of ordinary body between the two ends. */
  bodyWords: number;
  /** Notes-shaped section headings found in the reply, in order. */
  organizerHeadings: readonly string[];
  /**
   * Phrases aimed at the person who ASKED rather than at the audience. REPORTED,
   * NEVER SCORED: every sample carrying one already scores 0 through the address
   * anchor, so letting them move the number would be a counterweight asserted
   * from four strings rather than measured. They exist so a run can say WHY a
   * sample failed.
   */
  requesterDirected: readonly string[];
  score: number;
};

/**
 * Salutations that open a piece of correspondence. `my dear` precedes `dear` and
 * the multi-word forms precede the short ones so the alternation prefers the
 * longest match.
 *
 * The un-prefixed time-of-day forms are here for the same reason `morning`
 * always was: "Afternoon everyone," and "Evening all," are how people open a
 * message, and requiring the "good" would have failed them. `alright` is the
 * same opener in another register, and `to` is the addressed-envelope form
 * ("To the family,").
 */
const SALUTATION_WORDS: readonly string[] = [
  'good morning',
  'good afternoon',
  'good evening',
  'my dear',
  'dear',
  'hello',
  'hiya',
  'hey',
  'morning',
  'afternoon',
  'evening',
  'alright',
  'hi',
  'to',
];

/**
 * Collective forms of address. `everyone`, `all` and `family & friends` are what
 * the captured generations exercise; the rest are the same lexical class and are
 * listed so that a correct answer saying "Hi folks," is not failed by an accident
 * of capitalisation. A Titlecase name ("Dave", "Trina", "Ms."), an ALL-CAPS one
 * ("HI EVERYONE"), and a bracketed placeholder ("[Teacher]") cover the rest.
 * Multi-word entries lead, so the alternation prefers the longest match.
 *
 * ★ THE LOWERCASE COMMON-NOUN ADDRESSEES ARE THE REGISTER OF THE ASKS THIS DIM
 * IS POINTED AT. One of the two gated conversations is a family group chat, and
 * "Hi both," "Hi guys," "Hi mum," "Hiya lovely," "Hey you two," are how that
 * message opens. Measured before this list grew: a real 52-word message under
 * any one of those openings scored 0, because the addressee had to be Titlecase
 * or one of six collectives — the dim was failing good answers on the vocabulary
 * of ordinary family, not on the shape of correspondence.
 *
 * ⚠ IT IS A CLOSED LIST, AND THAT IS THE GUARD. The reason `anyCase` exists is
 * that an `i` flag over `\p{Lu}` would read ANY lowercase word after "Hi" as a
 * name — "Hi again," "Hi sorry," would all be salutations. Naming these words
 * one at a time keeps that guard: an arbitrary lowercase word after a salutation
 * is still not an addressee, and `artifact-delivery.test.ts` asserts it.
 *
 * ⚠⚠ `there` IS DELIBERATELY ABSENT, AND IT WAS TRIED. "Hi there," is a real way
 * to open a message and adding it would raise a real answer from 0 to 1 — but it
 * also turns "Hi there! Happy to help with this." into a delivered artifact, and
 * that preamble followed by advice is precisely the failure this dim exists to
 * catch. `rubric.test.ts` pins that reply at 0, and the ONE mechanical thing
 * separating the two — whether the writer carried on talking on the salutation
 * line — cannot be used, because a whole email can arrive as a single line that
 * begins "Hi [Teacher] — …". So the false fire on "Hi there," stays, stated as a
 * limit with its executing case, rather than being traded for blindness to an
 * assistant preamble.
 */
const COLLECTIVE_ADDRESSEES: readonly string[] = [
  'you two',
  'you both',
  'you lot',
  'everyone',
  'friends',
  'lovely',
  'folks',
  'family',
  'guys',
  'both',
  'team',
  'gang',
  'all',
  'mum',
  'mam',
  'dad',
];

/**
 * Sign-offs. Longest first, same reason as the salutations. Deliberately no bare
 * "ta" or "x": both appear inside ordinary sentences far more often than they
 * end a message, and a wrong sign-off promotes notes to an announcement.
 */
const CLOSER_PHRASES: readonly string[] = [
  'yours faithfully',
  'yours sincerely',
  'all the best',
  'best wishes',
  'warm wishes',
  'kind regards',
  'warm regards',
  'lots of love',
  'love always',
  'with love',
  'many thanks',
  'thanks so much',
  'thank you',
  'speak soon',
  'see you soon',
  'sincerely',
  'regards',
  'cheers',
  'thanks',
  'best',
  'love',
];

/**
 * A literal matched in any case, WITHOUT the `i` flag. The flag is unavailable
 * here: these patterns also carry `\p{Lu}`, which under `i` matches lowercase
 * too — and then "Hi there" reads as an address to somebody called "there".
 */
function anyCase(literal: string): string {
  let out = '';
  for (const ch of literal) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    out += lower === upper ? ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '[' + lower + upper + ']';
  }
  return out;
}

/**
 * ⚠ Every composite pattern below is assembled with `+` and `join`, never a
 * template literal: an interpolated regex const is folded wrong by Turbopack and
 * only `next build` catches it (see DATE_WORD_PATTERN above, same reason).
 */
const SALUTATION_PATTERN = '(?:' + SALUTATION_WORDS.map(anyCase).join('|') + ')';

const COLLECTIVE_PATTERN = '(?:' + COLLECTIVE_ADDRESSEES.map(anyCase).join('|') + ')';

/** A placeholder, a collective, or a capitalised name. */
const ADDRESSEE_TOKEN_PATTERN =
  '(?:\\[[^\\]\\n]{1,40}\\]|' + COLLECTIVE_PATTERN + '|\\p{Lu}[\\p{L}\\u2019\'./-]{0,30})';

/**
 * "Sunny", "Ms. Halbrook", "Sir or Madam", "family & friends", "[Teacher]", and
 * — with the leading article — "the family" in "To the family,". The article is
 * optional and leading only: the addressee itself still has to be a placeholder,
 * a named collective or a capitalised name, so "To the office manager" is not a
 * salutation.
 */
const ADDRESSEE_PHRASE_PATTERN =
  '(?:' +
  anyCase('the') +
  '\\s+)?' +
  ADDRESSEE_TOKEN_PATTERN +
  '(?:\\s*(?:&\\s*|or\\s+|and\\s+|the\\s+)?' +
  ADDRESSEE_TOKEN_PATTERN +
  '){0,2}';

/**
 * What may sit in front of the salutation on its own line: a short lead-in ending
 * in a colon or a quote ("Sent again: \"Hi [Teacher] — …"), then quoting, markdown
 * or emoji decoration ("👋 Hi everyone,", "**Hi everyone,**"). All three forms
 * occur in captured output, and a rule that required the salutation to start the
 * line would fail a delivered message for being introduced or decorated.
 */
const GREETING_LEAD_PATTERN =
  '(?:[^\\n"\\u201C\\u2018\':]{0,40}[:"\\u201C\\u2018\'])?' +
  // The variation selector and the pictographs stay OUT of the character class:
  // an emoji plus U+FE0F inside one class is a misleading character class.
  '(?:[\\s*_>`\\[(\\u201C\\u2018"\']|\\p{Extended_Pictographic}|\\uFE0F){0,6}';

const GREETING_LINE_PATTERN =
  '^' +
  GREETING_LEAD_PATTERN +
  SALUTATION_PATTERN +
  '\\b[\\s,]*' +
  ADDRESSEE_PHRASE_PATTERN +
  '\\s*(?:[,!:;.\\u2014\\u2013-]|\\p{Extended_Pictographic}|$)';

/**
 * A notes-shaped section header: a Markdown heading, or a whole line of bold text
 * that LABELS what follows — "### 📝 Quick notes for the group chat:",
 * "**Next steps:**", "**⚠️ Important Notes:**".
 *
 * Two exclusions, both from captured output rather than from taste:
 *
 *   - a bullet whose label is bold ("- **Time:** 1pm") is not a header. Every one
 *     of the delivered messages uses exactly that shape;
 *   - a bold line WITHOUT a trailing colon is an emphasised fact, not a header.
 *     "**Sunday, 8th March, 1pm.**" sits in the middle of a perfectly good
 *     message, and reading it as a section boundary truncated that message to
 *     eight words. The colon is what makes a bold line a label.
 */
const HEADING_LEAD_PATTERN = '(?:\\p{Extended_Pictographic}|\\uFE0F|[\\s\\u2022])*';

const SECTION_HEADING_PATTERN =
  '^\\s*(?:#{1,6}\\s+\\S' +
  '|' +
  HEADING_LEAD_PATTERN +
  '\\*\\*[^*\\n]+:\\s*\\*\\*\\s*$' + // "**Next steps:**"
  '|' +
  HEADING_LEAD_PATTERN +
  '\\*\\*[^*\\n]+\\*\\*\\s*:\\s*$' + // "**Next steps**:"
  ')';

const CLOSER_LINE_PATTERN =
  '^\\s*[*_]{0,2}(?:' +
  CLOSER_PHRASES.map(anyCase).join('|') +
  ')[*_]{0,2}\\s*[,.!;:\\u2014\\u2013-]?\\s*(?:[Xx]{1,3})?\\s*[*_]{0,2}\\s*$';

/** "— *Organiser*", "— Bekah, owner". An em or en dash only: `-` is a bullet. */
const DASH_SIGNATURE_PATTERN = '^\\s*[\\u2014\\u2013]\\s*[*_]{0,2}[\\p{L}\\[]';

const GREETING_LINE_RE = new RegExp(GREETING_LINE_PATTERN, 'u');
const SECTION_HEADING_RE = new RegExp(SECTION_HEADING_PATTERN, 'u');
const CLOSER_LINE_RE = new RegExp(CLOSER_LINE_PATTERN, 'u');
const DASH_SIGNATURE_RE = new RegExp(DASH_SIGNATURE_PATTERN, 'u');

/**
 * Phrases that hand the reader a job as ORGANISER — quoted from the measured
 * generations, one comment per source. Reported, never scored; see
 * `ArtifactDeliveryAnalysis.requesterDirected` for why.
 */
export const REQUESTER_DIRECTED_PATTERNS: readonly RegExp[] = [
  /\byour\s+(?:\d+\s+)?(?:guests?|invitees?|attendees?)\b/i, // "Your 14 guests total"
  /\(\s*optional\s*:/i, // "(Optional: Add a small note to Kieran…)"
  /\bhow (?:i|we) should proceed\b/i, // "Let me know how I should proceed next!"
  /\bsend (?:the |a |an )?(?:confirmation|reminder)\b/i, // "Send the confirmation to Mum"
];

/**
 * Body words a delivered artifact must carry, once the salutation and the
 * signature are removed.
 *
 * ★ HONEST ABOUT ITS JOB: this floor is NOT what separates the classes on the
 * measured set — the address anchor is, on its own, for all thirty samples. The
 * floor is the guard ON that anchor: without it the cheapest way to pass is to
 * write "Hi everyone," and stop.
 *
 * CALIBRATED, not chosen. The shortest DELIVERED artifact in the captured set
 * carries 34 body words, so 15 leaves better than a two-to-one margin under every
 * good answer — a check that fails a good answer is a defect however well-founded
 * the constant behind it. `artifact-delivery.test.ts` recomputes that minimum
 * against the fixtures rather than trusting this comment.
 */
const ARTIFACT_BODY_MIN_WORDS = 15;

/** Non-empty lines at the end of a reply that may still hold its signature. */
const SIGN_OFF_TAIL_LINES = 6;

function isSectionHeading(line: string): boolean {
  return SECTION_HEADING_RE.test(line);
}

function isSignOffLine(line: string): boolean {
  return CLOSER_LINE_RE.test(line) || DASH_SIGNATURE_RE.test(line);
}

function countWords(lines: readonly string[]): number {
  return words(lines.filter((line) => !isSectionHeading(line)).join(' ')).length;
}

/**
 * Whether a sign-off-shaped line at `index` really ENDS the artifact, or is a
 * courtesy line with the message still to come.
 *
 * ★ WHY THIS IS NEEDED, MEASURED. "Hi Dave," / "Thanks." / then the whole email
 * is an ordinary way to write one, and the first sign-off-shaped line wins:
 * "Thanks." was read as the signature, everything under it fell outside the
 * artifact, and a complete email scored 0 on a body of 0 words. A closer with a
 * body still under it closed nothing.
 *
 * The threshold is the body floor, not a new constant — the same amount of text
 * that makes an artifact real is the amount that proves it had not ended.
 */
function closesTheArtifact(lines: readonly string[], index: number, end: number): boolean {
  return countWords(lines.slice(index + 1, end)) < ARTIFACT_BODY_MIN_WORDS;
}

/**
 * Did the reply carry the artifact the ask named? See the block comment above for
 * the mechanism and its two stated limits.
 */
export function analyzeArtifactDelivery(text: string): ArtifactDeliveryAnalysis {
  const lines = text.split('\n');
  const organizerHeadings = lines.filter((line) => isSectionHeading(line)).map((l) => l.trim());

  const greetingIndex = lines.findIndex((line) => GREETING_LINE_RE.test(line));
  const requesterDirected = REQUESTER_DIRECTED_PATTERNS.filter((p) => p.test(text)).map((p) => p.source);

  if (greetingIndex !== -1) {
    const greetingLine = lines[greetingIndex]!;
    const match = GREETING_LINE_RE.exec(greetingLine);
    const addressOpening = (match?.[0] ?? greetingLine).trim();

    // The artifact runs from the salutation to the first notes-shaped header
    // after it — a message does not contain "### Next Steps" — and stops at its
    // own signature, so trailing assistant meta ("Let me know if you'd like any
    // adjustments!") is neither counted as body nor read as the artifact.
    let end = lines.length;
    for (let i = greetingIndex + 1; i < lines.length; i++) {
      if (isSectionHeading(lines[i]!)) {
        end = i;
        break;
      }
    }
    let signOff: string | null = null;
    for (let i = greetingIndex + 1; i < end; i++) {
      if (!isSignOffLine(lines[i]!)) continue;
      // "Thanks." above the email is a courtesy line, not the end of it.
      if (!closesTheArtifact(lines, i, end)) continue;
      signOff = lines[i]!.trim();
      end = i;
      break;
    }

    // Only the salutation is dropped, not the line it sits on: a whole email can
    // arrive as one quoted line that begins "Hi [Teacher] — …".
    const remainder = greetingLine.slice(match?.[0].length ?? 0);
    const bodyWords = countWords([remainder, ...lines.slice(greetingIndex + 1, end)]);
    return {
      addressOpening,
      signOff,
      bodyWords,
      organizerHeadings,
      requesterDirected,
      score: bodyWords >= ARTIFACT_BODY_MIN_WORDS ? 1 : 0,
    };
  }

  // Nobody is addressed. A signature at the foot still puts the reply in the
  // recipient-facing register — an announcement or a flyer — which is the
  // borderline the hand labels record, so it reaches the middle rung and no more.
  const tail: number[] = [];
  for (let i = lines.length - 1; i >= 0 && tail.length < SIGN_OFF_TAIL_LINES; i--) {
    if (lines[i]!.trim().length > 0) tail.push(i);
  }
  // ⚠ `closesTheArtifact` is deliberately NOT applied here. This branch already
  // looks only at the last few lines, and requiring nothing substantial to
  // follow the signature demoted a captured flyer — signed, with two lines under
  // it — from the borderline rung to 0. A change that lowers a hand-labelled
  // sample is a regression whatever its reasoning, so the rule stays where the
  // failure it was written for actually happens.
  const signOffIndex = tail.reverse().find((i) => isSignOffLine(lines[i]!));
  if (signOffIndex === undefined) {
    return {
      addressOpening: null,
      signOff: null,
      bodyWords: countWords(lines),
      organizerHeadings,
      requesterDirected,
      score: 0,
    };
  }
  const bodyWords = countWords(lines.slice(0, signOffIndex));
  return {
    addressOpening: null,
    signOff: lines[signOffIndex]!.trim(),
    bodyWords,
    organizerHeadings,
    requesterDirected,
    score: bodyWords >= ARTIFACT_BODY_MIN_WORDS ? 0.5 : 0,
  };
}

/**
 * Did the reply hand back the message/email/letter the ask named? null unless the
 * spec sets `expectsArtifact`.
 *
 * The annotation is hand-authored per corpus item and carries the audience in
 * prose. The scorer reads `kind` only for gating: matching a hand-written
 * audience string against the reply would score the wording of the annotation
 * rather than the reply, so the audience is carried to the judge (through the
 * probe's `notes`) and to the tests, and is never pattern-matched.
 */
export function scoreArtifactDelivery(spec: EvalPromptSpec, text: string): number | null {
  if (spec.expectsArtifact === undefined) return null;
  return analyzeArtifactDelivery(text).score;
}

// ─── correct stop ──────────────────────────────────────────────────────────

/**
 * Whether generation stopped at the right place. Never null (ctx always
 * provided).
 *
 *   1.0 if ended cleanly, did not hit the cap, and repetition >= 0.5
 *   0.0 if repetition < 0.3 (runaway loop)
 *   0.5 if it hit the token cap (may be legitimately long)
 *   0.7 otherwise (ended cleanly with mild repetition)
 */
export function scoreCorrectStop(
  _spec: EvalPromptSpec,
  ctx: RubricContext,
): number | null {
  const rep = scoreRepetition(ctx.output);
  if (rep < 0.3) return 0;
  if (ctx.endedCleanly && !ctx.hitTokenCap && rep >= 0.5) return 1;
  if (ctx.hitTokenCap) return 0.5;
  return 0.7;
}

// ─── composer ──────────────────────────────────────────────────────────────

/**
 * Compose all automated sub-scores for one result. Always-computed dims read
 * from `ctx.output`; conditional dims are `null` when the spec field is
 * absent; judge dims (`coherence`, `taskFit`) are `null` until a judge fills
 * them.
 */
export function scoreResult(spec: EvalPromptSpec, ctx: RubricContext): RubricScores {
  return {
    correctStop: scoreCorrectStop(spec, ctx),
    noRepetition: scoreRepetition(ctx.output),
    noCannedLeakage: scoreCannedLeakage(ctx.output),
    noThinkLeakage: scoreThinkLeakage(ctx.output),
    noCjkLeak: scoreCjkLeak(spec, ctx.output),
    formatAdherence: scoreFormat(spec, ctx.output),
    exactness: scoreExactness(spec, ctx.output),
    instructionFollowing: scoreInstructionFollowing(spec, ctx.output),
    appropriateUncertainty: scoreUncertaintyHeuristic(spec, ctx.output),
    answerDepth: scoreAnswerDepth(spec, ctx.output),
    depthMatch: scoreDepthMatch(spec, ctx.output),
    deliversFirst: scoreDeliversFirst(spec, ctx.output),
    deliversAskedArtifact: scoreArtifactDelivery(spec, ctx.output),
    preservesUserText: scorePreservesUserText(spec, ctx.output),
    preservesFacts: scoreFactPreservation(spec, ctx.output),
    preservesHistoryFacts: scoreHistoryFactPreservation(spec, ctx.output),
    honorsRuledOut: scoreHonorsRuledOut(spec, ctx.output),
    coherence: null,
    taskFit: null,
  };
}
