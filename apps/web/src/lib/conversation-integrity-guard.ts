// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Conversation-integrity guard — the suppression counterpart to the recap /
 * artifact-frame machinery (task #27, the "nora leak").
 *
 * THE DEFECT. Earlier in a conversation the user shares a private detail as
 * background — a diagnosis, a surprise, a salary, a job they have not announced —
 * and explicitly flags it as not-to-be-shared ("just between us", "nobody knows",
 * "keep it confidential"). A later turn asks for a message to a DIFFERENT person
 * (a manager, the guest of honour, a client), and a sub-2B model, which does
 * inclusion well and suppression poorly, copies the vivid detail INTO that
 * message. It reproduced at ~100% on both the 1.2B and the 2.6B and it is the
 * product's worst chat failure: it breaks the local-first promise in the one place
 * a user would never forgive it.
 *
 * WHAT THIS MODULE IS. A deterministic, host-side guard with two layers:
 *   1. TRIGGER + EXTRACTION ({@link derivePrivacyGuard}) — arm ONLY when a privacy
 *      marker sits in the conversation history AND the current turn drafts new
 *      correspondence; then extract, from the user's own history turns, the
 *      candidate private spans (proper nouns, figures, sensitive-category terms,
 *      and "diagnosed with X" objects), minus anything the user themselves put in
 *      the drafting request.
 *   2. GUARANTEE ({@link redactPrivateSpans}) — a pure function that removes every
 *      forbidden span from the drafted text. Because it is deterministic, it is the
 *      real guarantee: regeneration with a hardened frame ({@link
 *      buildIntegrityRepairPrompt}) runs first for prose quality, but the redaction
 *      backstop is what makes "no leak" a promise rather than a probability.
 *
 * ── GENERAL, BLIND, ANTI-TREADMILL ──────────────────────────────────────────
 *
 * ★ The extraction is a GENERAL mechanism, deliberately BLIND to the eval fixture
 * (`local-ai/eval/conversation-integrity-probe.ts`). It never string-matches a
 * probe's secret; every span is derived from the SHAPE of the conversation — a
 * proper noun, a figure, a general sensitivity lexicon, a "diagnosed with ___"
 * object. Passing the leak-rate metric by hardcoding "Brightwave"/"lupus"/"4200"
 * would be the treadmill the refocus diagnosed; nothing here does that.
 *
 * ★ THE SAFE DIRECTION IS INVERTED from the grounding matcher. There a false
 * positive (firing when it should not) is the felt failure; here a MISS (a leaked
 * secret) is catastrophic and an over-suppression is merely a slightly terser
 * draft. So arming is narrow but extraction leans broad, and the probe invariant —
 * a forbidden span never appears in the final drafting turn — means the
 * "exclude anything in the prompt" rule can never strip a real secret, only the
 * intended recipient and details the user chose to include.
 */

/** A conversation turn, shaped like the message list `useChat` sends the model. */
export type IntegrityTurn = { readonly role: string; readonly content: string };

/** The guard decision for one turn. */
export type PrivacyGuard = {
  /** Whether the guard is armed for this turn (privacy marker + a draft ask). */
  readonly armed: boolean;
  /**
   * The spans that must NOT appear in the drafted reply. Empty when not armed.
   * Surface forms as they occur in the history, deduped case-insensitively.
   */
  readonly forbiddenSpans: readonly string[];
};

// ─── Trigger: privacy marker in history ─────────────────────────────────────

/**
 * Phrases by which a user flags something as private / not-to-be-shared. General
 * everyday forms, not tuned to any fixture — each fires on ordinary secrecy
 * language ("just between us", "nobody knows", "keep it confidential"). Bounded
 * `.{0,30}` gaps only, no nested quantifiers, so it runs linearly.
 */
const PRIVACY_MARKER =
  /\b(?:between us|between you and me|off the record|in confidence|confidential(?:ly)?|(?:it'?s|its|that'?s|thats|this is|keep it|keeping it|keep this|keep that|stays?|staying|remains?)\b[^.?!\n]{0,15}?\b(?:private|confidential|personal|secret|between us)|no ?body (?:knows|else knows)|no one (?:knows|else knows)|no idea|keep it that way|keep (?:it|this|that|the)\b[^.?!\n]{0,30}?\b(?:secret|quiet|private|confidential|between us|to yourself)|stays? a secret|it'?s a secret|a secret\b|not telling|(?:have|has|had|hav)?n'?t (?:told|been told)|not (?:told|been told)|rather\b[^.?!\n]{0,30}?\bnot (?:know|tell|say|share|mention)|would rather\b[^.?!\n]{0,30}?\bnot|do(?:es|)?n'?t want\b[^.?!\n]{0,30}?\b(?:know|knowing|find out|finding out|tell|say|share|mention)|can'?t (?:say|tell|let it slip)|can'?t let\b[^.?!\n]{0,20}?\bslip|asked me not to tell|not to tell anyone|without\b[^.?!\n]{0,20}?\bknowing|only one\b[^.?!\n]{0,20}?\b(?:said|told)|keep (?:the |it |this |that )?(?:number|figure|price|amount|reason|detail)s?\b[^.?!\n]{0,20}?\b(?:private|confidential|secret|quiet|to (?:myself|yourself)))\b/i;

/** True when any USER history turn carries a privacy marker. */
function hasPrivacyMarker(history: readonly IntegrityTurn[]): boolean {
  return history.some(
    (turn) => turn.role === "user" && PRIVACY_MARKER.test(turn.content),
  );
}

// ─── Trigger: the current turn drafts new correspondence ────────────────────

/**
 * Verbs that author a NEW message (not correct/summarise the user's OWN text —
 * proofread/summarise stay out on purpose: that text is the user's to control, so
 * suppressing from it would be wrong). "email"/"text" double as the artifact noun.
 */
const AUTHOR_VERB = /\b(?:write|draft|compose|pen|send|email|text|message|reply)\b/i;

/** The correspondence artifacts a draft-to-a-third-party turn asks for. */
const CORRESPONDENCE_NOUN =
  /\b(?:message|email|e-mail|letter|note|text|reply|response|invite|invitation|card|dm|memo)\b/i;

/**
 * True when the turn asks to author correspondence — an author verb AND a
 * correspondence noun in the same turn (or an author verb that IS the noun, like
 * "email my boss"). Robust to sentence lead-ins ("yeah write…", bare imperatives)
 * where `buildArtifactFrame`'s request-shape gate abstains.
 */
function isDraftRequest(prompt: string): boolean {
  return AUTHOR_VERB.test(prompt) && CORRESPONDENCE_NOUN.test(prompt);
}

// ─── Extraction: the candidate private spans ────────────────────────────────

/**
 * General sensitivity lexicon — CATEGORY words for the life events people mark as
 * private. Not fixture secrets: each fires on the category in ANY conversation
 * ("interviewing", "diagnosed", "pregnant", "laid off", "promotion"), never on a
 * specific planted noun (those are caught structurally, as proper nouns / figures).
 * Multi-word entries are matched as phrases by {@link matchesTerm}.
 */
const SENSITIVE_TERMS: readonly string[] = [
  "interview", "interviewing", "interviewed",
  "diagnosed", "diagnosis",
  "surgery", "operation", "chemo", "chemotherapy", "hospital", "clinic",
  "pregnant", "pregnancy", "expecting", "miscarriage", "ivf",
  "laid off", "redundancy", "redundant", "fired", "sacked",
  "resigning", "resigned", "quitting",
  "promotion", "promoted",
  "relocating", "relocation",
  "divorce", "divorcing", "separating", "affair",
  "therapy", "rehab", "bankruptcy", "arrested",
];

/**
 * Object-capture leads: the private thing is the OBJECT of one of these ("diagnosed
 * with lupus" → "lupus"). A general grammatical rule that pins a sensitive
 * common-noun span the lexicon and the proper-noun scan both miss.
 */
const OBJECT_CAPTURE =
  /\b(?:diagnosed with|diagnosis of|suffering from|battling|struggling with)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)/gi;

/**
 * Common capitalised words that are NOT entities — sentence openers, days, months,
 * pronouns. A capitalised token whose lowercase form is here is never a private
 * proper noun (it is sentence casing or a calendar word the recap layer owns).
 */
const COMMON_CAPITALISED = new Set(
  [
    "I", "I'm", "I've", "I'll", "I'd",
    "The", "A", "An", "And", "But", "So", "Or", "If", "As", "At", "In", "On",
    "Of", "To", "For", "My", "Our", "Your", "His", "Her", "Its", "Their",
    "This", "That", "These", "Those", "It", "He", "She", "They", "We", "You",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "January", "February", "March", "April", "May", "June", "July", "August",
    "September", "October", "November", "December",
    "OK", "Okay", "Hi", "Hey", "Hello", "Thanks", "Please", "Yeah", "Yes", "No",
  ].map((w) => w.toLowerCase()),
);

/** Whether a token reads as a proper-noun candidate: initial capital, letters. */
function looksLikeProperNoun(token: string): boolean {
  return /^\p{Lu}[\p{L}'’-]*$/u.test(token) && !COMMON_CAPITALISED.has(token.toLowerCase());
}

/**
 * Proper nouns in one turn: capitalised tokens (and maximal capitalised runs) that
 * are NOT sentence-initial — sentence-opening capitals are casing, not entities.
 * Both the run ("Golden Lion") and its tokens are returned so redaction catches the
 * span however it resurfaces.
 */
function extractProperNouns(text: string): string[] {
  const found: string[] = [];
  // Split into sentences so the first word of each is treated as sentence-initial.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const tokens = sentence.trim().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
    let run: string[] = [];
    const flushRun = (): void => {
      if (run.length > 1) found.push(run.join(" "));
      run = [];
    };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === undefined || token === "") {
        flushRun();
        continue;
      }
      const sentenceInitial = i === 0;
      if (!sentenceInitial && looksLikeProperNoun(token)) {
        found.push(token);
        run.push(token);
      } else {
        flushRun();
      }
    }
    flushRun();
  }
  return found;
}

/**
 * Distinctive figures in one turn: runs of 3+ digits (a salary, a price), plus any
 * number sitting next to a currency marker. Small day/time numbers are left out —
 * they are rarely the secret and often the audience's own detail — and anything the
 * user put in the drafting request is excluded downstream regardless.
 */
function extractFigures(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\b\d{3,}\b/g)) {
    found.push(match[0]);
  }
  // Currency-adjacent smaller numbers ("$50", "20 dollars", "£90").
  for (const match of text.matchAll(
    /(?:[$£€]\s?(\d[\d,]*)|(\d[\d,]*)\s?(?:dollars|pounds|euros|usd|gbp|eur|quid|bucks|k\b))/gi,
  )) {
    const raw = (match[1] ?? match[2] ?? "").replace(/,/g, "");
    if (raw !== "") found.push(raw);
  }
  return found;
}

/** Sensitive-category terms present in one turn, in their surface form. */
function extractSensitiveTerms(text: string): string[] {
  return SENSITIVE_TERMS.filter((term) => matchesTerm(text, term));
}

/** A trailing connective/stopword the object capture must not swallow. */
const TRAILING_CONNECTOR = /\s+(?:and|or|but|so|the|a|an|that|which|with|plus|then|i|ive|i've)$/i;

/** "diagnosed with X" style objects in one turn ("diagnosed with lupus" → "lupus"). */
function extractCapturedObjects(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(OBJECT_CAPTURE)) {
    // The two-word capture can trail a connector ("lupus and …") — trim it so the
    // span is the condition itself, matchable whole-word against a leak.
    const object = match[1]?.trim().replace(TRAILING_CONNECTOR, "").trim();
    if (object !== undefined && object !== "") found.push(object);
  }
  return found;
}

/**
 * The BACKGROUND turns: everything before the current drafting turn. Robust to two
 * calling conventions — `useChat` passes the FULL message list (the current turn is
 * its last user element, a duplicate of `prompt`), while the eval harness passes the
 * prior turns only with `prompt` separate. A trailing user turn that duplicates
 * `prompt` is dropped so the current turn is never double-counted as background.
 */
function backgroundTurns(
  history: readonly IntegrityTurn[],
  prompt: string,
): readonly IntegrityTurn[] {
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx >= 0 && (history[lastUserIdx]?.content ?? "").trim() === prompt.trim()) {
    return history.filter((_, i) => i !== lastUserIdx);
  }
  return history;
}

function extractPrivateSpans(
  background: readonly IntegrityTurn[],
  prompt: string,
): string[] {
  // EXCLUDABLE candidates — the background. Proper nouns and figures come from the
  // user's own background turns only (never forbid a name the assistant introduced);
  // sensitive category vocabulary and "diagnosed with X" objects come from every
  // background turn (an assistant echo — "keep the pregnancy quiet" — is a fine
  // source for a category word the user inflected differently). These are filtered
  // against the drafting request: the recipient and dates the user chose to include
  // are excluded, and the probe invariant guarantees a real background secret is
  // never in the request, so nothing private is ever lost this way.
  const excludable: string[] = [];
  for (const turn of background) {
    if (turn.role === "user") {
      excludable.push(...extractProperNouns(turn.content), ...extractFigures(turn.content));
    }
    excludable.push(...extractSensitiveTerms(turn.content), ...extractCapturedObjects(turn.content));
  }

  // NON-EXCLUDABLE candidates — the SINGLE-TURN shape (the classic "nora" repro),
  // where the private detail, the privacy marker and the draft ask all sit in ONE
  // turn. Its sensitive detail IS the request, so it cannot be prompt-excluded; it
  // is only harvested when the current turn itself carries a privacy marker (a
  // normal writing turn's own words are never mined). Proper nouns are deliberately
  // NOT taken here — the recipient lives in this turn — but sentence-level redaction
  // still removes a co-located lowercase name when a sensitive term in the same
  // sentence is caught.
  const nonExcludable: string[] = [];
  if (PRIVACY_MARKER.test(prompt)) {
    nonExcludable.push(
      ...extractSensitiveTerms(prompt),
      ...extractCapturedObjects(prompt),
      ...extractFigures(prompt),
    );
  }

  const seen = new Set<string>();
  const spans: string[] = [];
  const add = (span: string): void => {
    const key = span.toLowerCase();
    if (span.length < 2 || seen.has(key)) return;
    seen.add(key);
    spans.push(span);
  };
  for (const span of excludable) {
    if (matchesTerm(prompt, span)) continue;
    add(span);
  }
  for (const span of nonExcludable) add(span);

  // Longest first: redact "Golden Lion" before "Golden", so a run never leaves a
  // stray capitalised remnant behind.
  return spans.sort((a, b) => b.length - a.length);
}

/**
 * Derive the guard for the current turn: armed when a privacy marker sits in the
 * history AND the turn drafts new correspondence; the forbidden spans are the
 * private detail extracted from the user's own turns.
 */
export function derivePrivacyGuard(
  history: readonly IntegrityTurn[],
  prompt: string,
): PrivacyGuard {
  // Armed on the TRIGGER (privacy marker + a draft ask), independent of what the
  // extractor finds: an armed turn with no extractable span is an honest miss (the
  // fragile seam), not a reason to disarm. Callers act only when a span both exists
  // and actually resurfaces in the draft. The marker may sit in the background
  // (multi-turn) OR in the drafting turn itself (single-turn "nora" shape).
  const background = backgroundTurns(history, prompt);
  const markerPresent = hasPrivacyMarker(background) || PRIVACY_MARKER.test(prompt);
  const armed = isDraftRequest(prompt) && markerPresent;
  if (!armed) {
    return { armed: false, forbiddenSpans: [] };
  }
  return { armed: true, forbiddenSpans: extractPrivateSpans(background, prompt) };
}

// ─── Detection + guarantee ──────────────────────────────────────────────────

/**
 * Whole-token match tolerating a simple plural — the SAME semantics the leak-rate
 * scorer uses (`rubric.mentionsRuledOutTerm`), reproduced here so production never
 * depends on the eval module: `Rolex` matches "Rolexes", `4200` matches "4200",
 * multi-word "laid off" matches as a phrase. Not a prefix match (so `spa` never
 * fires on "Spain"). Case-insensitive.
 */
export function matchesTerm(text: string, term: string): boolean {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<!\\w)${escaped}(?:e?s)?(?!\\w)`, "i").test(text);
}

/** The forbidden spans that resurfaced in `text` (the leak, if any). */
export function findLeaks(text: string, spans: readonly string[]): string[] {
  return spans.filter((span) => matchesTerm(text, span));
}

/** One regex matching ANY forbidden span, whole-token + plural, case-insensitive. */
function spanRegex(spans: readonly string[]): RegExp | null {
  const parts = spans
    .filter((s) => s.trim() !== "")
    .map((s) => s.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return null;
  return new RegExp(`(?<!\\w)(?:${parts.join("|")})(?:e?s)?(?!\\w)`, "gi");
}

/**
 * Remove every forbidden span from a drafted reply — the deterministic guarantee.
 *
 * Works at SENTENCE granularity within each line: the leak almost always rides an
 * over-explaining sentence ("The real reason is I'm interviewing at Brightwave"),
 * so dropping the whole sentence yields a clean, natural draft where blanking words
 * would leave "…interviewing at ." A line emptied of all its sentences is dropped,
 * and runs of blank lines are collapsed, so an email keeps its shape.
 *
 * GUARANTEE: after the sentence pass, a final whole-token strip removes any span
 * that survived (e.g. one straddling a sentence boundary), so the result provably
 * contains no forbidden span. If redaction would empty the draft entirely, the
 * word-stripped original is returned rather than nothing.
 */
export function redactPrivateSpans(text: string, spans: readonly string[]): string {
  const re = spanRegex(spans);
  if (re === null || text.trim() === "") return text;

  const containsSpan = (segment: string): boolean => {
    re.lastIndex = 0;
    return re.test(segment);
  };

  const cleanedLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      cleanedLines.push("");
      continue;
    }
    // Split into sentences, keeping their terminators, and drop any that leak.
    const sentences = line.match(/[^.!?]+[.!?]*\s*/g) ?? [line];
    const kept = sentences.filter((sentence) => !containsSpan(sentence));
    cleanedLines.push(kept.join("").replace(/\s+$/g, ""));
  }

  let result = cleanedLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Final guarantee: strip any span that survived a sentence boundary, then tidy.
  result = result
    .replace(re, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (result === "") {
    // Never return an empty draft — hand back the original with spans stripped.
    const stripped = text.replace(re, "").replace(/[ \t]{2,}/g, " ").trim();
    return stripped;
  }
  return result;
}

// ─── Quality-first regeneration frame ───────────────────────────────────────

/**
 * The hardened regeneration prompt for an armed, leaking draft: a system
 * instruction and a rewritten last user turn that name the exact spans to withhold
 * and tell the model to refer to any private reason only as "a personal matter".
 * Regeneration runs BEFORE {@link redactPrivateSpans}, for prose the redactor
 * cannot better; the redactor remains the guarantee if the model leaks again.
 *
 * The forbidden list is host-derived, so it is safe to name to the model (it is the
 * user's own detail, being withheld from a third party, not injected content).
 */
export function buildIntegrityRepairPrompt(
  userPrompt: string,
  spans: readonly string[],
): { systemInstruction: string; userPrompt: string } {
  const list = spans.join(", ");
  return {
    systemInstruction:
      "The previous draft leaked private background into a message meant for someone else. " +
      "Rewrite the requested message so it does the asked-for job and does NOT mention, hint at, or allude to any of these private details: " +
      `${list}. ` +
      "If a reason is needed, refer to it only as \"a personal matter\". Return the corrected message only.",
    userPrompt:
      `${userPrompt}\n\n` +
      `Important: do not mention ${list} anywhere in the message. ` +
      "Keep the private reason to yourself — say \"a personal matter\" if a reason is needed.",
  };
}
