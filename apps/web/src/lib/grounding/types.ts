// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Result types for the Wikimedia grounding lookup engine (#5 Slice 1).
 *
 * These are the pure data shapes returned by the two grounding primitives in
 * {@link ./wikimedia}. Nothing here renders or wires into the chat pipeline —
 * a later slice composes these into a tool and a citation render.
 */

/** Why a Wikipedia lookup declined to return an article. */
export type WikipediaDeclineReason =
  /** No search hit (after the title→page fallback). */
  | "no-match"
  /** The resolved article is a disambiguation page — too ambiguous to ground on. */
  | "disambiguation"
  /** The request exceeded `timeoutMs` (or a caller-supplied signal aborted it). */
  | "timeout"
  /** Non-ok HTTP, a fetch rejection, or a JSON parse failure. */
  | "network-error";

/**
 * The outcome of {@link lookupWikipedia}: either a grounded article summary, or a
 * structured decline reason. Never throws — callers branch on `found`.
 */
export type WikipediaResult =
  | {
      found: true;
      /** The canonical article title from the summary endpoint. */
      title: string;
      /** A plain-text extract truncated to ~4 sentences for an on-device budget. */
      extract: string;
      /** The desktop article URL — use this as the citation link. */
      url: string;
      /** The linked Wikidata QID (e.g. "Q90"), when the article exposes one. */
      qid?: string;
    }
  | { found: false; reason: WikipediaDeclineReason };

/**
 * The outcome of {@link searchWikipediaFulltext}: either the top full-text search
 * hits (title + key only — no excerpts; an excerpt is lead-biased and a later
 * reranker phase owns relevance scoring), or a structured decline. Never throws.
 *
 * Note the decline set is narrower than {@link WikipediaResult}'s: a raw page
 * search never fetches a summary, so it cannot observe `disambiguation` — only
 * `no-match` (zero hits), `timeout`, or `network-error`. The caller fetches the
 * summary of an accepted title separately (via {@link lookupWikipedia}), which is
 * where a disambiguation page is detected.
 */
export type WikipediaFulltextResult =
  | { found: true; pages: readonly WikipediaSearchPage[] }
  | {
      found: false;
      reason: Exclude<WikipediaDeclineReason, "disambiguation">;
    };

/** One full-text search hit — only the fields the zero-entity recall path needs. */
export type WikipediaSearchPage = {
  /** The article display title (e.g. "Apple"). */
  title: string;
  /** The URL-safe article key, when present (a defensive fallback for `title`). */
  key?: string;
};

/**
 * A single structured Wikidata statement value resolved by
 * {@link getWikidataStatement} — e.g. a population count plus the year it was
 * recorded. `null` (not an object) signals "no usable statement".
 */
export type WikidataStatement = {
  /** The statement's amount/value as a normalized string (leading `+` stripped). */
  value: string;
  /** The year (as a string, e.g. "2020") from a P585 "point in time" qualifier, if present. */
  asOf?: string;
};

/** Per-call knobs shared by both grounding primitives. */
export type GroundingRequestOptions = {
  /** A caller-owned abort signal. If it aborts, the in-flight fetch aborts. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
};
