// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import {
  DEFAULT_TIMEOUT_MS,
  getWikidataStatement,
  lookupWikipedia,
  searchWikipediaFulltext,
} from "../grounding";
import type { WikipediaResult } from "../grounding";
import {
  FENCE_ANSWER_INSTRUCTION,
  FENCE_CLOSE,
  FENCE_OPEN,
  FENCE_PREAMBLE,
  MAX_TITLE_LEN,
  neutralizeFenceMarkers,
} from "../grounding/fence";
import {
  buildPassageNote,
  fetchArticlePlainText,
  selectPassages,
  type FetchArticleTextFn,
} from "../grounding/passages";
import type {
  EcoCitation,
  EcoTool,
  EcoToolResult,
  GroundingVerification,
  ToolMatchContext,
} from "./registry";

/**
 * The Wikipedia/Wikidata grounding tool (#5 Slice 2).
 *
 * Host-driven, like the deterministic tools: `match` decides candidacy AND
 * extracts the entity; `execute` composes the S1 lookup primitives
 * ({@link lookupWikipedia} + {@link getWikidataStatement}) into a context note the
 * model phrases in its own voice (the host renders the citation chip from the
 * structured result — the model itself writes no source lines or URLs). Unlike
 * calculator/datetime/unit, the tool does NOT stamp
 * a verbatim answer — the model writes the prose — and its decisive contribution is
 * the DECLINE: when no reliable source exists (the fictional-town case), it injects
 * an instruction to admit "I don't have a source" instead of confabulating. That
 * decline is the whole point — it kills the #1 felt defect (confident hallucination
 * on factual/entity questions at the 1–2B model scale).
 *
 * `match` is asymmetric on purpose. A false positive — grounding firing on "write me
 * a poem about Paris" — is the felt failure; a miss just degrades to today's normal
 * chat, which is cheap. So `match` abstains by default and demands ALL of: a factual
 * cue, an extractable entity (or, on a follow-up turn, a subject carried from a
 * prior grounded turn), and absence from the deny-set. Precision over recall.
 *
 * Extraction prefers the high-confidence Title-Case / quoted-span paths. Three
 * lower-confidence recall layers run only when those miss, in order: lowercase
 * recovery ("what is the population of paris" — real users type lowercase), the
 * follow-up path (a factual anaphora/elliptical turn re-grounds the previously
 * grounded subject), and — LAST, only when no entity is extractable at all — a
 * zero-entity full-text query ("how many calories in an apple"). Each carries its
 * own mode/confidence so `execute` keeps the precision posture downstream: a
 * dubious hit becomes a HEDGE (low / followup / full-text) — calibrated "I don't
 * have a verified source", never a wrong hard decline and never a silent drop of a
 * factual-shaped ask. Only a high-confidence miss still hard-declines.
 */

/** Extracted args for the grounding tool. */
export type GroundingArgs = {
  /**
   * The entity to look up — a Title-Case span, quoted span, recovered lowercase
   * span, or (on the follow-up path) the previously grounded resolved title.
   *
   * EXCEPTION — when {@link fulltext} is `true`, this is NOT an entity: it is the
   * cleaned keyword CORPUS (stopword-stripped, case-folded user words) that anchors
   * the inverted coverage gate and the quiet display strings, because the turn
   * carried no extractable entity at all. It is NOT what gets searched — that is
   * {@link searchText}.
   */
  entity: string;
  /**
   * A Wikidata property to ALSO fetch (e.g. "P1082" population), or `null` when the
   * article extract alone answers the question.
   */
  wikidataProperty: string | null;
  /**
   * Extraction confidence. `"high"` (default when omitted) = quoted / Title-Case
   * span; `"low"` = the lowercase-recovery path. On a found hit whose title does
   * NOT cover the entity, `execute` hard-declines for high confidence (the
   * subject likely doesn't exist) and HEDGES for low confidence (extraction noise
   * is the likelier explanation — the turn is factual-shaped, so the user deserves
   * a calibrated "I don't have a verified source", never a false "no source exists").
   *
   * `"followup"` is categorically different: the entity is NOT extracted from
   * the turn at all — it is the PREVIOUSLY GROUNDED resolved title (a real
   * Wikipedia article we cited a turn ago), carried in via the conversation
   * context for a pronoun/elliptical follow-up ("how tall is it?"). Because the
   * subject is already KNOWN to exist, a coverage-gate miss or a no-match lookup
   * is NOISE (a redirect, a transient index quirk), never evidence the subject
   * doesn't exist — so `execute` HEDGES instead of hard-declining (a "no source
   * exists" claim would be false) and never silently abstains (the user asked a
   * follow-up; silence is the worse outcome). Network failures stay soft-degraded.
   *
   * Ignored when {@link fulltext} is `true` (that path has its own miss semantics).
   */
  confidence?: "high" | "low" | "followup";
  /**
   * `true` selects the ZERO-ENTITY full-text recall path (chat #7 W2.2 T3): the
   * turn was factual-shaped but no entity was extractable by ANY path (quoted,
   * Title-Case, lowercase recovery, follow-up), so {@link entity} carries the
   * cleaned keyword corpus instead of an entity. `execute` then full-text-searches
   * {@link searchText} (the raw question), accepts the first top-3 article whose
   * title is covered by the cleaned {@link entity} tokens (the inverted gate), and
   * HEDGES on any miss/disambiguation (never hard-declines — a question resolving
   * nowhere is not proof the topic has no source). Omitted/`false` ⇒ the normal
   * entity path. Mutually exclusive with `confidence`.
   */
  fulltext?: boolean;
  /**
   * Full-text mode only: the string actually SENT to the search endpoint — the
   * user's trimmed raw turn, length-capped at FULLTEXT_SEARCH_MAX_CHARS (defensive
   * bounding only; a turn that qualifies for fulltext is naturally short).
   *
   * Why the raw turn and not the cleaned {@link entity}: CirrusSearch ranks
   * natural-language queries BETTER than stopword-stripped keyword strings — the
   * function words help. The research spike (2026-06-11) showed the raw "how many
   * calories in an apple" returns "Apple" as result #1, while the live walk showed
   * the cleaned "calories apple" ranks junk ("Negative-calorie food", "CalorieMate",
   * "One-hot") that the inverted gate then (correctly) rejects into a hedge. The
   * cleaned {@link entity} stays the gate's precision anchor — strictly tighter.
   * When absent, `execute` falls back to {@link entity} (older-shaped args).
   */
  searchText?: string;
};

function isGroundingArgs(value: unknown): value is GroundingArgs {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const entityOk = typeof v.entity === "string" && v.entity.trim() !== "";
  const propOk = v.wikidataProperty === null || typeof v.wikidataProperty === "string";
  const confidenceOk =
    v.confidence === undefined ||
    v.confidence === "high" ||
    v.confidence === "low" ||
    v.confidence === "followup";
  const fulltextOk = v.fulltext === undefined || typeof v.fulltext === "boolean";
  const searchTextOk =
    v.searchText === undefined ||
    (typeof v.searchText === "string" && v.searchText.trim() !== "");
  return entityOk && propOk && confidenceOk && fulltextOk && searchTextOk;
}

// ---------------------------------------------------------------------------
// match — abstain-by-default candidacy gate + entity extractor.
//
// Layered guards, mirroring the calculator's style: a deny-set short-circuit, a
// factual-cue requirement, and a precise entity extractor. ALL must pass.
// ---------------------------------------------------------------------------

/**
 * Interrogative cues that signal a factual question. Word-boundary anchored,
 * case-insensitive.
 *
 * Bare "how" rather than the former explicit "how many/much/tall/old/far/…" list:
 * that list missed ordinary comparative asks ("How does this compare to South
 * Korea?") entirely, so a genuine factual question carried no cue at all and the
 * only cue found came from the article the user had pasted above it — grounding
 * then fired on a subject lifted out of the paste. Broadening the word is safe
 * ONLY because a match must also be question-positioned; see
 * {@link isAskingAQuestion}, which is what stops a mid-paragraph "what" in body
 * prose from reading as an interrogative.
 */
const INTERROGATIVE_CUE =
  /\b(?:who|what|whats|what's|where|when|which|whose|how)\b/i;

/**
 * Factual attribute nouns. Their presence (with an entity) signals a fact-shaped
 * turn even without a leading interrogative — e.g. "the population of Tokyo".
 * Deliberately focused: each is an attribute a Wikipedia/Wikidata fact answers.
 */
const FACTUAL_ATTRIBUTE =
  /\b(?:population|capital|located|location|founded|established|born|died|height|area|currency|languages?|elevation|nationality|invented|discovered|author|director|president|prime minister)\b/i;

/**
 * "tell me about" / "what is" / "who is" leads that introduce an entity for a
 * straight factual lookup. Paired with the entity extractor below — the lead alone
 * never matches (a deny-set creative imperative like "tell me a joke" is screened
 * first, and "what is 17 x 23" has no extractable Title-Case entity).
 */
const LOOKUP_LEAD =
  /\b(?:tell me about|what(?:'s| is| are)|whats|who(?:'s| is| are|s)|where(?:'s| is)|when (?:was|were|did|is))\b/i;

/**
 * Deny-set: turns that contain a cue + entity but are NOT factual-lookup requests.
 * Mirrors the layered-guard idiom — small, focused, well-commented regexes. If ANY
 * fires, abstain (grounding firing on these is the felt failure we defend against).
 */
const DENY_PATTERNS: readonly RegExp[] = [
  // Creative / imperative authoring — "write me a poem about Paris".
  /\b(?:write|compose|draft|poem|story|stories|song|essay|joke|jokes|rap|haiku|lyrics|make up|made up|invent|imagine|pretend|roleplay|role-play)\b/i,
  // Editing / transforming the user's OWN text — "proofread this", "fix the
  // grammar", "check it for mistakes". The turn SUPPLIES the text and asks for it
  // to be corrected; nothing external is being asked, so a lookup adds nothing and
  // (measured 2026-08-10) attaches a real citation to an edit — grounding
  // "Edinburgh Castle" while proofreading a note that merely mentions it, with a
  // false "I looked this up from a real source" claim on a task that needed no
  // source. This is the editing sibling of the authoring deny above (write/compose/
  // draft), and mirrors artifact-frame.ts's correction vocabulary. The bare verbs
  // proofread/rewrite/reword/rephrase are self-evidently about the user's text;
  // fix/correct/check/improve/polish require an editing OBJECT nearby so a factual
  // "check the population of Tokyo" or "what mistakes did Napoleon make" still grounds.
  /\b(?:proofread|rewrite|re-?write|reword|rephrase|retype)\b/i,
  /\b(?:fix|correct|check|improve|polish|clean up|tidy up)\b[^.?!\n]{0,30}\b(?:spelling|grammar|typos?|punctuation|mistakes?|wording|phrasing|errors?)\b/i,
  /\b(?:spelling|grammar|typos?|punctuation|wording|phrasing)\b[^.?!\n]{0,30}\b(?:fix|correct|check|improve|polish)\b/i,
  // Opinion / advice / recommendation — subjective, not fact-grounded.
  /\b(?:what do you think|do you think|your opinion|in your opinion|should i|is it worth|worth it|recommend|suggest|best (?:place|restaurant|book|movie|city|time|way))\b/i,
  // Comparison / preference phrasing ("better than", "X vs Y").
  /(?:\bbetter than\b|\s+vs\.?\s+|\bversus\b)/i,
  // Code / programming.
  /\b(?:function|regex|javascript|typescript|python|java|rust|golang|code|debug|compile|\bapi\b|sql|algorithm)\b/i,
  // Translation.
  /\b(?:translate|translation|in french|in spanish|in german|in italian|how do you say)\b/i,
  // Meta / self-referential.
  /\b(?:who are you|what are you|what can you do|what model|your name|how are you)\b/i,
];

/**
 * Command / question stopwords that must never be taken as the entity even when
 * they sit at the front of a sentence in Title Case ("Tell me about…", "What is…").
 * Includes clause leads ("If", "While"), pronouns, and temporal words: these are
 * sentence-initial capitals, not entities — "If I buy 3 shirts at $24.99…" used
 * to extract "If I" as the entity and fire a Wikipedia lookup on shopping math
 * (audit 2026-06-09 RC5). They only block a span from STARTING, so mid-span
 * capitals ("World War I") are unaffected. Lowercased for comparison.
 */
const ENTITY_STOPWORDS = new Set(
  [
    "Who", "What", "Whats", "When", "Where", "Why", "Which", "Whose", "How",
    "Is", "Are", "Was", "Were", "Do", "Does", "Did", "Can", "Could", "Should",
    "Would", "Will", "Tell", "Write", "Explain", "Give", "List", "Describe",
    "Please", "Make", "Show", "Help", "The", "A", "An", "Of", "In", "On",
    "If", "While", "Although", "Though", "Since", "Because", "After", "Before",
    "Once", "Unless", "Whether", "And", "But", "So", "Also", "Then", "Now",
    "Today", "Tomorrow", "Yesterday", "Just", "Maybe", "Perhaps",
    "I", "My", "Me", "We", "Our", "You", "Your", "He", "She", "It", "They",
    "Them", "His", "Her", "Its", "Their", "This", "That", "These", "Those",
  ].map((w) => w.toLowerCase())
);

/**
 * Lowercase connector tokens allowed INSIDE a Title-Case span ("Tower of London").
 * Tradeoff: "and" is needed for canonical country names (Trinidad and Tobago,
 * Bosnia and Herzegovina, Antigua and Barbuda), but it also joins "Obama and Biden"
 * into one span. The multi-entity case degrades to an honest Wikipedia decline on
 * the joined span, which is acceptable.
 */
const ENTITY_CONNECTORS = new Set([
  "of", "the", "and", "de", "von", "der", "da", "del", "la", "le", "el",
]);

/**
 * Extract the first non-empty quoted span. Tries matched, like-with-like quote
 * pairs in order: straight double `”…”`, typographic double `”…”`, typographic
 * single `’…’`. The ASCII apostrophe (`’`) is deliberately excluded as an
 * opening/closing delimiter — it appears in contractions (“It’s”, “don’t”) far
 * more often than as a quoting character, and lumping it in causes contractions
 * to hijack the extractor (e.g. `It’s about “DNA”` would extract garbage).
 */
function extractQuotedSpan(text: string): string | null {
  // Straight double quotes first, then typographic double, then typographic single.
  // Uses RegExp constructors with Unicode escapes for the curly quote characters so
  // the source stays pure ASCII (avoids parser issues with literal non-ASCII in regex).
  const TYPO_DOUBLE = new RegExp("\u201c([^\u201c\u201d]+)\u201d");
  const TYPO_SINGLE = new RegExp("\u2018([^\u2018\u2019]+)\u2019");
  const m =
    /"([^"]+)"/.exec(text) ??
    TYPO_DOUBLE.exec(text) ??
    TYPO_SINGLE.exec(text);
  const inner = m?.[1]?.trim();
  return inner !== undefined && inner !== "" ? inner : null;
}

/**
 * Extract the LONGEST Title-Case n-gram: a maximal run of Capitalized tokens, with
 * lowercase connectors permitted internally (never at an edge). Sentence-initial
 * command/question stopwords are excluded so "Tell"/"What"/"Who" is never the
 * entity. Returns the cleaned span, or `null` when nothing qualifies.
 */
function extractTitleCaseEntity(text: string): string | null {
  // Tokenize on whitespace, keeping the trailing punctuation off each word.
  const tokens = text.split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));

  // Internal hyphens are part of the token ("Blandford-Quist", "Jean-Paul"):
  // without them the extractor silently DROPS the hyphenated surname, producing
  // an under-specified entity ("Marjorie") whose lookup grounds the wrong
  // article (audit 2026-06-09 RC4). Apostrophes stay excluded — admitting them
  // would let contractions ("It's") start spans.
  const isCapitalized = (tok: string): boolean =>
    /^\p{Lu}[\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)*$/u.test(tok);
  const isConnector = (tok: string): boolean => ENTITY_CONNECTORS.has(tok.toLowerCase());
  const isStopword = (tok: string): boolean => ENTITY_STOPWORDS.has(tok.toLowerCase());

  let best: string[] = [];
  let current: string[] = [];

  const flush = (): void => {
    // Trim trailing connectors (a span never ends on "of"/"the"/…).
    let last = current[current.length - 1];
    while (last !== undefined && isConnector(last)) {
      current.pop();
      last = current[current.length - 1];
    }
    if (current.length > best.length) {
      best = current;
    }
    current = [];
  };

  for (const tok of tokens) {
    if (tok === "") {
      flush();
      continue;
    }
    if (isCapitalized(tok)) {
      // A capitalized stopword can only START a run as a sentence-initial command
      // word — drop it and keep scanning (so "Tell me about the Eiffel Tower" still
      // yields "Eiffel Tower", and "What is France?" still yields "France").
      if (current.length === 0 && isStopword(tok)) {
        continue;
      }
      current.push(tok);
      continue;
    }
    if (current.length > 0 && isConnector(tok)) {
      // Lowercase connector continues the span ONLY if more capitals follow; the
      // trailing-connector trim in flush() removes it otherwise.
      current.push(tok);
      continue;
    }
    flush();
  }
  flush();

  if (best.length === 0) {
    return null;
  }
  return best.join(" ").trim();
}

/**
 * The query→PID map. Intentionally tiny and extensible: inspect the text for an
 * attribute we have a structured property for, and return its Wikidata PID. Ships
 * only P1082 (population) this slice; add rows as more attributes are grounded.
 */
const PROPERTY_INTENTS: readonly { readonly pid: string; readonly pattern: RegExp }[] = [
  {
    pid: "P1082", // population
    pattern: /\b(?:population|how populous)\b|how many (?:people|residents|inhabitants)/i,
  },
];

function detectWikidataProperty(text: string): string | null {
  for (const intent of PROPERTY_INTENTS) {
    if (intent.pattern.test(text)) {
      return intent.pid;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lowercase recovery (audit follow-up 2026-06-10).
//
// Real users type lowercase — "where was mark zuckerberg born" — so Title-Case-
// only extraction meant grounding essentially NEVER fired for them (observed
// live: a full session of factual questions with zero lookups, while the model
// hallucinated freely). Recovery is lead-anchored and runs LAST, only when the
// high-confidence extractors found nothing. Its hits carry confidence:"low",
// and `execute` ABSTAINS (not declines) when the resolved title doesn't cover a
// low-confidence entity. The titleCoversEntity gate is what makes this recall
// affordable: an irrelevant fuzzy hit can no longer inject "authoritative
// facts" about the wrong subject.
// ---------------------------------------------------------------------------

/** Question leads that anchor a lowercase entity span (the capture group). */
const LOWERCASE_LEAD =
  /\b(?:who(?:'s| is| was| are)|where(?:'s| is| was)|what(?:'s| is| are| was)|when (?:was|did|is)|how (?:old|tall|big|far) (?:is|was)|tell me about|teach me about)\s+(.+)$/i;

/** Attribute lead-ins stripped off a recovered span ("the capital of france" → "france"). */
const ATTRIBUTE_PREFIX =
  /^(?:the\s+)?(?:population|capital|height|area|currency|president|prime minister|elevation|location|history|age|founder|ceo|author|director)\s+of\s+/i;

/**
 * Trailing qualifiers stripped off a recovered span ("mark zuckerberg born" →
 * "mark zuckerberg"). "about"/"like" matter most: "what is one piece about"
 * must recover "one piece" — observed live (2026-06-10): the un-stripped span
 * failed the coverage gate, grounding abstained, and the model perseverated on
 * the PREVIOUS conversation topic instead of switching to the asked one. A
 * grounded note is what forces a small model onto the new subject.
 */
const TRAILING_QUALIFIER =
  /\s+(?:born|from|located|founded|established|made|invented|discovered|now|today|currently|about|like)\s*$/i;

/**
 * Recover a lowercase entity span from a lead-anchored question, or null. The
 * span is bounded to 1–5 words and rejected when it is stopwords/pronouns only
 * ("who is he"). @internal Exported for unit testing.
 */
export function extractLowercaseEntity(text: string): string | null {
  const m = LOWERCASE_LEAD.exec(text);
  const raw = m?.[1]?.trim();
  if (raw === undefined || raw === "") {
    return null;
  }
  let span = raw.replace(/[?!.]+\s*$/g, "").trim();
  span = span.replace(ATTRIBUTE_PREFIX, "");
  span = span.replace(TRAILING_QUALIFIER, "");
  span = span.replace(/^(?:the|a|an)\s+/i, "").trim();

  const words = span.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0 || words.length > 5) {
    return null;
  }
  if (!/\p{L}/u.test(span)) {
    return null;
  }
  // Digits mean arithmetic ("17 times 23") or other non-entity asks far more
  // often than digit-bearing proper nouns at this confidence level — and the
  // calculator matches first in the registry anyway. Precision over recall.
  if (/\d/.test(span)) {
    return null;
  }
  if (words.every((w) => ENTITY_STOPWORDS.has(w.toLowerCase()))) {
    return null;
  }
  return span;
}

// ---------------------------------------------------------------------------
// Zero-entity keyword-query builder (chat #7 W2.2 T3).
//
// Some factual asks carry NO extractable entity at ANY confidence level: no
// quoted/Title-Case span, no lowercase-recovery lead anchor ("how many calories
// in an apple" — "how many" isn't a recovery lead). These used to abstain
// entirely and the model hallucinated confidently. Full-text search resolves such
// a natural-language question to the right ARTICLE — and CirrusSearch ranks the
// RAW question far better than a stripped keyword string (live walk 2026-06-11:
// "calories apple" returned junk; the raw question returns "Apple" #1), so the raw
// turn is what gets searched. This builder's cleaned content tokens instead do two
// jobs: candidacy shaping (2–8 content tokens = lookup-shaped) and serving as the
// inverted coverage gate's precision corpus.
//
// It runs LAST in match — only after every entity path AND the follow-up path
// have missed — and its hits flow to execute as `fulltext:true`, where an inverted
// coverage gate keeps the precision posture (the article title must be covered by
// the user's OWN words, or it hedges rather than grounds a fuzzy mismatch).
// ---------------------------------------------------------------------------

/**
 * Interrogative qualifier words that ENTITY_STOPWORDS doesn't cover — the tails of
 * "how many/much/…" and bare quantity/degree words. These are question scaffolding,
 * not content, so the keyword query drops them alongside ENTITY_STOPWORDS.
 *
 * These were once the explicit "how …" alternatives of INTERROGATIVE_CUE, kept in
 * sync with it. That cue is now bare "how" plus a question-position requirement, so
 * this set stands on its own: it exists purely to strip quantity/degree scaffolding
 * out of a keyword query, and adding a word here no longer affects candidacy.
 */
const QUERY_QUALIFIER_WORDS = new Set([
  "many", "much", "tall", "old", "far", "big", "high", "long", "large", "deep",
  "populous",
]);

/** A keyword query needs at least this many content tokens (1 is too ambiguous). */
const MIN_QUERY_TOKENS = 2;
/** …and at most this many (beyond this it isn't a lookup-shaped ask). */
const MAX_QUERY_TOKENS = 8;

/**
 * Defensive bound on the raw turn sent as the full-text search string. A turn that
 * qualifies for the zero-entity path is naturally short (2–8 content tokens), but
 * nothing above caps total LENGTH — a stopword-padded turn could be arbitrarily
 * long, and an unbounded user string should never flow into a request URL.
 */
const FULLTEXT_SEARCH_MAX_CHARS = 200;

/**
 * The zero-entity path additionally requires the turn to LEAD with an interrogative
 * (anchored at the start, like the lowercase-recovery lead). A real zero-entity
 * lookup OPENS with a question word ("how many calories…", "what affects…"); a
 * conversational musing that merely CONTAINS one mid-sentence does not. Without this
 * anchor, "Today I wonder what time it is" cleaned to a junk query "wonder time" and
 * "and i was also wondering about the population…" full-texted a ramble (both caught
 * by the false-positive corpus). Known recall cost, accepted: a bare attribute-of
 * ask with no leading interrogative ("the boiling point of water") is intentionally
 * not recalled by EITHER path — lowercase recovery needs a "what is/who is" lead
 * anchor and this path needs a leading interrogative, so only the
 * interrogative-led form ("what is the boiling point of water") grounds, via
 * lowercase recovery before this path is even reached. Precision over recall.
 */
const FULLTEXT_LEAD =
  /^\s*(?:how|what|whats|what's|which|who|whose|where|when|why|does|do|did|is|are|was|were|can|could|would|will|should)\b/i;

/**
 * Build the cleaned content-token corpus from a factual-cue turn whose entity
 * extraction ALL missed, or `null` when the turn isn't lookup-shaped. NOT the
 * search string — the RAW turn is what gets searched (see GroundingArgs.searchText);
 * this corpus bounds candidacy and anchors the inverted coverage gate. Lowercases,
 * splits on non-alphanumerics, and drops {@link ENTITY_STOPWORDS} (interrogatives,
 * articles, connectors, pronouns, clause leads) + {@link QUERY_QUALIFIER_WORDS}
 * ("how many" tails). Requires {@link MIN_QUERY_TOKENS}–{@link MAX_QUERY_TOKENS}
 * surviving content tokens: 1 token is too ambiguous to gate on ("and the
 * population?" → just "population"); more than 8 is a paragraph, not a lookup.
 *
 * Rejects any turn containing a digit — consistent with the file's locked digit
 * posture (the calculator owns digit-bearing asks; digit-bearing proper nouns are
 * rarer than arithmetic at this no-entity confidence level). @internal Exported
 * for unit testing.
 */
export function buildKeywordQuery(text: string): string | null {
  if (typeof text !== "string" || /\d/.test(text)) {
    return null;
  }
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (tok) =>
        // Drop empties, single-char tokens (contraction-tail debris — "what's"
        // splits to "what" + a stray "s"; never content), stopwords, and the
        // "how many/much" qualifier tails. What's left is the query's content.
        tok.length >= 2 &&
        !ENTITY_STOPWORDS.has(tok) &&
        !QUERY_QUALIFIER_WORDS.has(tok),
    );
  if (tokens.length < MIN_QUERY_TOKENS || tokens.length > MAX_QUERY_TOKENS) {
    return null;
  }
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Follow-up (anaphora / elliptical) re-grounding (chat #7 W2.2).
//
// "tell me about the Eiffel Tower" (grounded) → "how tall is it?" used to abstain
// on turn 2 and the model free-hallucinated the height. When the conversation
// carries a recently grounded subject (context.lastGroundedTitle), a factual
// follow-up that REFERENCES that subject — by pronoun or by an elliptical
// fragment — re-grounds it against the prior resolved title.
//
// This path runs LAST, only AFTER every in-turn extractor (quoted, Title-Case,
// lowercase recovery) has missed: an explicit new entity in the turn ("how tall
// is the tower in Rome?") must always win, so the follow-up never overrides a
// subject the user actually named. It is also strictly gated behind the same
// Guard 1 (deny-set) + Guard 2 (factual cue) the in-turn paths pass through, so a
// creative/opinion turn carrying a pronoun ("write a poem about it") can never
// reach it. The follow-up entity is KNOWN to exist (it passed the coverage gate
// when first grounded), so confidence:"followup" tells `execute` to hedge — never
// hard-decline — on a miss (see GroundingArgs.confidence).
// ---------------------------------------------------------------------------

/**
 * Subject-reference pronouns / noun phrases that signal a follow-up about the
 * prior grounded subject. Deliberately SMALL — a broad anaphora resolver would
 * mis-fire on conversational "it"s. Word-boundary anchored, case-insensitive.
 * The noun-phrase forms ("the city", "that country") cover deictic references
 * the bare pronouns miss; their noun list is bounded to grounded-subject classes.
 */
const FOLLOWUP_REFERENCE =
  /\b(?:it|its|he|his|him|she|her|hers|they|their|them|there|(?:that|the|this)\s+(?:city|country|place|company|river|mountain|tower|building|person|island))\b/i;

/** Elliptical follow-ups ("and the population?") are short — a hard char bound. */
const FOLLOWUP_ELLIPTICAL_MAX_LEN = 40;

// ---------------------------------------------------------------------------
// ASK-WINDOW SCOPING (realistic-input sweep, 2026-07-27).
//
// Every guard above this line was designed, tested, and tuned against ONE input
// shape: a person typing a short question. The false-positive corpus is 30 strings
// and all 30 are short typed questions. So nothing in the design ever had to answer
// the question "what if the user PASTES something?" — and the answer turned out to
// be bad in a way no amount of regex tuning fixes, because the extractors were being
// run over text the user was SHOWING rather than text the user was ASKING WITH.
//
// Measured against a realistic-input corpus (45 samples, authored blind to this
// defect), 11 of 33 no-lookup-expected inputs produced an outbound Wikipedia
// request. Not near misses:
//   • a Python traceback sent "/Users/dana/work/pipeline/ingest.py" — the user's
//     own username and directory layout, to a third party;
//   • a pasted news article sent a quoted sentence from its body verbatim;
//   • a pasted pair of articles sent a whole 200-character sentence;
//   • an email draft sent a phrase quoted inside it.
// The quoted-span extractor has no length bound at all, so pasted prose containing
// any quotation marks hands the quoted region straight to a request URL.
//
// The fix is scope, not pattern-matching. Grounding exists to fetch a fact the user
// asked about that is NOT already in the conversation. When a user pastes a
// document, its content is already in the prompt — a lookup adds nothing and leaks
// something. So extraction is bounded to the ask window, and the raw turn is never
// read by an extractor again.
//
// Deliberately NOT solved with better entity extraction: a perfect named-entity
// recogniser handed a pasted article about Tokyo extracts "Tokyo", correctly, and
// still fires a lookup about the document the user pasted. This is a scope-and-
// consent defect, not an accuracy one.
// ---------------------------------------------------------------------------

/**
 * A turn at or under this length is one utterance — the user typed a message, so
 * the whole thing is the ask and behaviour is unchanged from before this guard.
 * Above it, the turn is treated as containing shown content and gets windowed.
 * Sized from the corpus: genuine typed factual questions cluster well under this,
 * while pasted-content turns run 500–1500 characters.
 */
const SHORT_TURN_MAX_CHARS = 280;

/** Within a windowed turn, a block longer than this is body prose, never the ask. */
const ASK_BLOCK_MAX_CHARS = 280;

/** An entity longer than this is a sentence or a paragraph, not a subject. */
const ENTITY_MAX_CHARS = 80;

/** …and one wordier than this likewise. Real long names ("Trinidad and Tobago",
 * "Structural Engineers Association") sit comfortably inside this bound. */
const ENTITY_MAX_WORDS = 6;

/**
 * Path-like / code-like shapes that are never a Wikipedia subject. Anchored on
 * structural characters (slashes, `::`, `@`) and on source/dump file extensions —
 * the debris that reaches this code when someone pastes a stack trace and asks for
 * help. A path is also the single worst thing to send outward: it carries the
 * user's account name and directory layout.
 */
const PATH_OR_CODE_LIKE =
  /[/\\@]|::|\.(?:py|js|mjs|cjs|ts|tsx|jsx|rs|go|java|rb|swift|kt|c|cc|cpp|h|hpp|cs|php|json|ya?ml|toml|ini|log|txt|md|sh|sql|html?|css|xml)\b/i;

/**
 * Spans headed by a demonstrative or possessive refer to something in the
 * conversation ("this text", "that message", "your draft") — never to a lookupable
 * subject. Without this, rejecting a sentence-initial capital simply pushes the
 * turn down to lowercase recovery, which happily returns "this text" and makes the
 * request anyway. Whack-a-mole is the failure mode this file is trying to escape,
 * so the rule closes the fallthrough too.
 */
const DEMONSTRATIVE_HEAD =
  /^(?:this|that|these|those|my|your|our|their|his|her|its)\b/i;

/**
 * An attribute noun with no interrogative and no lookup lead is the weakest cue we
 * accept ("the population of Tokyo"). Real asks of that shape are terse, so it is
 * bounded by length: without this, ordinary article prose supplies the cue by
 * accident — a feature paragraph about water rights contains "committed capital",
 * and "capital" is an attribute noun.
 */
const ATTRIBUTE_ONLY_ASK_MAX_CHARS = 120;

/**
 * True when the ask is actually ASKING, rather than merely containing a word that
 * can begin a question.
 *
 * An interrogative is a cue only where it is doing interrogative work. Declarative
 * prose is full of them — "no matter what", "What they disputed was the
 * sequencing" — and each of those supplied a cue that carried a conversational
 * place name or a body-prose Title-Case run into a lookup. Requiring an explicit
 * question mark, or the cue at the very START of the ask, separates the two
 * without a word list: real terse questions open with the interrogative ("who is
 * the mayor of osaka"), while prose that merely contains one does not.
 *
 * Sentence-initial anywhere in the ask is deliberately NOT enough — "…the science.
 * What they disputed was…" would qualify, and that is exactly a body paragraph.
 */
function isAskingAQuestion(ask: string): boolean {
  if (ask.includes("?")) {
    return true;
  }
  const match = INTERROGATIVE_CUE.exec(ask);
  if (match === null) {
    return false;
  }
  return ask.slice(0, match.index).trim() === "";
}

/** Split a turn into blocks: blank-line-separated paragraphs, else lines. */
function splitBlocks(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
  if (paragraphs.length > 1) {
    return paragraphs;
  }
  return text
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The spans of the turn the user is ASKING WITH, in priority order.
 *
 * A short turn yields itself — the overwhelmingly common case, and the one every
 * existing test exercises, so their behaviour is untouched. A long turn yields only
 * its first and last block, and only when those are short enough to be an ask: real
 * people put their question either above the paste ("can you summarise this?\n\n…")
 * or below it ("…\n\nhow does this compare to South Korea?"), never buried in the
 * middle. Everything else is body, and body is never scanned.
 *
 * Returned as separate windows rather than one concatenated string so a Title-Case
 * run can never span the seam between two blocks that were never adjacent.
 *
 * @internal Exported for unit testing.
 */
export function askWindows(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed === "") {
    return [];
  }
  if (trimmed.length <= SHORT_TURN_MAX_CHARS) {
    return [trimmed];
  }

  const blocks = splitBlocks(trimmed);
  if (blocks.length <= 1) {
    // One long unbroken block: a pasted wall of text with no separable ask.
    return [];
  }

  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const windows: string[] = [];
  for (const block of first === last ? [first] : [first, last]) {
    if (block !== undefined && block.length <= ASK_BLOCK_MAX_CHARS) {
      windows.push(block);
    }
  }
  return windows;
}

/**
 * True when `token` appears somewhere in `text` that is NOT the first word of a
 * sentence — i.e. its capitalisation is carrying information rather than just
 * marking a sentence boundary.
 */
function occursAwayFromSentenceStart(token: string, text: string): boolean {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const words = sentence
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
      .filter((w) => w !== "");
    for (let i = 1; i < words.length; i++) {
      if (words[i] === token) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Reject a span whose capitalisation is only sentence casing.
 *
 * `ENTITY_STOPWORDS` already blocks a list of words that can open a sentence, and
 * that list can never be complete — "Raised" (a past participle opening a
 * paragraph) and "Briefly" (a sentence adverb) both sailed through it and became
 * high-confidence lookup subjects. The structural signal is not WHICH word it is
 * but WHERE its capitals occur: a real subject either appears mid-sentence
 * ("What is France?") or recurs, whereas sentence casing appears only at a
 * sentence start. So this replaces list-extension with a rule.
 *
 * Scoped to single-token spans on purpose: a multi-word Title-Case run
 * ("United States Industrial Alcohol Company") cannot be explained by sentence
 * casing, so the rule would be wrong to touch it.
 */
function isSentenceCasingOnly(span: string, ask: string): boolean {
  const words = span.split(/\s+/).filter((w) => w !== "");
  if (words.length !== 1) {
    return false;
  }
  const token = words[0];
  if (token === undefined || !/^\p{Lu}/u.test(token)) {
    return false;
  }
  return !occursAwayFromSentenceStart(token, ask);
}

/**
 * The final gate every extracted span passes before it can become a request.
 *
 * Each clause corresponds to a measured false positive from the 2026-07-27 sweep,
 * and all of them fail CLOSED — a rejected span abstains, it never downgrades to a
 * lower confidence. Confidence only changes how `execute` handles a miss; it does
 * not decide whether the network is touched. Only abstention does that.
 *
 * @internal Exported for unit testing.
 */
export function isPlausibleEntity(span: string, ask: string): boolean {
  const s = span.trim();
  if (s === "" || s.length > ENTITY_MAX_CHARS) {
    return false;
  }
  // A span carrying a newline came out of body prose, not a subject.
  if (/[\n\r]/.test(s)) {
    return false;
  }
  if (PATH_OR_CODE_LIKE.test(s)) {
    return false;
  }
  if (s.split(/\s+/).filter((w) => w !== "").length > ENTITY_MAX_WORDS) {
    return false;
  }
  if (DEMONSTRATIVE_HEAD.test(s)) {
    return false;
  }
  if (isSentenceCasingOnly(s, ask)) {
    return false;
  }
  return true;
}

function matchGrounding(
  userText: string,
  context?: ToolMatchContext,
): GroundingArgs | null {
  if (typeof userText !== "string" || userText.trim() === "") {
    return null;
  }

  // Guard 1 — deny-set short-circuit. Screen creative/opinion/code/translation/meta
  // turns BEFORE any cue or entity work, so they can never reach a lookup.
  //
  // Scanned over the WHOLE turn, deliberately, even though every guard below is
  // scoped to the ask window: denying is subtractive, so a wider scan can only
  // abstain more often. Fail-safe direction (cf. the ask window, where a wider
  // scan would fire more often — the unsafe direction).
  for (const deny of DENY_PATTERNS) {
    if (deny.test(userText)) {
      return null;
    }
  }

  // Guard 2 — scope to what the user is ASKING WITH, not what they are SHOWING.
  // Everything downstream reads `ask`, never the raw turn. See ASK-WINDOW SCOPING.
  const windows = askWindows(userText);
  if (windows.length === 0) {
    return null;
  }

  for (const ask of windows) {
    const args = matchWithinAsk(ask, context);
    if (args !== null) {
      return args;
    }
  }

  return null;
}

/**
 * Run the cue + extraction guards against ONE ask window.
 *
 * Takes ONLY the ask, deliberately: the raw turn is not a parameter, so no guard
 * below can quietly start reading pasted content again. The one place the full turn
 * still matters — the deny-set, where a wider scan can only abstain more often —
 * runs in {@link matchGrounding} before this is ever called.
 */
function matchWithinAsk(
  ask: string,
  context?: ToolMatchContext,
): GroundingArgs | null {
  // Guard 3 — require a factual cue: an interrogative/quantitative cue, OR a factual
  // attribute noun, OR a "tell me about / what is" lookup lead. Read from the ask
  // window: an attribute noun occurring inside a pasted article is not the user
  // asking a factual question, and treating it as one is what let a bare paste with
  // no question attached reach a lookup.
  const hasCue =
    (INTERROGATIVE_CUE.test(ask) && isAskingAQuestion(ask)) ||
    LOOKUP_LEAD.test(ask) ||
    (FACTUAL_ATTRIBUTE.test(ask) && ask.length <= ATTRIBUTE_ONLY_ASK_MAX_CHARS);
  if (!hasCue) {
    return null;
  }

  // Guard 4 — extract an entity. Quoted span / Title-Case n-gram are HIGH
  // confidence; when both miss, the lowercase-recovery path may still produce a
  // LOW-confidence span (real users type lowercase). Abstain when all miss.
  // Every candidate passes isPlausibleEntity before it can become a lookup.
  const quoted = extractQuotedSpan(ask);
  const titled = extractTitleCaseEntity(ask);
  const entity =
    (quoted !== null && isPlausibleEntity(quoted, ask) ? quoted : null) ??
    (titled !== null && isPlausibleEntity(titled, ask) ? titled : null);
  if (entity !== null && entity.trim() !== "") {
    return { entity, wikidataProperty: detectWikidataProperty(ask), confidence: "high" };
  }

  const recovered = extractLowercaseEntity(ask);
  if (recovered !== null && isPlausibleEntity(recovered, ask)) {
    return {
      entity: recovered,
      wikidataProperty: detectWikidataProperty(ask),
      confidence: "low",
    };
  }

  // Guard 5 — follow-up re-grounding. Only when the conversation carries a recent
  // grounded subject AND no in-turn entity was extractable above. Two shapes, both
  // already past Guards 1–3:
  //   • Pronoun: the turn references the prior subject ("how tall is it?").
  //   • Elliptical: a short attribute fragment with no entity ("and the
  //     population?") — Guard 2 already passed for an attribute cue, so this is
  //     just short + attribute-cue + reached-this-point. Digits reject the
  //     elliptical shape: "what's the height of k2" names a NEW digit-bearing
  //     subject the recovery path deliberately dropped (its digit guard — the
  //     calculator owns digits), so re-grounding the STALE subject here would be
  //     a wrong fire, not a follow-up. Same digit posture as recovery. (The
  //     uppercase form "K2" never gets here — capital+digit is a valid
  //     Title-Case token, so Guard 3 grounds it as the new subject.)
  // Read from the ask window, not the raw turn: a pronoun occurring inside pasted
  // prose is not the user referring back to a grounded subject.
  const lastGroundedTitle = context?.lastGroundedTitle;
  if (typeof lastGroundedTitle === "string" && lastGroundedTitle !== "") {
    const isPronounFollowup = FOLLOWUP_REFERENCE.test(ask);
    const isElliptical =
      ask.trim().length <= FOLLOWUP_ELLIPTICAL_MAX_LEN &&
      FACTUAL_ATTRIBUTE.test(ask) &&
      !/\d/.test(ask);
    if (isPronounFollowup || isElliptical) {
      return {
        entity: lastGroundedTitle,
        wikidataProperty: detectWikidataProperty(ask),
        confidence: "followup",
      };
    }
  }

  // Guard 6 — zero-entity full-text recall (LAST). Reached only when the ask is
  // factual-shaped (Guards 1–3 passed) yet NO entity was extractable by any path
  // above AND the follow-up path didn't claim it. Two extra conditions hold the
  // precision line: the ask must LEAD with an interrogative (FULLTEXT_LEAD — a
  // mid-sentence question word in a musing doesn't qualify), AND it must clean to a
  // 2–8-token, digit-free content corpus. The ask is then searched (natural
  // phrasing ranks far better on CirrusSearch than stripped keywords — see
  // GroundingArgs.searchText) while the cleaned corpus anchors execute's inverted
  // coverage gate. An entity-bearing or follow-up turn never reaches here, so this
  // never competes with a named/carried subject.
  //
  // `searchText` is built from the ASK WINDOW, never the raw turn. This is a
  // privacy boundary, not a tidiness one: the previous `userText.slice(0, 200)`
  // put up to 200 characters of whatever the user had pasted directly into an
  // outbound search URL (2026-07-27 realistic-input sweep).
  if (FULLTEXT_LEAD.test(ask)) {
    const query = buildKeywordQuery(ask);
    if (query !== null) {
      return {
        entity: query,
        wikidataProperty: detectWikidataProperty(ask),
        fulltext: true,
        // Bounded defensively before it flows into a request URL.
        searchText: ask.trim().slice(0, FULLTEXT_SEARCH_MAX_CHARS),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// execute — compose lookupWikipedia (+ optional getWikidataStatement), build the
// inject block, and (on found) the structured citation. Serial, never parallel.
// ---------------------------------------------------------------------------

/**
 * Format a pure-integer string with thousands separators ("2103778" → "2,103,778").
 * Anything that isn't a clean integer (decimals, units, ranges) passes through
 * untouched — we never reshape a value we don't fully understand. Uses BigInt so
 * values above 2^53 format exactly (no IEEE 754 precision drift), which matters
 * since PROPERTY_INTENTS is explicitly extensible to arbitrary Wikidata quantities.
 */
function formatCount(value: string): string {
  if (!/^-?\d+$/.test(value)) {
    return value;
  }
  return BigInt(value).toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Prompt-injection defense - fence untrusted external text (#4 Phase 6 Task B).
//
// The fence itself now lives in `lib/grounding/fence.ts` and is re-exported here
// UNCHANGED, so every existing importer of `neutralizeFenceMarkers` / `MAX_TITLE_LEN`
// from this module keeps working. It moved only because the passage-retrieval
// selector (`lib/grounding/passages.ts`) builds its note with the same scaffolding
// and this module imports that selector - reading the markers back out of here would
// close an import cycle. Nothing about the defense changed in the move; see
// `fence.ts` for its rationale.
// ---------------------------------------------------------------------------

export { MAX_TITLE_LEN, neutralizeFenceMarkers } from "../grounding/fence";

/**
 * Build the FOUND inject block: the article extract + optional Population line wrapped in
 * a DATA fence (reference material only — never instructions to obey), and a tight
 * instruction to answer from these facts in the model's own voice. The untrusted spans
 * are neutralized first so they can't forge or close the fence. One delimited block (a
 * future KV-cache layer must reason about it cleanly), kept under ~250 tokens (the
 * extract is capped at 600 chars ≈ 150 tokens in `wikimedia.ts`, plus the fence
 * scaffolding, instruction lines, and an optional population line).
 *
 * Deliberately NO URL and NO "cite the source" instruction (audit 2026-06-09 RC3):
 * a 1–2B model cannot reproduce a URL token-perfectly, so it fabricates broken links
 * ("Wikipedia.diigo.com"), and once it has written one "Source:" line it imitates the
 * pattern on every later turn with invented provenance ("Source: General knowledge…").
 * The host renders the real citation chip from the structured {@link EcoCitation};
 * the model's job is only natural prose.
 */
function buildFoundNote(
  title: string,
  extract: string,
  populationLine: string | null
): string {
  // Reference-data region: the untrusted title-tagged extract + optional population line,
  // both neutralized against fence forgery. The title is host-built but interpolated
  // alongside untrusted text, so the whole tagged line is neutralized as one span.
  // Ordering matters: neutralize each untrusted span BEFORE fencing it — never neutralize
  // the assembled block, or the genuine FENCE_OPEN/FENCE_CLOSE markers get stripped too.
  const dataLines = [neutralizeFenceMarkers(`[Source: Wikipedia — "${title}"] ${extract}`)];
  if (populationLine !== null) {
    dataLines.push(neutralizeFenceMarkers(populationLine));
  }

  return [FENCE_PREAMBLE, FENCE_OPEN, ...dataLines, FENCE_CLOSE, FENCE_ANSWER_INSTRUCTION].join(
    "\n",
  );
}

/**
 * Significant-token tokenizer shared by both coverage gates. Folds case +
 * diacritics so accented names compare equal, splits on non-alphanumerics, and
 * drops empty tokens and {@link ENTITY_CONNECTORS} ("of"/"the"/"and"/…) so a
 * connector never counts as a significant token on either side of a gate.
 * (Unicode escapes keep the source pure ASCII — file convention.)
 */
function foldTokens(text: string): string[] {
  return text
    .normalize("NFD")
    // Strip combining diacritics (U+0300-U+036F) so accented names fold. The
    // RegExp-constructor form with \u escapes keeps the source pure ASCII (file
    // convention — same idiom as extractQuotedSpan's curly-quote patterns).
    .replace(COMBINING_DIACRITICS, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "" && !ENTITY_CONNECTORS.has(token));
}

/**
 * Combining diacritical marks (U+0300–U+036F). Built from char codes so NO
 * non-ASCII byte appears in the source (file convention — pure-ASCII regexes).
 */
const COMBINING_DIACRITICS = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  "g",
);

/**
 * Significant-token coverage gate between the user's extracted entity and the
 * resolved article title (audit 2026-06-09 RC4). Wikipedia's search is fuzzy: a
 * made-up person ("Marjorie Blandford-Quist") resolves to the "Marjorie"
 * given-name article, whose extract then flows in as "authoritative facts" about
 * the WRONG subject — producing a confidently fabricated biography WITH a
 * Wikipedia chip. A cited hallucination is worse than no grounding.
 *
 * Accept the hit only when EVERY significant entity token appears in the
 * resolved title (case/diacritic-folded, connectors ignored). Asymmetric on
 * purpose: a title with EXTRA tokens stays valid ("Obama" → "Barack Obama"),
 * but a title MISSING entity tokens ("Marjorie" for "Marjorie Blandford-Quist")
 * is rejected into the honest hard-decline path. Known recall cost, accepted:
 * alias/acronym redirects ("UK" → "United Kingdom") now decline instead of
 * grounding — precision over recall, the tool's locked posture.
 *
 * @internal Exported for unit testing.
 */
export function titleCoversEntity(entity: string, title: string): boolean {
  const titleTokens = new Set(foldTokens(title));
  const entityTokens = foldTokens(entity);
  if (entityTokens.length === 0) {
    return false;
  }
  return entityTokens.every((token) => titleTokens.has(token));
}

/**
 * The INVERTED coverage gate for the zero-entity full-text path (chat #7 W2.2 T3).
 *
 * In entity mode the user named a subject, so we require every entity token to be
 * present in the title (the title must cover what they asked). The full-text path
 * has NO extracted entity, so that anchor is gone \u2014 the ONLY precision anchor left
 * is the user's OWN words. So we invert: accept a full-text hit only when EVERY
 * significant token of the resolved TITLE appears in the user's keyword query (the
 * cleaned, stopword-stripped subset of their turn). "Apple" is covered by "calories
 * apple" and passes; "Apfelschorle" \u2014 a fuzzy German-drink hit for an English
 * question \u2014 fails because "apfelschorle" is nowhere in the user's words. Same
 * locked posture as the forward gate: precision over recall, a cited hallucination
 * is worse than none.
 *
 * Asymmetric the same way: a query with EXTRA words is fine (the user just said
 * more than the title), but a title token absent from the query rejects. An empty
 * title (or a query that doesn't cover it) returns `false`.
 *
 * @internal Exported for unit testing.
 */
export function userTextCoversTitle(query: string, title: string): boolean {
  const queryTokens = new Set(foldTokens(query));
  const titleTokens = foldTokens(title);
  if (titleTokens.length === 0) {
    return false;
  }
  return titleTokens.every((token) => queryTokens.has(token));
}

/** The HARD-DECLINE inject: a real lookup ran and found no source (fictional-town case). */
function buildHardDeclineNote(entity: string): string {
  const safeEntity = neutralizeFenceMarkers(entity);
  return [
    `[No reliable source was found for "${safeEntity}" in Wikipedia or Wikidata.]`,
    "You have no source for this. Tell the user you don't have a reliable source for it rather than guessing. Do not invent facts, figures, dates, or details.",
  ].join("\n");
}

/** The SOFT-DEGRADED inject: couldn't reach the sources (timeout/network), not "no source exists". */
function buildSoftDegradedNote(entity: string): string {
  const safeEntity = neutralizeFenceMarkers(entity);
  return [
    `[Couldn't reach reference sources to verify "${safeEntity}" right now.]`,
    "Answer from your own knowledge if you can, but tell the user you couldn't verify this against a source. Do not present unverified specifics (numbers, dates) as confirmed fact.",
  ].join("\n");
}

/**
 * The HEDGE inject: a factual answer with NO verified source behind it — distinct
 * from both the hard decline ("no source exists, don't answer") and the soft
 * degrade ("couldn't reach sources"). Three sites HEDGE: (a) a follow-up whose
 * KNOWN-to-exist subject this lookup didn't confirm; (b) a low-confidence span
 * whose resolved title doesn't cover it (extraction noise, not a nonexistent
 * subject); (c) the full-text path when the keyword query resolves nowhere or to
 * an uncovering title. In all three a hard "no source exists" would be FALSE (we
 * never proved nonexistence) and silence would drop a factual-shaped ask, so the
 * model answers from its own knowledge while flagging specifics as unverified.
 *
 * Mode-NEUTRAL on purpose (chat #7 W2.2 T3 reviewer note): the note interpolates
 * NO subject, so it reads correctly whether the hedged thing is a follow-up
 * subject, a noisy low-confidence span, or a keyword query (where there is no
 * single "subject" at all, and the whole answer — not "this detail" — is
 * unverified). The earlier subject-bearing wording presumed a known subject with
 * one unverified detail and was wrong for the query case.
 *
 * Constraints, locked from prior prompt-engineering incidents (audit 2026-06-09
 * RC3 and siblings): positive instructions only; NO concrete example phrasing a
 * small model could echo verbatim; NO URLs (a 1–2B model fabricates broken
 * links). With no interpolation there is no untrusted span to forge a fence with;
 * the quiet `display` fallback strings still neutralize their interpolated subject.
 * Mirrors the shape and register of the decline/degraded builders above.
 */
function buildHedgeNote(): string {
  return [
    "[Answering this without a verified source.]",
    "Answer from your own knowledge if you can, but tell the user you don't have a verified source and clearly qualify any specific facts, figures, and dates as unverified or from memory rather than confirmed. Keep the rest of your answer natural.",
  ].join("\n");
}

/**
 * The three no-source results carry a structured {@link GroundingVerification} so
 * the host can render a deterministic "couldn't confirm this" marker — mirroring how
 * {@link buildFoundResult} carries an {@link EcoCitation} on the found case. Hedge and
 * hard-decline are `"unverified"` (an answer with no confirming source); soft-degrade
 * is `"unreachable"` (the sources couldn't be reached — transient/network).
 */
const VERIFICATION_UNVERIFIED: GroundingVerification = { status: "unverified" };
const VERIFICATION_UNREACHABLE: GroundingVerification = { status: "unreachable" };

/** The HEDGE result — quiet display (neutralized subject) + the mode-neutral note. */
function hedgeResult(subject: string): EcoToolResult {
  return {
    display: `Answering "${neutralizeFenceMarkers(subject)}" without a verified source.`,
    forModel: buildHedgeNote(),
    ok: true,
    verification: VERIFICATION_UNVERIFIED,
  };
}

/**
 * The HARD-DECLINE result — a real lookup ran and found no source ("no source
 * exists", the fictional-town case). Quiet display + the hard-decline note; same
 * `{ display, forModel, ok: true }` shape as {@link hedgeResult}, plus the
 * `"unverified"` verification. Centralizes the previously-inline decline objects so
 * no decline branch can miss the structured field.
 */
function hardDeclineResult(entity: string): EcoToolResult {
  return {
    display: `No reliable source found for "${entity}".`,
    forModel: buildHardDeclineNote(entity),
    ok: true,
    verification: VERIFICATION_UNVERIFIED,
  };
}

/**
 * The SOFT-DEGRADE result — couldn't reach the sources (timeout/network), NOT "no
 * source exists". Quiet display + the soft-degrade note; same shape as
 * {@link hedgeResult}, plus the `"unreachable"` verification. Centralizes the
 * previously-inline soft-degrade objects so no degrade branch can miss the field.
 */
function softDegradedResult(entity: string): EcoToolResult {
  return {
    display: `Couldn't reach reference sources for "${entity}".`,
    forModel: buildSoftDegradedNote(entity),
    ok: true,
    verification: VERIFICATION_UNREACHABLE,
  };
}

// ---------------------------------------------------------------------------
// Extract mode — which SPAN of the resolved article reaches the model.
// ---------------------------------------------------------------------------

/**
 * Which part of a found article is injected.
 *
 * `'lead'` is what ships and what every existing caller gets: the article's lead
 * summary, capped at ~4 sentences / 600 chars by `wikimedia.truncateExtract`.
 *
 * `'passages'` is a DIAGNOSTICS-ONLY treatment arm (eco-notes search-measurement
 * protocol, 2026-08-29): fetch the whole article body and inject the few sentences
 * that overlap the user's actual question. It exists to be measured against
 * `'lead'`, and only `local-ai/eval` constructs it. Nothing in the chat pipeline
 * selects it, and the pre-committed rule for whether it ever ships lives in the
 * protocol, not here.
 */
export type GroundingExtractMode = "lead" | "passages";

/** Construction knobs for {@link createWikipediaGroundingTool}. */
export type CreateWikipediaGroundingToolOptions = {
  /** Default `'lead'` — exactly what the shipped tool does. */
  extractMode?: GroundingExtractMode;
  /**
   * Body-fetch seam for the `'passages'` mode, defaulting to
   * {@link fetchArticlePlainText}. The eval harness swaps in a same-origin fixture
   * reader for its hostile-injection rows; nothing else overrides it.
   */
  fetchArticleText?: FetchArticleTextFn;
};

/**
 * Per-call options. A superset of the registry's `{ signal }`, so a tool built here
 * stays assignable to `EcoTool<GroundingArgs>` (a function taking a WIDER optional
 * options object is assignable to one taking a narrower one).
 */
export type GroundingExecuteOptions = {
  /** Ties both fetches to the generation's AbortController (#5 S3). */
  signal?: AbortSignal;
  /**
   * The ORIGINAL user turn. The `'passages'` mode scores sentences against it,
   * because `args.entity` is a cleaned keyword corpus or an extracted subject —
   * neither of which carries the attribute the person actually asked for ("how many
   * CALORIES in an apple" reduces to the entity "apple"). `'lead'` never reads it;
   * without it the passages selector falls back to the resolved title, which will
   * usually select nothing and drop to the lead note.
   */
  question?: string;
};

/**
 * The tool this module builds. Structurally an {@link EcoTool} with a widened
 * `execute` options bag; assignable to `EcoTool<GroundingArgs>` and therefore to
 * `AnyEcoTool`, so the registry is untouched.
 */
export type WikipediaGroundingTool = Omit<EcoTool<GroundingArgs>, "execute"> & {
  execute: (args: GroundingArgs, opts?: GroundingExecuteOptions) => Promise<EcoToolResult>;
};

/** Everything one `execute` call needs, resolved once at its entry point. */
type ExecuteContext = {
  extractMode: GroundingExtractMode;
  fetchArticleText: FetchArticleTextFn;
  question: string | null;
  signal?: AbortSignal;
};

/**
 * Compose the FOUND result from a confirmed Wikipedia hit: optionally fetch the
 * requested Wikidata property, build the population line, clamp the untrusted
 * title, and assemble the fenced found note + citation. Shared by the entity path
 * (after the forward coverage gate) and the full-text path (after the inverted
 * gate) so the summary/QID/citation/found-note logic lives in exactly one place.
 *
 * Wikidata is reached ONLY when a property was requested AND the article exposes a
 * QID, strictly AFTER the Wikipedia call — never parallel.
 *
 * `tier` is the confidence of the path that produced this hit — `"high"` for the
 * entity path's clean-extraction default, `"low"`/`"followup"` for its fuzzier
 * entity paths, `"fulltext"` for the zero-entity keyword path. It is recorded on the
 * citation so the host can gate the "isn't guesswork" disclosure on `"high"` alone
 * (see {@link EcoCitation.groundingConfidence}); it does not change the found note.
 *
 * In `'passages'` mode the article body is fetched HERE, after the summary and the
 * coverage gate — the extra request only ever rides a hit we were already going to
 * ground on, so a declined turn costs nothing extra. Three things send it back to
 * the lead note, each RECORDED as `'passages-fallback-lead'` rather than hidden: a
 * failed body fetch, zero selected passages, and a requested Wikidata property
 * (whose population line has no place in the passage note's shape, and dropping a
 * fact the user asked for to run an experiment would corrupt the measurement).
 */
async function buildFoundResult(
  wiki: Extract<WikipediaResult, { found: true }>,
  wikidataProperty: string | null,
  tier: NonNullable<EcoCitation["groundingConfidence"]>,
  ctx: ExecuteContext,
): Promise<EcoToolResult> {
  let populationLine: string | null = null;
  let asOf: string | undefined;
  if (wikidataProperty !== null && wiki.qid !== undefined) {
    const stmt = await getWikidataStatement(wiki.qid, wikidataProperty, {
      signal: ctx.signal,
    });
    if (stmt !== null) {
      const formatted = formatCount(stmt.value);
      populationLine =
        stmt.asOf !== undefined
          ? `Population: ${formatted} (Wikidata, as of ${stmt.asOf}).`
          : `Population: ${formatted} (Wikidata).`;
      asOf = stmt.asOf;
    }
  }

  // The Wikipedia title is untrusted (anyone-editable), so clamp it before it
  // flows into the citation, the display string, OR the model-injected note. The
  // extract is already capped/neutralized upstream; this completes "every untrusted
  // span bounded" (bound named at MAX_TITLE_LEN).
  const safeTitle = wiki.title.slice(0, MAX_TITLE_LEN);

  const citation: EcoCitation = {
    source: "Wikipedia",
    title: safeTitle,
    url: wiki.url,
    groundingConfidence: tier,
    ...(asOf !== undefined ? { asOf } : {}),
  };

  const leadNote = buildFoundNote(safeTitle, wiki.extract, populationLine);
  const base = {
    display: `Source: Wikipedia — ${safeTitle}`,
    // `ok:true`: the tool successfully produced a grounding instruction. Grounding
    // has no "error" state — S1 never throws, and decline/degraded are valid,
    // intended outcomes (admit uncertainty), NOT failures. A later slice confirms
    // the pipeline renders these as honest notes, not as a tool error.
    ok: true as const,
    citation,
  };

  if (ctx.extractMode === "lead") {
    // The shipped path, byte-identical to what it was before the mode existed:
    // no body fetch, no `retrieval` field on the result.
    return { ...base, forModel: leadNote };
  }

  const fellBackToLead = (bodyFetchMs: number | null): EcoToolResult => ({
    ...base,
    forModel: leadNote,
    retrieval: {
      mode: "passages-fallback-lead",
      passageCount: 0,
      injectedChars: leadNote.length,
      bodyFetchMs,
      sectionTitles: [],
    },
  });

  if (populationLine !== null) {
    return fellBackToLead(null);
  }

  const startedAt = Date.now();
  const body = await ctx.fetchArticleText(wiki.title, {
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
  const bodyFetchMs = Date.now() - startedAt;
  if (body.text === null) {
    return fellBackToLead(bodyFetchMs);
  }

  const passages = selectPassages(body.text, ctx.question ?? wiki.title);
  if (passages.length === 0) {
    return fellBackToLead(bodyFetchMs);
  }

  const passageNote = buildPassageNote(safeTitle, passages);
  return {
    ...base,
    forModel: passageNote,
    retrieval: {
      mode: "passages",
      passageCount: passages.length,
      injectedChars: passageNote.length,
      bodyFetchMs,
      sectionTitles: passages.map((p) => p.sectionTitle),
    },
  };
}

/**
 * The ZERO-ENTITY full-text path (chat #7 W2.2 T3). `args.entity` is the cleaned
 * keyword corpus (no extracted subject), so the whole posture differs from the
 * entity path:
 *   • search is full-text (`searchWikipediaFulltext`) over the RAW question
 *     (`args.searchText`, falling back to the corpus for older-shaped args) — it
 *     resolves a natural-language question to the right article where title-search
 *     can't, and CirrusSearch ranks the raw phrasing far better than stripped
 *     keywords (live walk 2026-06-11; see GroundingArgs.searchText);
 *   • the precision anchor is the INVERTED gate (title tokens ⊆ the cleaned
 *     `args.entity` corpus — strictly tighter than the raw turn), scanned over the
 *     top 3 hits in order — the FIRST passing title wins;
 *   • EVERY miss HEDGES, never hard-declines: a question resolving nowhere,
 *     to no covered title, or to a disambiguation page is NOT proof the topic has
 *     no source (it usually means the query was imperfectly phrased). A false "no
 *     source exists" is the outcome we refuse to emit. Only an unreachable source
 *     (timeout/network) soft-degrades, identical to the entity path.
 */
async function executeFulltextGrounding(
  args: GroundingArgs,
  ctx: ExecuteContext,
): Promise<EcoToolResult> {
  const search = await searchWikipediaFulltext(args.searchText ?? args.entity, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: ctx.signal,
  });

  if (!search.found) {
    // Unreachable source → soft-degrade (same meaning everywhere); zero hits →
    // hedge (the query just didn't resolve, not "no source exists").
    if (search.reason === "timeout" || search.reason === "network-error") {
      return softDegradedResult(args.entity);
    }
    return hedgeResult(args.entity);
  }

  // Scan the top hits IN ORDER; accept the FIRST title the user's own words cover.
  // An earlier fuzzy hit that fails the inverted gate is skipped, not declined —
  // a later hit may still be the right article.
  const accepted = search.pages.find((page) =>
    userTextCoversTitle(args.entity, page.title),
  );
  if (accepted === undefined) {
    return hedgeResult(args.entity);
  }

  // Fetch the accepted title's summary, then reuse the shared found-handling.
  // Nuance vs. the entity path: the inverted gate above validated the SEARCH
  // result's `page.title`, but the summary fetch can resolve to a different
  // `wiki.title` via redirect/normalization — that resolved title is what gets
  // grounded/cited WITHOUT re-gating. A redirect slipping past the gate this way
  // is an accepted narrow cost (the search hit was already covered by the user's
  // own words). A transient miss/disambiguation here is again noise for a query
  // we just matched a search hit for, so HEDGE; timeout/network degrades.
  const wiki = await lookupWikipedia(accepted.title, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: ctx.signal,
  });
  if (wiki.found) {
    // The zero-entity keyword path — a lookup did happen, but the article was
    // resolved by the weakest signal, so it never earns the "isn't guesswork"
    // disclosure (see EcoCitation.groundingConfidence).
    return buildFoundResult(wiki, args.wikidataProperty, "fulltext", ctx);
  }
  if (wiki.reason === "timeout" || wiki.reason === "network-error") {
    return softDegradedResult(args.entity);
  }
  return hedgeResult(args.entity);
}

async function executeGrounding(
  args: GroundingArgs,
  ctx: ExecuteContext,
): Promise<EcoToolResult> {
  // Zero-entity full-text recall is a different lookup + gate entirely — dispatch
  // before the entity path so `entity` is read as a keyword query, not a subject.
  if (args.fulltext === true) {
    return executeFulltextGrounding(args, ctx);
  }

  // Thread the generation's abort signal into both fetches so a user-stop during
  // the lookup aborts the in-flight request (#5 S3). S1 declines as `timeout` when
  // the signal aborts, which routes to the soft-degraded note below.
  const wiki = await lookupWikipedia(args.entity, {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: ctx.signal,
  });

  if (wiki.found) {
    // Relevance gate BEFORE anything flows toward the model: Wikipedia's fuzzy
    // search resolves partial names to unrelated articles ("Marjorie
    // Blandford-Quist" → the "Marjorie" given-name page), which previously
    // produced confidently fabricated biographies WITH a Wikipedia chip. A title
    // that doesn't cover the asked entity is treated as no source found —
    // EXCEPT for two cases keyed on confidence:
    //   • LOW (lowercase-recovered): the likelier explanation is extraction
    //     noise, not a nonexistent subject. We HEDGE (not silently abstain, not
    //     decline): the turn IS factual-shaped, so the user deserves a calibrated
    //     "no verified source for this" rather than a confident hallucination or a
    //     false "no source exists" claim. (Earlier this silently abstained to avoid
    //     wrong declines — but a hedge is not a decline; it's safe even under
    //     extraction noise and strictly better than silence on a factual ask.)
    //   • FOLLOWUP: the entity is the previously grounded title — KNOWN to exist —
    //     so an uncovering hit is a redirect/index quirk, not nonexistence. We
    //     HEDGE (answer from memory, qualify specifics): a hard decline would be a
    //     false "no source exists", and silence would drop the user's follow-up.
    if (!titleCoversEntity(args.entity, wiki.title)) {
      if (args.confidence === "low" || args.confidence === "followup") {
        return hedgeResult(args.entity);
      }
      return hardDeclineResult(args.entity);
    }

    // The entity path passed the coverage gate. Its confidence tier ("high" by
    // default for a clean quoted/Title-Case span, "low" for lowercase recovery,
    // "followup" for a carried subject) rides onto the citation so only a "high"
    // hit earns the "isn't guesswork" disclosure. Older-shaped args omit
    // confidence — treat that as "high", matching GroundingArgs.confidence's default.
    return buildFoundResult(wiki, args.wikidataProperty, args.confidence ?? "high", ctx);
  }

  // not found — branch on WHY. no-match/disambiguation = "no source exists" (decline
  // hard); timeout/network-error = "couldn't reach the source" (degrade soft, honest
  // uncertainty). Neither carries a citation. On the FOLLOWUP path the subject is
  // KNOWN to exist (cited a turn ago), so a no-match/disambiguation here is noise,
  // not nonexistence: HEDGE instead of declaring "no source exists" (which would be
  // false). timeout/network-error still degrade soft below (same meaning for all
  // confidence levels — the source was simply unreachable).
  if (wiki.reason === "no-match" || wiki.reason === "disambiguation") {
    if (args.confidence === "followup") {
      return hedgeResult(args.entity);
    }
    return hardDeclineResult(args.entity);
  }

  return softDegradedResult(args.entity);
}

/**
 * Friendly headline for the ToolCallBlock — "Looking up "Paris"", or
 * ""Paris" — population" when a structured property was requested.
 */
function summarizeGrounding(args: GroundingArgs): string {
  if (args.wikidataProperty === "P1082") {
    return `"${args.entity}" — population`;
  }
  return `Looking up "${args.entity}"`;
}

/**
 * Build a grounding tool. Defaults reproduce the shipped tool exactly — matching,
 * gating, notes, citation and failure policy are all mode-independent, and `'lead'`
 * takes no new code path (no body fetch, no `retrieval` field on the result). The
 * factory exists so the eval harness can construct the `'passages'` arm and inject a
 * fixture body WITHOUT a switch reaching the chat pipeline: production imports
 * {@link wikipediaGroundingTool}, and there is no setting, flag or URL parameter that
 * changes ITS mode.
 */
export function createWikipediaGroundingTool(
  options?: CreateWikipediaGroundingToolOptions,
): WikipediaGroundingTool {
  const extractMode = options?.extractMode ?? "lead";
  const fetchArticleText = options?.fetchArticleText ?? fetchArticlePlainText;
  return {
    name: "wikipedia-grounding",
    description:
      "Look up a factual/entity question against Wikipedia/Wikidata, or decline honestly when no reliable source exists.",
    validate: isGroundingArgs,
    match: matchGrounding,
    execute: (args, opts) =>
      executeGrounding(args, {
        extractMode,
        fetchArticleText,
        question: opts?.question ?? null,
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      }),
    summarize: summarizeGrounding,
    // Grounding is NOT a ToolCallBlock: the model phrases the answer and the source
    // is surfaced as a citation chip (found) or honest decline prose (no source).
    // `"citation"` tells the pipeline to suppress the block and carry the citation.
    presentation: "citation",
  };
}

/** The SHIPPED grounding tool: lead-summary mode, live Wikipedia body fetcher. */
export const wikipediaGroundingTool: EcoTool<GroundingArgs> = createWikipediaGroundingTool();

/**
 * Build grounding args for a FORCED lookup (the "Check a source" user action).
 *
 * Bypasses every candidacy guard (deny patterns, cue requirements, entity
 * extraction confidence gates) but keeps two things the organic path holds:
 *
 * - The pronoun / elliptical follow-up resolves against the last grounded
 *   subject when the host supplies one ("how tall is it?" → the mountain), so a
 *   forced check on a follow-up turn looks up the subject, not the pronoun.
 * - The query is built from the ASK WINDOW, not the raw turn: pasted prose is
 *   never sent to Wikipedia. Only when the turn is one unbroken block with no
 *   separable ask does the (capped) turn itself become the query — the user
 *   explicitly asked for this lookup on this turn, which the organic path lacks.
 *
 * Otherwise it goes straight to the full-text search fallback: the ask becomes
 * the search query and its cleaned keyword corpus anchors the inverted coverage
 * gate exactly as the organic zero-entity path does.
 *
 * This is the ONLY public entry point for forced grounding; the rest of the
 * module's internals stay private.
 */
export function buildForcedGroundingArgs(
  userText: string,
  context?: ToolMatchContext,
): GroundingArgs {
  const windows = askWindows(userText);
  const ask = (windows.length > 0 ? windows.join(" ") : userText.trim()).slice(
    0,
    FULLTEXT_SEARCH_MAX_CHARS,
  );
  const lastGroundedTitle = context?.lastGroundedTitle;
  if (typeof lastGroundedTitle === "string" && lastGroundedTitle !== "") {
    const isPronounFollowup = FOLLOWUP_REFERENCE.test(ask);
    const isElliptical =
      ask.length <= FOLLOWUP_ELLIPTICAL_MAX_LEN && FACTUAL_ATTRIBUTE.test(ask) && !/\d/.test(ask);
    if (isPronounFollowup || isElliptical) {
      return {
        entity: lastGroundedTitle,
        wikidataProperty: detectWikidataProperty(ask),
        confidence: "followup",
      };
    }
  }
  const keywordCorpus = buildKeywordQuery(ask);
  return {
    entity: keywordCorpus ?? ask,
    wikidataProperty: detectWikidataProperty(ask),
    fulltext: true,
    searchText: ask,
  };
}
