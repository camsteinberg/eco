// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * ★ REGISTER SHIFT — the one over-writing failure nothing else measures.
 *
 * WHY IT EXISTS. On 2026-08-09 a reply that replaced an applicant's entire
 * voice with cover-letter English — "Dear Hiring Manager", "During my tenure",
 * "honed my patience", a "[Last Name]" slot, and the applicant's honesty about
 * lacking the certificate reversed into "fully prepared to obtain it
 * immediately" — scored **1.00** on `preservesUserText`. That dim reads a
 * longest-common token span, and an 8-token run survives almost any rewrite, so
 * it cannot see a register change. `noUnfilledSlots` caught that particular
 * reply by its bracket slot, but `proofread-teacher-note-esl` fails with NO
 * slot, NO invented time and NO burial: it is simply no longer the person's
 * voice. Nothing in the rubric could see that.
 *
 * WHAT IT MEASURES. Formal-correspondence markers the reply INTRODUCED — that
 * is, markers absent from the block the user pasted. A person who already
 * signs off "With respect, Yaneth" is not made formal by the model echoing it.
 *
 * ★ DIFFERENTIAL, NEVER A BARE WORD LIST. This is the design rule the
 * `inventedTime` detector already established (see the header of
 * `__tests__/fixtures/captured-overwrite-replies.ts`): a marker SOURCED from
 * the user's own text is clean, and only a marker the model added counts. A
 * bare list would fail every item whose paste is already a letter — the
 * grandfather letter and the vet application both open and close formally.
 *
 * WHAT IT DELIBERATELY DOES NOT MEASURE. Whether the reply is any good, whether
 * it fixed the errors, or whether the register is WRONG in the abstract. Some
 * asks legitimately raise register ("make this sound more professional"); this
 * dim is gated by the caller to the items whose ask says the opposite, exactly
 * as the overwrite watch gates its three dims.
 */

/**
 * Markers of institutional-correspondence register.
 *
 * Each is a phrase a person does not produce by accident and a model reaches
 * for when it is writing a genre exemplar rather than editing someone's text.
 * Grouped only for readability — the analysis treats them as one set.
 */
const REGISTER_MARKERS: readonly RegExp[] = [
  // Salutations to an institution rather than a person the user named.
  /\bDear (?:Hiring|Sir|Madam|Team|Manager|Recruiter|Admissions|Sir or Madam)\b/i,
  /\bTo Whom It May Concern\b/i,
  // Business-letter scaffolding the paste did not have.
  /^\s*\*{0,2}Subject:/im,
  /\bI hope this (?:message|email|letter) finds you well\b/i,
  // The full institutional formula, not just the verbs that happened to appear
  // in one capture: "I am writing to ___" is the opener a person does not reach
  // for and a model produces whenever it is writing a letter rather than
  // editing one. Left open past the verb for that reason.
  /\bI am writing (?:to|in|regarding)\b/i,
  /\bI would like to (?:express|take this opportunity)\b/i,
  /\bI look forward to (?:hearing|discussing|the opportunity)\b/i,
  /\bPlease (?:do not hesitate|feel free) to (?:contact|reach out)\b/i,
  /\bThank you for (?:your (?:time|consideration|understanding)|considering my)\b/i,
  // Formal closings.
  /\b(?:Sincerely|Warm regards|Kind regards|Best regards|Yours (?:sincerely|faithfully|truly))\b/i,
  // Résumé/HR diction — the vocabulary that replaces a person's own words.
  /\bduring my tenure\b/i,
  /\bhoned my\b/i,
  /\bessential tasks\b/i,
  /\bdedicated volunteer experience\b/i,
  /\bproactively\b/i,
  /\bcommitted to (?:learning|excellence|providing)\b/i,
  /\bdemonstrated (?:ability|experience|commitment)\b/i,
  /\bin a timely manner\b/i,
  /\bplease be advised\b/i,
  /\bat your earliest convenience\b/i,
];

export type RegisterShiftAnalysis = {
  /** Marker text the reply introduced that the paste does not contain. */
  introduced: string[];
  /** Marker text present in BOTH — the user's own register, never a defect. */
  sourced: string[];
  /** True once the reply has introduced enough markers to have changed voice. */
  shifted: boolean;
  /** 1 = the person's register survived; 0 = replaced. */
  score: number;
};

/**
 * Two introduced markers, not one, is the defect line.
 *
 * Calibrated against the frozen captures, not chosen a priori. ONE marker is
 * routinely a model tidying a sign-off ("Sincerely" over "With respect") while
 * leaving the body in the person's words — a real but minor edit, and the
 * corpus's own good answers tolerate it. TWO or more has meant, on every
 * capture read, that the body itself was re-voiced: a salutation plus a
 * closing, or HR diction plus scaffolding. See the calibration test.
 */
const SHIFT_THRESHOLD = 2;

/** How many introduced markers score a flat 0 — a wholly re-voiced reply. */
const FULL_SHIFT = 4;

function markerHits(text: string): string[] {
  const hits: string[] = [];
  for (const marker of REGISTER_MARKERS) {
    const match = marker.exec(text);
    if (match) hits.push(match[0].trim());
  }
  return hits;
}

/**
 * Compare the register of a reply against the text the user pasted.
 *
 * ★ LEAF MODULE BY DESIGN — it imports nothing. `pastedUserText` is passed in
 * already extracted (callers use `pastedBlockOf` from `rubric.ts`) rather than
 * extracted here: `rubric.ts` imports THIS module to compute the dim, so
 * importing `pastedBlockOf` back out of it would close a cycle, and
 * `pnpm check:cycles` gates on exactly that.
 */
export function analyzeRegisterShift(
  pastedUserText: string,
  output: string,
): RegisterShiftAnalysis {
  const inPaste = new Set(markerHits(pastedUserText).map((h) => h.toLowerCase()));
  const inOutput = markerHits(output);

  const introduced: string[] = [];
  const sourced: string[] = [];
  for (const hit of inOutput) {
    if (inPaste.has(hit.toLowerCase())) sourced.push(hit);
    else introduced.push(hit);
  }

  const shifted = introduced.length >= SHIFT_THRESHOLD;
  const span = FULL_SHIFT - SHIFT_THRESHOLD;
  const over = introduced.length - SHIFT_THRESHOLD;
  const score = shifted ? Math.max(0, 1 - (over + 1) / (span + 1)) : 1;

  return { introduced, sourced, shifted, score };
}

/**
 * The dim: 1 when the person's register survived, lower as the reply replaces
 * it. null when the caller has not gated this item in — same contract as the
 * overwrite-watch dims.
 */
export function scorePreservesUserRegister(
  pastedUserText: string,
  output: string,
  gated: boolean,
): number | null {
  if (!gated) return null;
  return analyzeRegisterShift(pastedUserText, output).score;
}
