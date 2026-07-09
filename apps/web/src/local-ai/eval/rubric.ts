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
 * Word-level repetition score. 1.0 = no repetition, →0.0 = severe loop.
 *
 * Method (deterministic):
 *   - Tokenize on whitespace. If <8 words, return 1.0 (too short to judge).
 *   - ratio = 1 - uniqueTrigrams/totalTrigrams; score = clamp(1 - 2*ratio, 0, 1).
 *   - Hard cap at 0.3 if any single non-empty line repeats >=3x, OR any word
 *     4-gram repeats >=4x (catches degenerate loops the trigram ratio softens).
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
    coherence: null,
    taskFit: null,
  };
}
