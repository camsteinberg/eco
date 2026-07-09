// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Wikimedia grounding lookup engine (#5 Slice 1).
 *
 * Two pure, self-contained async primitives that fetch real facts straight from
 * Wikipedia + Wikidata so on-device chat can stop hallucinating:
 *   - {@link lookupWikipedia}   — free-text query → article summary
 *   - {@link getWikidataStatement} — QID + property → one structured fact
 *
 * Privacy guarantee (locked, do not break): every request goes DIRECTLY from the
 * browser to Wikimedia's public REST endpoints. No proxy, no API key — Eco's
 * servers never see the query. The module is SSR-safe: it touches no browser-only
 * globals at import time (only `fetch`, which is global in both the browser and the
 * Node/test runtime).
 *
 * Failure policy: these never throw to the caller. A Wikipedia lookup degrades to a
 * structured decline (`{ found: false, reason }`); a Wikidata lookup degrades to
 * `null`. A wrong field path must fall to the decline/null path, never crash.
 */

import type {
  GroundingRequestOptions,
  WikidataStatement,
  WikipediaFulltextResult,
  WikipediaResult,
  WikipediaSearchPage,
} from "./types";

/** Default per-request timeout. Tight, because this gates a chat turn. */
export const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Wikimedia's documented alternative to `User-Agent`, which browsers forbid setting
 * via `fetch`. Wikimedia bans empty/generic UAs, so we always send a descriptive one.
 */
const API_USER_AGENT = "EcoChat/1.0 (https://econetwork.ai; support@econetwork.ai)";

const WIKIPEDIA_REST_BASE = "https://en.wikipedia.org/w/rest.php/v1";
const WIKIPEDIA_SUMMARY_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary";
const WIKIDATA_STATEMENTS_BASE =
  "https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items";

/**
 * Truncate extracts to a modest on-device context budget. Raised 320/2 → 600/4
 * (chat #7 W2.2 T4): Wave 1 lifted the generation grant (LFM2.5 webgpu
 * maxNewTokens 1024→2048), so a 2-sentence extract was making grounded turns
 * compress while ungrounded ones expanded — the named variance complaint. ~600
 * chars ≈ 150 tokens of context, comfortably within the 4096 ctx budget alongside
 * the 2048 generation grant.
 */
const MAX_EXTRACT_CHARS = 600;
const MAX_EXTRACT_SENTENCES = 4;

/** Bound the session caches so a long session can't grow them without limit. */
const MAX_CACHE_ENTRIES = 50;

/** Cap the single etiquette retry wait, so a hostile `Retry-After` can't stall a turn. */
const MAX_RETRY_AFTER_MS = 3000;

// ---------------------------------------------------------------------------
// Session caches (module-level, bounded). Keyed by normalized query / `qid|prop`.
// We cache only SUCCESSES — declines and nulls are cheap to recompute and may be
// transient (timeout, network blip), so retrying them next turn is correct.
// ---------------------------------------------------------------------------

const wikipediaCache = new Map<string, Extract<WikipediaResult, { found: true }>>();
const wikidataCache = new Map<string, WikidataStatement>();
const fulltextCache = new Map<string, Extract<WikipediaFulltextResult, { found: true }>>();

/** Simple FIFO eviction: drop the oldest insertion when at capacity. */
function setBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, value);
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Test-only/escape hatch: clear both session caches. Not part of the chat surface. */
export function clearGroundingCache(): void {
  wikipediaCache.clear();
  wikidataCache.clear();
  fulltextCache.clear();
}

// ---------------------------------------------------------------------------
// Fetch plumbing: timeout + caller-signal composition + UA header + one retry.
// ---------------------------------------------------------------------------

/** Marker so we can tell a timeout/caller abort apart from other rejections. */
class AbortedError extends Error {
  constructor(readonly abortCause: "timeout" | "caller") {
    super(`grounding fetch aborted: ${abortCause}`);
    this.name = "AbortedError";
  }
}

/**
 * `fetch` with a bounded timeout, composed with any caller-supplied signal, the
 * required `Api-User-Agent` header, and ONE bounded retry on 429/503 honoring
 * `Retry-After`. Resolves to a `Response` (possibly non-ok) or rejects with an
 * {@link AbortedError} (timeout/caller) — every other failure rejects normally.
 */
async function groundedFetch(
  url: string,
  opts: GroundingRequestOptions | undefined,
  allowRetry: boolean
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callerSignal = opts?.signal;

  // Bail immediately if the caller already aborted.
  if (callerSignal?.aborted) {
    throw new AbortedError("caller");
  }

  const controller = new AbortController();

  const onCallerAbort = () => {
    controller.abort("caller");
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort("timeout");
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      headers: { "Api-User-Agent": API_USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });

    // Etiquette: on 429/503, honor one bounded Retry-After then try once more.
    if (allowRetry && (response.status === 429 || response.status === 503)) {
      const waitMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      await delay(waitMs, callerSignal);
      return await groundedFetch(url, opts, false);
    }

    return response;
  } catch (err) {
    // Distinguish "we aborted" (timeout/caller) from a genuine network rejection.
    // The abort `reason` we set tells us which fired.
    if (isAbortError(err)) {
      const reason: unknown = controller.signal.reason;
      throw new AbortedError(reason === "caller" ? "caller" : "timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof DOMException && err.name === "AbortError"
  ) || (err instanceof Error && err.name === "AbortError");
}

/** Parse a `Retry-After` header (delta-seconds only; HTTP-date is ignored). Bounded. */
function parseRetryAfterMs(header: string | null): number {
  if (header === null) {
    return 0;
  }
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

/** Sleep `ms`, rejecting early (as a caller-abort) if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError("caller"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError("caller"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read JSON defensively — a parse failure surfaces as `null`, never a throw. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Defensive response narrowing. The network is the source of truth; every field
// path is optional-chained and guarded so an unexpected shape declines cleanly.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** First non-empty `title`/`key` from a `{ pages: [...] }` search payload. */
function firstSearchTitle(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const pages = payload.pages;
  if (!Array.isArray(pages)) {
    return null;
  }
  for (const page of pages) {
    if (!isRecord(page)) {
      continue;
    }
    const title = page.title;
    if (typeof title === "string" && title.trim() !== "") {
      return title;
    }
    const key = page.key;
    if (typeof key === "string" && key.trim() !== "") {
      return key;
    }
  }
  return null;
}

/**
 * Narrow a `{ pages: [...] }` search payload to the usable hits, IN ORDER, keeping
 * only `title` (+ `key` when present). Mirrors {@link firstSearchTitle}'s defensive
 * field-by-field guarding but returns ALL top hits (the zero-entity recall path
 * scans them in order against its coverage gate, not just the first). A page with
 * neither a usable `title` nor `key` is skipped; `key` substitutes for a missing
 * `title`. Returns `[]` for a malformed/empty payload — never throws.
 */
function searchPages(payload: unknown): WikipediaSearchPage[] {
  if (!isRecord(payload) || !Array.isArray(payload.pages)) {
    return [];
  }
  const out: WikipediaSearchPage[] = [];
  for (const page of payload.pages) {
    if (!isRecord(page)) {
      continue;
    }
    const rawTitle = typeof page.title === "string" ? page.title.trim() : "";
    const rawKey = typeof page.key === "string" ? page.key.trim() : "";
    // `key` is the URL-safe fallback when `title` is absent/blank.
    const title = rawTitle !== "" ? rawTitle : rawKey;
    if (title === "") {
      continue;
    }
    out.push(rawKey !== "" ? { title, key: rawKey } : { title });
  }
  return out;
}

/** Pull the desktop article URL out of `content_urls.desktop.page`. */
function summaryUrl(summary: Record<string, unknown>): string | null {
  const contentUrls = summary.content_urls;
  if (!isRecord(contentUrls)) {
    return null;
  }
  const desktop = contentUrls.desktop;
  if (!isRecord(desktop)) {
    return null;
  }
  const page = desktop.page;
  return typeof page === "string" && page.trim() !== "" ? page : null;
}

/**
 * Truncate a plain-text extract to ~`MAX_EXTRACT_SENTENCES` sentences / ~`MAX_EXTRACT_CHARS`
 * chars without cutting mid-word. Splits on sentence boundaries first; if the result
 * is still over the char budget, trims back to the last whole word and adds an ellipsis.
 */
function truncateExtract(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") {
    return clean;
  }

  // Take up to N sentences (terminator + following space, or end of string).
  const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [clean];
  let out = sentences.slice(0, MAX_EXTRACT_SENTENCES).join("").trim();

  if (out.length <= MAX_EXTRACT_CHARS) {
    return out;
  }

  // Still too long: trim to the char budget on a word boundary.
  out = out.slice(0, MAX_EXTRACT_CHARS);
  const lastSpace = out.lastIndexOf(" ");
  if (lastSpace > 0) {
    out = out.slice(0, lastSpace);
  }
  return `${out.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// lookupWikipedia
// ---------------------------------------------------------------------------

/**
 * Resolve a free-text query to a Wikipedia article and return its summary.
 *
 * Pipeline (strictly serial — never fires both requests at once):
 *   1. `GET /search/title?q=…&limit=3` → take the top page's title/key.
 *      Empty? Fall back to `GET /search/page?q=…&limit=3`. Still empty → `no-match`.
 *   2. `GET /api/rest_v1/page/summary/{title}` → if `type === 'disambiguation'`,
 *      decline as `disambiguation`; otherwise return the truncated summary.
 *
 * Any non-ok HTTP, fetch rejection, or JSON parse failure declines as
 * `network-error`. A timeout (per-request or caller abort) declines as `timeout`.
 */
export async function lookupWikipedia(
  query: string,
  opts?: GroundingRequestOptions
): Promise<WikipediaResult> {
  if (typeof query !== "string" || query.trim() === "") {
    return { found: false, reason: "no-match" };
  }

  const cacheKey = normalizeQuery(query);
  const cached = wikipediaCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const title = await resolveTitle(query, opts);
    if (title === null) {
      return { found: false, reason: "no-match" };
    }

    const summaryResponse = await groundedFetch(
      `${WIKIPEDIA_SUMMARY_BASE}/${encodeURIComponent(title)}`,
      opts,
      true
    );
    if (!summaryResponse.ok) {
      return { found: false, reason: "network-error" };
    }

    const summary = await readJson(summaryResponse);
    if (!isRecord(summary)) {
      return { found: false, reason: "network-error" };
    }

    if (summary.type === "disambiguation") {
      return { found: false, reason: "disambiguation" };
    }

    const resolvedTitle = summary.title;
    const extractRaw = summary.extract;
    const url = summaryUrl(summary);
    if (
      typeof resolvedTitle !== "string" ||
      typeof extractRaw !== "string" ||
      extractRaw.trim() === "" ||
      url === null
    ) {
      // The summary exists but lacks the fields we need to ground/cite on.
      return { found: false, reason: "no-match" };
    }

    const qid = summary.wikibase_item;
    const result: Extract<WikipediaResult, { found: true }> = {
      found: true,
      title: resolvedTitle,
      extract: truncateExtract(extractRaw),
      url,
      ...(typeof qid === "string" && qid.trim() !== "" ? { qid } : {}),
    };

    setBounded(wikipediaCache, cacheKey, result);
    return result;
  } catch (err) {
    if (err instanceof AbortedError) {
      // Both timeout and caller-abort surface to the user as a timed-out lookup.
      return { found: false, reason: "timeout" };
    }
    return { found: false, reason: "network-error" };
  }
}

/**
 * Resolve a query to an article title via `/search/title`, falling back to
 * `/search/page` when title-search returns no pages. Returns `null` for no match.
 * Throws {@link AbortedError} on timeout/abort and rethrows real fetch rejections —
 * the caller maps both.
 */
async function resolveTitle(
  query: string,
  opts: GroundingRequestOptions | undefined
): Promise<string | null> {
  const encoded = encodeURIComponent(query);

  const titleResponse = await groundedFetch(
    `${WIKIPEDIA_REST_BASE}/search/title?q=${encoded}&limit=3`,
    opts,
    true
  );
  if (!titleResponse.ok) {
    throw new NetworkError();
  }
  const titleHit = firstSearchTitle(await readJson(titleResponse));
  if (titleHit !== null) {
    return titleHit;
  }

  // Fallback: full-text page search (same response shape).
  const pageResponse = await groundedFetch(
    `${WIKIPEDIA_REST_BASE}/search/page?q=${encoded}&limit=3`,
    opts,
    true
  );
  if (!pageResponse.ok) {
    throw new NetworkError();
  }
  return firstSearchTitle(await readJson(pageResponse));
}

/** Sentinel for a non-ok HTTP response so the caller maps it to `network-error`. */
class NetworkError extends Error {
  constructor() {
    super("grounding network error");
    this.name = "NetworkError";
  }
}

// ---------------------------------------------------------------------------
// searchWikipediaFulltext — zero-entity recall (chat #7 W2.2 T3)
// ---------------------------------------------------------------------------

/**
 * Full-text search for a natural-language question that carries NO extractable
 * entity ("how many calories in an apple"). Returns the top hits' titles so the
 * caller can scan them against its own coverage gate and ground the right article.
 *
 * Single request to `GET /search/page?q=…&limit=3` — full-text only (it resolves a
 * question to the right ARTICLE where `/search/title` can't), never the title
 * endpoint and never a summary. Returns title + key ONLY: an `excerpt` is
 * lead-biased and a later reranker phase owns relevance/snippet selection.
 *
 * Same contract as {@link lookupWikipedia}: never throws, session-cached (successes
 * only — declines are cheap and may be transient), bounded, and abort/timeout-aware.
 * A non-ok HTTP / fetch rejection / parse failure declines `network-error`; a
 * timeout or caller abort declines `timeout`; zero hits decline `no-match`.
 * (No `disambiguation`: a raw page search never fetches a summary, so it can't
 * observe one — the caller detects that when it fetches the accepted title's summary.)
 */
export async function searchWikipediaFulltext(
  query: string,
  opts?: GroundingRequestOptions
): Promise<WikipediaFulltextResult> {
  if (typeof query !== "string" || query.trim() === "") {
    return { found: false, reason: "no-match" };
  }

  const cacheKey = normalizeQuery(query);
  const cached = fulltextCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await groundedFetch(
      `${WIKIPEDIA_REST_BASE}/search/page?q=${encodeURIComponent(query)}&limit=3`,
      opts,
      true
    );
    if (!response.ok) {
      return { found: false, reason: "network-error" };
    }

    const payload = await readJson(response);
    // A failed parse (`readJson` → null) is an unreadable response → network-error,
    // distinct from a well-formed-but-empty `{ pages: [] }` payload → no-match.
    if (!isRecord(payload)) {
      return { found: false, reason: "network-error" };
    }

    const pages = searchPages(payload);
    if (pages.length === 0) {
      return { found: false, reason: "no-match" };
    }

    const result: Extract<WikipediaFulltextResult, { found: true }> = {
      found: true,
      pages,
    };
    setBounded(fulltextCache, cacheKey, result);
    return result;
  } catch (err) {
    if (err instanceof AbortedError) {
      return { found: false, reason: "timeout" };
    }
    return { found: false, reason: "network-error" };
  }
}

// ---------------------------------------------------------------------------
// getWikidataStatement
// ---------------------------------------------------------------------------

/**
 * Fetch a single structured Wikidata statement for `qid`/`propertyId`
 * (e.g. P1082 "population" on Q90 "Paris").
 *
 * `GET /entities/items/{qid}/statements?property={propertyId}` →
 *   `{ "{propertyId}": [ { value: { content: { amount } }, qualifiers, rank } ] }`.
 * Picks the `rank: 'preferred'` statement (else the first), reads
 * `value.content.amount` (stripping a leading `+`, tolerating string/number), and
 * pulls the year out of a `P585` "point in time" qualifier into `asOf`.
 *
 * Returns `null` for: missing statements, a `novalue`/`somevalue` snak, any
 * unreadable amount, non-ok HTTP, fetch rejection, JSON parse failure, or
 * timeout/abort. Never throws.
 */
export async function getWikidataStatement(
  qid: string,
  propertyId: string,
  opts?: GroundingRequestOptions
): Promise<WikidataStatement | null> {
  if (
    typeof qid !== "string" ||
    qid.trim() === "" ||
    typeof propertyId !== "string" ||
    propertyId.trim() === ""
  ) {
    return null;
  }

  const cacheKey = `${qid}|${propertyId}`;
  const cached = wikidataCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await groundedFetch(
      `${WIKIDATA_STATEMENTS_BASE}/${encodeURIComponent(qid)}/statements?property=${encodeURIComponent(propertyId)}`,
      opts,
      true
    );
    if (!response.ok) {
      return null;
    }

    const payload = await readJson(response);
    if (!isRecord(payload)) {
      return null;
    }

    const statements = payload[propertyId];
    if (!Array.isArray(statements) || statements.length === 0) {
      return null;
    }

    const statement = pickStatement(statements);
    if (statement === null) {
      return null;
    }

    const value = readAmount(statement);
    if (value === null) {
      return null;
    }

    const asOf = readPointInTimeYear(statement);
    const result: WikidataStatement = {
      value,
      ...(asOf !== null ? { asOf } : {}),
    };

    setBounded(wikidataCache, cacheKey, result);
    return result;
  } catch {
    // AbortedError, NetworkError, or anything else — all degrade to null here.
    return null;
  }
}

/** The `rank: 'preferred'` statement if any, else the first. */
function pickStatement(statements: unknown[]): Record<string, unknown> | null {
  const records = statements.filter(isRecord);
  if (records.length === 0) {
    return null;
  }
  const preferred = records.find((s) => s.rank === "preferred");
  return preferred ?? records[0] ?? null;
}

/**
 * Read `value.content.amount` from a statement. Strips a leading `+`; tolerates a
 * plain string or number `content`. Returns `null` for a `novalue`/`somevalue` snak
 * or any unreadable shape.
 */
function readAmount(statement: Record<string, unknown>): string | null {
  const value = statement.value;
  if (!isRecord(value)) {
    return null;
  }

  // Guard `novalue` / `somevalue` snaks — they carry no usable content.
  const type = value.type;
  if (type === "novalue" || type === "somevalue") {
    return null;
  }

  const content = value.content;

  // Quantity shape: { content: { amount } }.
  if (isRecord(content)) {
    const amount = content.amount;
    return normalizeAmount(amount);
  }

  // Some properties surface `content` directly as a string/number.
  return normalizeAmount(content);
}

function normalizeAmount(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim().replace(/^\+/, "");
  }
  return null;
}

/**
 * Find a `P585` "point in time" qualifier and parse its year out of
 * `value.content.time` (format `+YYYY-MM-DDT…`). Returns the year string, or `null`.
 */
function readPointInTimeYear(statement: Record<string, unknown>): string | null {
  const qualifiers = statement.qualifiers;
  if (!Array.isArray(qualifiers)) {
    return null;
  }

  for (const qualifier of qualifiers) {
    if (!isRecord(qualifier)) {
      continue;
    }
    const property = qualifier.property;
    if (!isRecord(property) || property.id !== "P585") {
      continue;
    }
    const value = qualifier.value;
    if (!isRecord(value)) {
      continue;
    }
    const content = value.content;
    if (!isRecord(content)) {
      continue;
    }
    const time = content.time;
    if (typeof time !== "string") {
      continue;
    }
    // Format: "+2020-00-00T00:00:00Z" — pull the 4-digit year after the sign.
    const match = /^[+-]?(\d{4})/.exec(time);
    if (match?.[1] !== undefined) {
      return match[1];
    }
  }
  return null;
}
