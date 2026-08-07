// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Backend cross-check — comparison logic for the silent-garbage failure class.
 *
 * ## What this exists to catch
 *
 * Quantized ONNX models can produce SILENTLY WRONG output on the WebGPU
 * execution provider while the identical files decode correctly on WASM: no
 * error, no warning, full generation speed, just incoherent text. Upstream
 * report: huggingface/transformers.js#1728 (and two older issues describing the
 * same class in text decoders). Eco's serving-path gate — `lifecycle/smoke.ts`
 * — is TIME-ONLY: it verifies that a first token arrives inside a deadline, not
 * that the tokens mean anything. A catalog model could regress into garbage on
 * some driver/OS/browser combination and every check we ship today would pass.
 *
 * This module is the comparison half of a standing net for that: generate from
 * the SAME model and the SAME fixed prompt on WebGPU and on WASM, then decide
 * whether the two outputs are consistent enough to rule the failure class out.
 * The run driver lives in `backend-crosscheck-runner.ts`; the surface is the
 * diagnostics page.
 *
 * ## Scope: Transformers.js / ONNX only
 *
 * The documented failure class is an ONNX-Runtime-Web WebGPU EP problem, and
 * Transformers.js is the only Eco runtime that can serve the SAME weights on
 * both backends — that dual-backend property is what makes the comparison
 * possible at all. LiteRT-LM (`.litertlm`, Chromium-WebGPU-only) and WebLLM/MLC
 * (its own compiled builds) have no WASM lane to compare against, so they are
 * deliberately OUT OF SCOPE; the runner refuses them by `model.runtime` rather
 * than silently producing a meaningless verdict.
 *
 * ## Why this is not a runtime gate
 *
 * A full WASM generation of a 2 B model takes minutes. That is fine for a
 * diagnostics/QA lane run on demand, and completely unacceptable to inflict on
 * a user at setup time. Nothing here is wired into `smoke.ts`, setup, or chat.
 *
 * ## Why the assertion is not equality
 *
 * Greedy decoding is deterministic in principle, but the two backends evaluate
 * the same graph with different kernels and different float accumulation
 * orders. One near-tie in the argmax is enough to pick a different token, after
 * which the continuations diverge legitimately — so strict token equality would
 * false-positive constantly. What the failure class actually produces is
 * GARBAGE: empty or near-empty output, repetition collapse, token salad, or a
 * sudden switch to another script. So the check is built in two layers:
 *
 *   1. **Per-side degeneracy** (absolute, needs no comparison): is either
 *      output empty, collapsed into a loop, mostly non-word tokens, or in the
 *      wrong script? A degenerate WebGPU output beside a healthy WASM output IS
 *      the documented failure, and that verdict never depends on a similarity
 *      threshold at all.
 *   2. **Cross-backend similarity** (relative): for two outputs that are both
 *      individually healthy, how much do they actually agree? This is the softer
 *      signal, and the one that needs a defensible threshold.
 *
 * ## The threshold, and the noise floor it is derived from
 *
 * A cross-backend similarity number means nothing without knowing how much the
 * SAME backend varies against ITSELF. The runner therefore always generates
 * twice on WebGPU before it ever loads WASM, and records that same-backend pair
 * as the run's noise floor.
 *
 * Measured on an Apple-silicon Mac (16 GB, Chromium, WebGPU), greedy, 96-token
 * cap, the fixed prompt below, each arm after a full unload → reload:
 *
 *   - `candidate/qwen3.5-2b-onnx` — the two WebGPU generations came back
 *     BYTE-IDENTICAL: tokenOverlap 1.000, lengthRatio 1.000, shared prefix
 *     73/73 tokens (14.1 s then 9.4 s).
 *   - `candidate/lfm2.5-350m-onnx` — likewise byte-identical: 1.000 / 1.000,
 *     shared prefix 48/48 tokens (2.5 s then 2.2 s).
 *
 * So same-backend greedy variance on this hardware is not merely small, it is
 * ZERO, even across a fresh session. That kills the obvious threshold recipe:
 * "noise floor minus a margin" would put the bar at ~1.0 and flag every honest
 * cross-backend difference, because the whole reason a cross-backend pair
 * differs is float accumulation order, which a same-backend repeat never
 * exercises.
 *
 * With no measurable same-backend spread, the bar has to come from the other
 * end — how far apart can two GENUINELY COHERENT answers to this prompt be?
 * Three reference points, all measured with the functions in this module:
 *
 *   - 0.562 — the two models above, answering this same prompt. Different
 *     vendors, different sizes, both perfectly readable. This is a far harsher
 *     divergence than two backends of ONE model could produce, and it is the
 *     most useful empirical floor available.
 *   - 0.840 — the same answer re-worded (synthetic pair in the unit tests).
 *   - 0.189 — coherent prose about an entirely different subject.
 *
 * `MIN_TOKEN_OVERLAP` is therefore 0.45: comfortably BELOW the harshest real
 * coherent-vs-coherent pair we can produce (0.562), and comfortably above
 * genuinely unrelated text (0.189). A cross-backend pair that scores under 0.45
 * has diverged more than two different models do, which is worth a human look.
 * The bound is deliberately loose, because this dimension is only a backstop:
 * the failure class this module exists for is caught by the degeneracy layer,
 * which needs no threshold at all. `divergent` means "read both of these", not
 * "this is broken".
 *
 * ## What could not be measured, and why it matters
 *
 * The cross-backend arm did not run on either model. Both fail at WASM SESSION
 * CREATION, before a single token: their block-quantized embeddings emit
 * `com.microsoft.GatherBlockQuantized`, and onnxruntime-web's CPU/WASM
 * execution provider has no kernel for it ("Failed to find kernel ...
 * ep:'CPUExecutionProvider'"). This is a known property of these builds, not a
 * new defect — `device/compatibility.ts` already carries a `cpuEpIncompatible`
 * rule for exactly this, and the WebGPU EP implements the op fine.
 *
 * That means today this check can establish the noise floor and prove the
 * forcing/verification path works, but cannot yet return a cross-backend
 * verdict for the current catalog. It is written as a STANDING net rather than
 * a one-off: the moment a catalog build without block-quantized embeddings
 * lands, or ort-web ships the CPU kernel, the same run produces real numbers
 * with no code change. `explainWasmLoadFailure` below turns that specific
 * failure into a readable message instead of a raw ORT string, since it is by
 * far the most likely thing a person running this today will hit.
 *
 * The noise floor is also a GUARD, not just context: if the same-backend pair
 * itself scores below the cross-backend threshold, the model/prompt is not
 * reproducible enough for a cross-backend comparison to mean anything, and the
 * run is reported `inconclusive` rather than pretending to a verdict.
 *
 * Everything in this module is pure and deterministic, so the verdict logic is
 * unit-tested against synthetic pairs; only the driver needs a real browser.
 */

import type { RuntimeBackend } from '../runtime/types';
import { scoreRepetition, longestCommonTokenSpan, tokenizeForReuse } from '../eval/rubric';
import { safeStorage } from '../../lib/local-storage';

// ─── The fixed prompt ────────────────────────────────────────────────────────

/**
 * One fixed prompt for every run, so results are comparable across models,
 * devices and dates. Deliberately plain English prose with no code, no maths
 * and no lists: the degeneracy layer reads a wordlike-token ratio and a
 * non-Latin-script ratio, and both of those are only safe when we control the
 * expected shape of a healthy answer. Short enough that a WASM 2 B generation
 * finishes in minutes rather than tens of them.
 */
export const CROSS_CHECK_PROMPT =
  'In two or three sentences, explain what a rainbow is and why one appears after rain.';

/**
 * Token cap per generation. Enough text for repetition collapse and token
 * salad to be visible (both need tens of tokens to register), small enough that
 * the WASM arm stays tolerable.
 */
export const CROSS_CHECK_MAX_TOKENS = 96;

// ─── Degeneracy thresholds ───────────────────────────────────────────────────

/**
 * Below this many whitespace tokens there is nothing to judge — and an output
 * this short is itself a symptom (the failure class includes immediate EOS).
 */
export const MIN_OUTPUT_TOKENS = 12;

/**
 * `scoreRepetition` (eval/rubric) hard-caps at 0.3 for a degenerate loop — a
 * line repeated 3+ times or a word 4-gram repeated 4+ times. 0.35 sits just
 * above that cap so every hard-capped output is caught, plus outputs whose
 * trigram ratio alone is that bad.
 */
export const MIN_REPETITION_SCORE = 0.35;

/**
 * Fraction of tokens that must look like words (letters/digits after stripping
 * surrounding punctuation). Healthy English prose sits above 0.9; pure
 * punctuation salad sits near 0. 0.5 leaves enormous headroom for a reply that
 * legitimately carries dashes, quotes or an em-dash aside.
 */
export const MIN_WORDLIKE_RATIO = 0.5;

/**
 * Fraction of an output's LETTERS that may be non-Latin before it counts as a
 * script switch, when the prompt itself is entirely Latin. Set well above zero
 * so an isolated accented or Greek character (π, ° in a unit) is never a
 * finding; a genuine script switch is overwhelming, not incidental.
 */
export const MAX_NON_LATIN_LETTER_RATIO = 0.2;

// ─── Similarity thresholds ───────────────────────────────────────────────────

/** See the module docblock for the measurement this is derived from. */
export const MIN_TOKEN_OVERLAP = 0.45;

/**
 * Length agreement (shorter/longer). A healthy pair of answers to the same
 * fixed prompt lands within a sentence of each other; a truncated-to-nothing
 * WebGPU arm that somehow dodged the token floor still fails here.
 */
export const MIN_LENGTH_RATIO = 0.5;

// ─── Types ───────────────────────────────────────────────────────────────────

export type DegeneracyReason =
  | 'empty'
  | 'too-short'
  | 'repetition-collapse'
  | 'token-salad'
  | 'script-switch';

/** Absolute, single-output health. Needs no counterpart to compute. */
export type OutputQuality = {
  /** Whitespace token count. */
  tokens: number;
  /** eval/rubric `scoreRepetition`, 0..1 (1 = no repetition). */
  repetition: number;
  /** Fraction of tokens that look like words. */
  wordlikeRatio: number;
  /** Fraction of letters that are non-Latin. */
  nonLatinLetterRatio: number;
  degenerate: boolean;
  reasons: DegeneracyReason[];
};

/** Relative agreement between two outputs. */
export type CrossCheckSimilarity = {
  /** Leading tokens that are identical in both. */
  sharedPrefixTokens: number;
  /** Longest contiguous token run present in both (eval/rubric). */
  longestCommonSpan: number;
  /** Dice coefficient over token multisets, 0..1. */
  tokenOverlap: number;
  /** shorter/longer token count, 0..1. */
  lengthRatio: number;
};

export type PairVerdict =
  | 'consistent'
  | 'divergent'
  | 'backend-garbage'
  | 'reference-degenerate';

export type CrossCheckComparison = {
  verdict: PairVerdict;
  /** The WASM arm — the trusted side. */
  reference: OutputQuality;
  /** The WebGPU arm — the side under suspicion. */
  candidate: OutputQuality;
  similarity: CrossCheckSimilarity;
  summary: string;
};

/** The run-level verdict, which folds in the same-backend noise floor. */
export type RunVerdict = PairVerdict | 'inconclusive';

// ─── Text analysis ───────────────────────────────────────────────────────────

function whitespaceTokens(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * A token counts as wordlike when, after stripping surrounding punctuation, it
 * still contains a letter or a digit. `"hello,"` → yes; `"!!!"` → no.
 */
function isWordlike(token: string): boolean {
  return /[\p{L}\p{N}]/u.test(token);
}

const LATIN_LETTER_RE = /\p{Script=Latin}/u;

/**
 * Fraction of the string's letters that are NOT Latin. Deliberately broader
 * than the rubric's `hasCjkScript` (which answers a different question — a
 * multilingual model leaking CJK mid-English); the garbage class can surface as
 * Cyrillic, Greek or Devanagari just as easily as CJK.
 */
export function nonLatinLetterRatio(text: string): number {
  let letters = 0;
  let nonLatin = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    letters++;
    if (!LATIN_LETTER_RE.test(char)) nonLatin++;
  }
  return letters === 0 ? 0 : nonLatin / letters;
}

/**
 * Score one output on its own terms. `prompt` is needed only for the script
 * check: a prompt that is itself non-Latin legitimately yields non-Latin
 * output, so drift is only a finding when the prompt is Latin.
 */
export function analyzeOutput(prompt: string, text: string): OutputQuality {
  const tokens = whitespaceTokens(text);
  const wordlike = tokens.filter(isWordlike).length;
  const wordlikeRatio = tokens.length === 0 ? 0 : wordlike / tokens.length;
  const repetition = scoreRepetition(text);
  const outputNonLatin = nonLatinLetterRatio(text);
  const promptNonLatin = nonLatinLetterRatio(prompt);

  const reasons: DegeneracyReason[] = [];
  if (tokens.length === 0) {
    reasons.push('empty');
  } else if (tokens.length < MIN_OUTPUT_TOKENS) {
    reasons.push('too-short');
  }
  // Repetition and salad need enough text to be meaningful; below the floor the
  // 'too-short' reason already carries the finding.
  if (tokens.length >= MIN_OUTPUT_TOKENS) {
    if (repetition < MIN_REPETITION_SCORE) reasons.push('repetition-collapse');
    if (wordlikeRatio < MIN_WORDLIKE_RATIO) reasons.push('token-salad');
  }
  if (
    promptNonLatin <= MAX_NON_LATIN_LETTER_RATIO &&
    outputNonLatin > MAX_NON_LATIN_LETTER_RATIO
  ) {
    reasons.push('script-switch');
  }

  return {
    tokens: tokens.length,
    repetition,
    wordlikeRatio,
    nonLatinLetterRatio: outputNonLatin,
    degenerate: reasons.length > 0,
    reasons,
  };
}

// ─── Similarity ──────────────────────────────────────────────────────────────

function sharedPrefix(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/** Dice coefficient over token MULTISETS: 2·Σ min(countA, countB) / (|A|+|B|). */
function diceOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of b) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) {
      shared++;
      counts.set(token, remaining - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Compare two outputs. Symmetric — every measure here is order-independent, so
 * the same function serves both the same-backend noise-floor pair and the
 * cross-backend pair.
 */
export function measureSimilarity(left: string, right: string): CrossCheckSimilarity {
  const a = tokenizeForReuse(left);
  const b = tokenizeForReuse(right);
  const longer = Math.max(a.length, b.length);
  return {
    sharedPrefixTokens: sharedPrefix(a, b),
    longestCommonSpan: longestCommonTokenSpan(a, b),
    tokenOverlap: diceOverlap(a, b),
    lengthRatio: longer === 0 ? 1 : Math.min(a.length, b.length) / longer,
  };
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

function describeReasons(reasons: readonly DegeneracyReason[]): string {
  return reasons.join(', ');
}

/**
 * The cross-backend judgement. `referenceText` is the WASM arm (trusted),
 * `candidateText` the WebGPU arm (under suspicion).
 *
 * The degeneracy layer runs FIRST and is unconditional: a degenerate WebGPU
 * output beside a healthy WASM output is the documented failure and does not
 * depend on any similarity threshold. A degenerate WASM output means the
 * reference itself is unusable — that is a prompt/model finding, not a backend
 * one, and the run cannot rule anything out.
 */
export function compareOutputs(
  prompt: string,
  referenceText: string,
  candidateText: string,
): CrossCheckComparison {
  const reference = analyzeOutput(prompt, referenceText);
  const candidate = analyzeOutput(prompt, candidateText);
  const similarity = measureSimilarity(referenceText, candidateText);

  if (reference.degenerate) {
    return {
      verdict: 'reference-degenerate',
      reference,
      candidate,
      similarity,
      summary: candidate.degenerate
        ? `Both arms are degenerate (WASM: ${describeReasons(reference.reasons)}; WebGPU: ${describeReasons(candidate.reasons)}) — a prompt or model problem, not a backend one.`
        : `The WASM reference is itself degenerate (${describeReasons(reference.reasons)}), so this run cannot rule anything out about WebGPU.`,
    };
  }

  if (candidate.degenerate) {
    return {
      verdict: 'backend-garbage',
      reference,
      candidate,
      similarity,
      summary: `WebGPU output is degenerate (${describeReasons(candidate.reasons)}) while the same model and prompt decoded cleanly on WASM — the silent-garbage failure class.`,
    };
  }

  if (similarity.tokenOverlap < MIN_TOKEN_OVERLAP || similarity.lengthRatio < MIN_LENGTH_RATIO) {
    return {
      verdict: 'divergent',
      reference,
      candidate,
      similarity,
      summary: `Both arms read as coherent text, but they agree less than expected (token overlap ${similarity.tokenOverlap.toFixed(3)}, length ratio ${similarity.lengthRatio.toFixed(3)}) — worth reading both outputs.`,
    };
  }

  return {
    verdict: 'consistent',
    reference,
    candidate,
    similarity,
    summary: `WebGPU and WASM agree (token overlap ${similarity.tokenOverlap.toFixed(3)}, length ratio ${similarity.lengthRatio.toFixed(3)}) — no sign of the silent-garbage failure class.`,
  };
}

/**
 * Fold the same-backend noise floor into the cross-backend comparison.
 *
 * Degeneracy verdicts pass straight through: they are absolute findings about
 * one output and never depend on how reproducible the model is. The
 * similarity-only verdicts DO depend on it — if two generations on the SAME
 * backend already disagree more than the cross-backend threshold, then a
 * cross-backend disagreement carries no information, and saying `divergent`
 * would be an unearned claim.
 */
export function judgeCrossCheck(
  noiseFloor: CrossCheckSimilarity,
  cross: CrossCheckComparison,
): { verdict: RunVerdict; summary: string } {
  if (cross.verdict === 'backend-garbage' || cross.verdict === 'reference-degenerate') {
    return { verdict: cross.verdict, summary: cross.summary };
  }
  if (noiseFloor.tokenOverlap < MIN_TOKEN_OVERLAP) {
    return {
      verdict: 'inconclusive',
      summary: `Two generations on the SAME backend already disagree (token overlap ${noiseFloor.tokenOverlap.toFixed(3)}), so a cross-backend comparison at this threshold carries no information.`,
    };
  }
  return { verdict: cross.verdict, summary: cross.summary };
}

// ─── WASM load-failure classification ────────────────────────────────────────

/**
 * Turn an ORT session-creation failure on the WASM arm into a readable
 * explanation, or null when the message is not one we recognise (in which case
 * the caller keeps the original text — inventing an explanation for an
 * unfamiliar error would be worse than showing the raw one).
 *
 * The one case worth naming is the CPU/WASM execution provider lacking a kernel
 * that the WebGPU EP has. It is STRUCTURAL — the model can never load on WASM
 * on this build of ort-web, so re-running will never help — and it is not a
 * finding about output quality at all, which is exactly the confusion a raw
 * "ERROR_CODE: 9" invites. See the module docblock.
 */
export function explainWasmLoadFailure(message: string): string | null {
  const missingKernel =
    /failed to find kernel/i.test(message) || /could not find an implementation/i.test(message);
  if (!missingKernel) return null;

  const op = /GatherBlockQuantized/i.test(message) ? 'GatherBlockQuantized' : null;
  const opPhrase = op
    ? `an operator its quantized build depends on (${op})`
    : 'an operator its build depends on';
  return (
    `This model cannot run on the WASM backend at all: onnxruntime-web's CPU execution provider has ` +
    `no kernel for ${opPhrase}, so the session fails before any token is generated. The WebGPU ` +
    `backend implements it, which is why the WebGPU arms succeeded. This is a property of the model ` +
    `build rather than a sign of bad output, and re-running will not change it — a cross-backend ` +
    `comparison is not possible for this model on this version of onnxruntime-web.`
  );
}

// ─── Record store (localStorage, FIFO) ───────────────────────────────────────

const RECORDS_KEY = 'eco-backend-crosscheck-records-v1';
const MAX_RECORDS = 10;

export type BackendCrossCheckRecord = {
  version: 1;
  recordedAt: string; // ISO
  modelId: string;
  prompt: string;
  maxTokens: number;
  outcome: 'completed' | 'error';
  verdict: RunVerdict | null;
  summary: string;
  /** Backend each arm ACTUALLY resolved to — a forced request can still fall back. */
  webgpuBackend: RuntimeBackend | null;
  wasmBackend: RuntimeBackend | null;
  /** Same-backend pair (two WebGPU generations). Null when the run never got there. */
  noiseFloor: CrossCheckSimilarity | null;
  cross: CrossCheckComparison | null;
  /** Wall-clock per generation, ms. */
  timings: { webgpuMs: number | null; webgpuRepeatMs: number | null; wasmMs: number | null };
  /** The three raw outputs, kept so a human can read what the numbers describe. */
  outputs: { webgpu: string; webgpuRepeat: string; wasm: string };
  error: string | null;
};

export function recordBackendCrossCheck(record: BackendCrossCheckRecord): void {
  const current = loadBackendCrossChecks();
  current.push(record);
  safeStorage.set(RECORDS_KEY, JSON.stringify(current.slice(-MAX_RECORDS)));
}

export function loadBackendCrossChecks(): BackendCrossCheckRecord[] {
  const raw = safeStorage.get(RECORDS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

export function clearBackendCrossChecks(): void {
  safeStorage.remove(RECORDS_KEY);
}

function isRecord(value: unknown): value is BackendCrossCheckRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.modelId === 'string' &&
    typeof v.recordedAt === 'string' &&
    (v.outcome === 'completed' || v.outcome === 'error')
  );
}
