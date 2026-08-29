// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Passage-level retrieval: fetch a Wikipedia article BODY and pick the sentences
 * that actually answer the question.
 *
 * WHY THIS EXISTS. The shipped grounding tool injects the article's LEAD summary
 * (`wikimedia.truncateExtract`, ~4 sentences / 600 chars). Two live checks on
 * 2026-08-29 showed the lead is the wrong span for body facts: "how many calories
 * in an apple" resolves to *Apple*, whose lead has no calorie figure (it is in the
 * Nutrition section). Search finds the page; the answer is not in what we inject.
 *
 * WHAT THIS IS. The measurement arm's treatment: whole-article plain text →
 * sections → sentences → question-overlap scoring → the top few quoted sentences
 * inside the same data fence the lead note uses. It is NOT switched on for anyone:
 * the shipped tool still runs in `'lead'` mode and only the diagnostics eval
 * harness constructs the `'passages'` variant. The pre-committed decision rule for
 * whether it ever ships lives in eco-notes (search-measurement protocol,
 * 2026-08-29) — nothing here may be tuned against results.
 *
 * SCORING IS CRUDE ON PURPOSE. Content-word overlap with 5-character stemming, no
 * embeddings, no reranker. A retrieval mechanism that needs a second model to be
 * useful is a different (much larger) decision; this measures whether the CHEAPEST
 * honest version of "quote the right sentence" moves answer correctness at all.
 *
 * The host is HARDCODED: `fetchArticlePlainText` composes `en.wikipedia.org` itself
 * and takes only a title, so the allow-list is structural rather than a check that
 * could be forgotten. Requests go DIRECTLY from the browser to Wikimedia — same
 * privacy posture as `wikimedia.ts`; Eco's servers never see the title.
 */

import { FENCE_ANSWER_INSTRUCTION, FENCE_CLOSE, FENCE_OPEN, FENCE_PREAMBLE, neutralizeFenceMarkers } from "./fence";
import type { GroundingRequestOptions, WikipediaDeclineReason } from "./types";
import { DEFAULT_TIMEOUT_MS, groundedApiFetch } from "./wikimedia";

/** One selected sentence, with the section it came from and its overlap score. */
export type Passage = {
  /** The cleaned sentence, whitespace-collapsed and citation-marker stripped. */
  sentence: string;
  /** The `== Heading ==` this sentence sat under; `""` for the lead section. */
  sectionTitle: string;
  /** Fraction of the question's content stems present in sentence + heading (0..1). */
  score: number;
};

/** The outcome of a body fetch: the plain text, or a structured decline. */
export type ArticleTextResult =
  | { text: string }
  | { text: null; reason: WikipediaDeclineReason };

/**
 * The body-fetch seam. `fetchArticlePlainText` is the production implementation;
 * the eval harness substitutes a same-origin fixture reader for its hostile rows.
 */
export type FetchArticleTextFn = (
  title: string,
  opts?: GroundingRequestOptions,
) => Promise<ArticleTextResult>;

// ---------------------------------------------------------------------------
// Body fetch (TextExtracts)
// ---------------------------------------------------------------------------

/**
 * The article-body endpoint. HARDCODED host — this function can only ever reach
 * en.wikipedia.org, so the allow-list is a property of the code rather than a
 * check a caller could skip.
 *
 * `explaintext=1` with no `exsection*`/`exintro` returns the WHOLE article as
 * plain text with `== Heading ==` section markers. Verified live 2026-08-29
 * against "Apple": ~45,000 characters spanning Etymology → External links, not
 * the lead. `formatversion=2` gives `query.pages` as an ARRAY (no pageid keys);
 * `redirects=1` follows a redirect title; `origin=*` is what makes the request
 * CORS-legal from the browser.
 */
const EXTRACTS_ENDPOINT = "https://en.wikipedia.org/w/api.php";

/**
 * Hard cap on the fetched body before ANY processing. A featured article can run
 * past 300 kB and every downstream step (splitting, tokenizing, scoring) is linear
 * in this number on the main thread. 200,000 characters is several times the
 * largest article we measured and still bounded.
 */
const MAX_ARTICLE_CHARS = 200_000;

/** Bound the session body cache. Bodies are far larger than summaries, so 20, not 50. */
const MAX_BODY_CACHE_ENTRIES = 20;

const bodyCache = new Map<string, ArticleTextResult>();

/** Test-only/escape hatch: clear the session body cache. */
export function clearPassageCache(): void {
  bodyCache.clear();
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** FIFO eviction under the shared cap, mirroring `wikimedia.setBounded`. */
function cacheBody(key: string, value: ArticleTextResult): ArticleTextResult {
  if (bodyCache.size >= MAX_BODY_CACHE_ENTRIES) {
    const oldest = bodyCache.keys().next();
    if (!oldest.done) {
      bodyCache.delete(oldest.value);
    }
  }
  bodyCache.set(key, value);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Pull `query.pages[0].extract` out of a formatversion=2 TextExtracts payload. */
function firstExtract(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const query = payload.query;
  if (!isRecord(query)) return null;
  const pages = query.pages;
  if (!Array.isArray(pages)) return null;
  for (const page of pages) {
    if (!isRecord(page)) continue;
    if (page.missing === true) continue;
    const extract = page.extract;
    if (typeof extract === "string" && extract.trim() !== "") {
      return extract;
    }
  }
  return null;
}

/**
 * Fetch one article's WHOLE body as plain text.
 *
 * Never throws. A missing page or an empty extract declines as `no-match` and is
 * CACHED (a deterministic miss); a timeout/caller-abort declines as `timeout` and
 * a non-ok HTTP / unreadable body as `network-error`, neither of which is cached —
 * the same success-and-deterministic-miss-only policy `wikimedia.ts` runs.
 */
export async function fetchArticlePlainText(
  title: string,
  opts?: GroundingRequestOptions,
): Promise<ArticleTextResult> {
  if (typeof title !== "string" || title.trim() === "") {
    return { text: null, reason: "no-match" };
  }

  const key = normalizeTitle(title);
  const cached = bodyCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const url =
    `${EXTRACTS_ENDPOINT}?action=query&prop=extracts&explaintext=1&format=json` +
    `&formatversion=2&origin=*&redirects=1&titles=${encodeURIComponent(title.trim())}`;

  let response: Response;
  try {
    response = await groundedApiFetch(url, {
      timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch {
    // `groundedApiFetch` rejects with an abort marker on timeout/caller-abort and
    // passes every other rejection through; both are transient, so neither caches.
    return { text: null, reason: "timeout" };
  }

  if (!response.ok) {
    return { text: null, reason: response.status === 404 ? "no-match" : "network-error" };
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    return { text: null, reason: "network-error" };
  }

  const extract = firstExtract(payload);
  if (extract === null) {
    return cacheBody(key, { text: null, reason: "no-match" });
  }

  return cacheBody(key, {
    text: extract.length > MAX_ARTICLE_CHARS ? extract.slice(0, MAX_ARTICLE_CHARS) : extract,
  });
}

// ---------------------------------------------------------------------------
// Passage selection (pure, deterministic)
// ---------------------------------------------------------------------------

/**
 * `== Heading ==` … `====== Heading ======`, the TextExtracts section marker.
 *
 * The opening and closing runs are matched INDEPENDENTLY. An earlier version used
 * a backreference (`\s*\1\s*$`), which requires both runs to be the same length —
 * and TextExtracts does not guarantee that. Observed live on 2026-08-29 against the
 * real "Apple" article: `== Nutrition ===`. Under the backreference that line was
 * not a heading at all, so "Nutrition" never joined the section's stem set and
 * `EXCLUDED_SECTIONS` could not see an equivalent `== References ===` either.
 *
 * Group 1 is the OPENING run and remains the level that drives `excludedAtLevel`
 * nesting; group 2 is the title. The title must start with a character that is
 * neither `=` nor whitespace, so a marker-only line (`===`, `=====`) is not a
 * heading with an empty title; a title containing an internal `=` ("E = mc2") is
 * still captured, because the lazy title stops only at the final marker run.
 */
const HEADING = /^\s*(={2,6})\s*([^=\s].*?)\s*=+\s*$/;

/**
 * Sections that never carry an answer, only apparatus. Compared case-folded
 * against the heading text. A heading here also excludes everything nested UNDER
 * it (a `=== Citations ===` inside `== References ==`), which is why exclusion is
 * tracked by heading level rather than per-line.
 */
const EXCLUDED_SECTIONS: ReadonlySet<string> = new Set([
  "see also",
  "references",
  "external links",
  "notes",
  "further reading",
]);

/**
 * Question words that carry no topical signal. Deliberately small: an aggressive
 * stopword list starts deciding what the question is about, which is the selector's
 * job to measure, not the list's job to assume.
 */
const QUESTION_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "for", "from", "get", "gets", "had", "has", "have",
  "how", "i", "if", "in", "into", "is", "it", "its", "just", "many", "me", "much", "my",
  "of", "on", "one", "or", "should", "so", "some", "than", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "usually", "was", "we", "were", "what",
  "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your",
]);

/** Below this a "sentence" is a caption, a stub line, or a fragment. */
const MIN_SENTENCE_CHARS = 30;
/** Above this it is a run-on paragraph the splitter failed on; too costly to inject. */
const MAX_SENTENCE_CHARS = 400;
/** Tokens at least this long are stemmed by truncation. */
const STEM_MIN_LEN = 6;
/** …to this many characters ("calories"/"calorie" → "calor"). */
const STEM_LEN = 5;

/** Defaults: four sentences, 500 characters of quoted text in total. */
const DEFAULT_K = 4;
const DEFAULT_MAX_CHARS = 500;

export type SelectPassagesOptions = {
  /** Maximum passages returned (default 4). */
  k?: number;
  /** Maximum TOTAL characters of selected sentence text (default 500). */
  maxChars?: number;
};

/** Fold to lowercase alphanumeric tokens, dropping empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    // Combining diacritical marks — stripped so "café" and "cafe" compare equal.
    // Escaped rather than literal so this file stays pure ASCII (module convention).
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Crude stemming: truncate long tokens so plural/derived forms compare equal. */
function stem(token: string): string {
  return token.length >= STEM_MIN_LEN ? token.slice(0, STEM_LEN) : token;
}

/** The question's content stems — lowercase, stopword-free, stemmed, deduped. */
function questionStems(question: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(question)) {
    if (QUESTION_STOPWORDS.has(token)) continue;
    out.add(stem(token));
  }
  return out;
}

/**
 * Bracketed citation residue: `[12]`, `[a]`, `[citation needed]`, `[note 3]`.
 *
 * DELIBERATELY NARROW. An earlier version stripped any bracketed span up to 40
 * characters, which is a worse defense than it looks: it silently swallows real
 * content, and it removes forged fence markers BEFORE the neutralizer can see
 * them — so the fence would have looked safe for a reason no test was checking.
 * Only these known apparatus forms are removed; everything else, including a
 * forged `[END SOURCE TEXT]`, survives to `neutralizeFenceMarkers`.
 *
 * Applied to the section body BEFORE sentence splitting, because a trailing `[12]`
 * sits after the full stop and would otherwise defeat the terminator-based split
 * and drop the sentence entirely (which is exactly what it did).
 */
const CITATION_MARKER =
  /\[(?:\d{1,3}|[a-z]{1,2}|citation needed|clarification needed|note \d{1,3}|when\?|who\?)\]/gi;

/** Strip citation apparatus from a section body before it is split. */
function stripCitationMarkers(body: string): string {
  return body.replace(CITATION_MARKER, " ");
}

/**
 * Final tidy for one split sentence: drop wiki bold/italic quotes and leftover
 * heading equals, collapse whitespace runs, trim.
 */
function cleanSentence(raw: string): string {
  return raw
    .replace(/'{2,}/g, "")
    .replace(/={2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Abbreviations whose trailing full stop is not a sentence end. Matched
 * CASE-SENSITIVELY, and the list is deliberately tiny: "no." and "st." in
 * lowercase are ordinary words that really do end sentences, so only the
 * capitalized number/street/title forms are protected. Single capital initials
 * ("J.") are handled by a rule rather than listed.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "approx.", "Approx.", "e.g.", "E.g.", "i.e.", "I.e.", "Dr.", "No.", "St.",
]);

/** Longest abbreviation we look back for; bounds the scan so it stays linear. */
const MAX_ABBREVIATION_LOOKBACK = 12;

/** Is the `.` at `dotIndex` the tail of an abbreviation rather than a sentence end? */
function endsWithAbbreviation(body: string, dotIndex: number): boolean {
  let start = dotIndex;
  while (
    start > 0 &&
    dotIndex - start < MAX_ABBREVIATION_LOOKBACK &&
    /[A-Za-z.]/.test(body[start - 1] ?? "")
  ) {
    start--;
  }
  const word = body.slice(start, dotIndex + 1);
  if (ABBREVIATIONS.has(word)) return true;
  // A lone capital letter plus a stop is an initial ("J. R. R. Tolkien"), not an
  // end — but ONLY when the letter starts its own token. "100 °C." and "40 kJ."
  // look identical to an initial otherwise, and those really do end sentences.
  const before = start === 0 ? "" : (body[start - 1] ?? "");
  const startsToken = before === "" || /[\s("[]/.test(before);
  return startsToken && /^[A-Z]\.$/.test(word);
}

/**
 * Split a section body into sentence-ish spans.
 *
 * This DIVERGES from `wikimedia.truncateExtract`, which the previous comment here
 * claimed parity with. That parity was the bug. The shared regex treats every `.`
 * as a terminator, so the real Nutrition sentence "A reference serving of 100 g
 * (3.5 oz) provides 52 calories…" broke at the decimal point and the surviving
 * fragment ("5 oz) provides 52 calories…") no longer carried the "apple" token —
 * it scored below lead sentences and was never selected. The divergence is
 * deliberate and CONFINED to this diagnostics-only arm; the shipped lead path in
 * `wikimedia.ts` is untouched, so the A/B still compares the same lead text it did.
 *
 * A terminator run ends a sentence only when the next character is whitespace or
 * the string ends. That single rule is what keeps number-internal stops together:
 * the `.` in "3.5" or "42.195" is followed by a digit, so it is never a boundary.
 * The abbreviation check covers the remaining case — a stop that IS followed by
 * whitespace but still is not an end ("approx. 40 g", "Dr. Smith", "J. R. R.").
 *
 * Pure and linear: one left-to-right scan with a bounded lookback, no backtracking
 * regex. Spans are returned raw, terminator and trailing space included; cleaning
 * is still `cleanSentence`'s job.
 */
function splitSentences(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;

  while (i < body.length) {
    const ch = body[i] ?? "";
    if (ch !== "." && ch !== "!" && ch !== "?") {
      i++;
      continue;
    }

    let runEnd = i;
    while (runEnd < body.length) {
      const c = body[runEnd] ?? "";
      if (c !== "." && c !== "!" && c !== "?") break;
      runEnd++;
    }

    const next = runEnd < body.length ? (body[runEnd] ?? "") : null;
    const terminates =
      (next === null || /\s/.test(next)) &&
      !(runEnd - i === 1 && ch === "." && endsWithAbbreviation(body, i));

    if (!terminates) {
      i = runEnd;
      continue;
    }

    // Consume the one whitespace character after the run, as the old regex did.
    const spanEnd = next === null ? runEnd : runEnd + 1;
    const span = body.slice(start, spanEnd);
    if (span.trim() !== "") out.push(span);
    start = spanEnd;
    i = spanEnd;
  }

  const tail = body.slice(start);
  if (tail.trim() !== "") out.push(tail);
  return out;
}

type Candidate = { sentence: string; sectionTitle: string; score: number; order: number };

/**
 * Pick the sentences most likely to answer `question`, in score order.
 *
 * PURE and DETERMINISTIC: same text + same question ⇒ same passages, byte for
 * byte. Ties break toward the EARLIER sentence in the article (Wikipedia puts the
 * definitional statement first), so the ordering never depends on sort stability.
 *
 * Bounds hold strictly: at most `k` passages and at most `maxChars` characters of
 * sentence text in total. A passage that would push the total over the cap ends
 * the selection rather than being skipped — "the top ones that fit" is a rule a
 * reader can predict; "the top ones that happen to be short" is not.
 */
export function selectPassages(
  text: string,
  question: string,
  opts?: SelectPassagesOptions,
): Passage[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  const k = Math.max(0, Math.floor(opts?.k ?? DEFAULT_K));
  const maxChars = Math.max(0, Math.floor(opts?.maxChars ?? DEFAULT_MAX_CHARS));
  if (k === 0 || maxChars === 0) return [];

  const stems = questionStems(question);
  if (stems.size === 0) return [];

  const candidates: Candidate[] = [];
  let sectionTitle = "";
  let excludedAtLevel: number | null = null;
  let buffer: string[] = [];
  let order = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const body = stripCitationMarkers(buffer.join(" "));
    buffer = [];
    if (excludedAtLevel !== null) return;
    const headingStems = new Set(tokenize(sectionTitle).map(stem));
    for (const raw of splitSentences(body)) {
      const sentence = cleanSentence(raw);
      if (sentence.length < MIN_SENTENCE_CHARS || sentence.length > MAX_SENTENCE_CHARS) continue;
      const present = new Set([...tokenize(sentence).map(stem), ...headingStems]);
      let hits = 0;
      for (const s of stems) {
        if (present.has(s)) hits++;
      }
      const index = order++;
      if (hits === 0) continue;
      candidates.push({ sentence, sectionTitle, score: hits / stems.size, order: index });
    }
  };

  for (const line of text.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading === null) {
      buffer.push(line);
      continue;
    }
    flush();
    const level = (heading[1] ?? "==").length;
    const title = heading[2] ?? "";
    // Leaving an excluded section: the next heading at the same or shallower level.
    if (excludedAtLevel !== null && level <= excludedAtLevel) {
      excludedAtLevel = null;
    }
    if (excludedAtLevel === null && EXCLUDED_SECTIONS.has(title.trim().toLowerCase())) {
      excludedAtLevel = level;
    }
    sectionTitle = title;
  }
  flush();

  candidates.sort((a, b) => (b.score - a.score) || (a.order - b.order));

  const out: Passage[] = [];
  let used = 0;
  for (const candidate of candidates) {
    if (out.length >= k) break;
    if (used + candidate.sentence.length > maxChars) break;
    used += candidate.sentence.length;
    out.push({
      sentence: candidate.sentence,
      sectionTitle: candidate.sectionTitle,
      score: candidate.score,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The injected note
// ---------------------------------------------------------------------------

/**
 * Build the passages inject block: the selected sentences, each quoted and tagged
 * with its article + section, inside the SAME data fence and with the SAME opening
 * and closing instructions as the lead note (`buildFoundNote`). Sharing the
 * scaffolding is what makes the lead-vs-passages A/B measure the retrieved SPAN
 * rather than two different prompts.
 *
 * Every untrusted span — the title, the section heading, the sentence — is
 * neutralized BEFORE it is fenced, so a vandalized article cannot forge a
 * counterfeit `[BEGIN SOURCE TEXT]` region or close the real one early. No URL, for
 * the reason recorded on `FENCE_ANSWER_INSTRUCTION`.
 */
export function buildPassageNote(title: string, passages: Passage[]): string {
  const dataLines = passages.map((p) =>
    neutralizeFenceMarkers(
      p.sectionTitle.trim() === ""
        ? `[Source: Wikipedia — "${title}"] "${p.sentence}"`
        : `[Source: Wikipedia — "${title}", section "${p.sectionTitle}"] "${p.sentence}"`,
    ),
  );

  return [FENCE_PREAMBLE, FENCE_OPEN, ...dataLines, FENCE_CLOSE, FENCE_ANSWER_INSTRUCTION].join(
    "\n",
  );
}
