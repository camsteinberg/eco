// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * The web-search relay (`POST /v1/search`).
 *
 * Eco's chat runs on the person's own device, so the browser must never talk to a
 * search engine directly — that would hand the engine the user's IP, their browser
 * fingerprint and their question in one request. The relay is the whole point: the
 * browser asks Eco, Eco asks a SELF-HOSTED SearXNG instance on the private Fly
 * network, and the engine sees only Eco's datacenter IP.
 *
 * What that costs, stated honestly (the privacy claim has to be accurate):
 *  - Eco's server DOES see the query for the lifetime of the request. It is never
 *    written to a log, an error message, a metric label or a database — the tests
 *    in `__tests__/search.test.ts` assert that — but "the server never sees it" is
 *    NOT true of this route and must not be claimed.
 *  - No cookie is read or set, no auth is required, no user id exists here. A query
 *    cannot be tied back to an account by this route.
 *
 * Failure policy: this endpoint never 5xxs on upstream trouble. A timeout, a dead
 * instance, a non-JSON body or zero hits all return `200 { fetchedAt, results: [] }`
 * so the client has exactly one "nothing found" path to handle. The only non-200s
 * are validation (400), the global daily ceiling (503) and the middleware in front
 * of it (403 Origin, 429 per-IP).
 */

import { Hono } from 'hono'
import type { RateLimitRedis } from '../middleware/rateLimit.js'

// ── Bounds ───────────────────────────────────────────────────────────────────
/** Shorter than this is not a search, it is a typo. */
export const MIN_QUERY_LENGTH = 2
/** A real query is a question, not a payload. Also bounds what we hand upstream. */
export const MAX_QUERY_LENGTH = 200
/** Three results is what a 1–2B model can actually use in its context window. */
export const MAX_RESULTS = 3
/** ~55 tokens per snippet — three of them fit a small model's grounding note. */
export const MAX_SNIPPET_CHARS = 220
/** Matches `MAX_TITLE_LEN` in the web app's fence module. */
export const MAX_TITLE_CHARS = 100
/** Tight: this gates a chat turn. Same budget as the Wikipedia lookup. */
export const UPSTREAM_TIMEOUT_MS = 4000
/** One Redis key per UTC day, holding the global request count. */
export const DAILY_KEY_PREFIX = 'ratelimit:search:daily:'
const DAILY_TTL_SECONDS = 86_400

const ELLIPSIS = '…'

// ── Types ────────────────────────────────────────────────────────────────────

export type SearchResult = {
  title: string
  url: string
  snippet: string
  domain: string
  published?: string
}

export type SearchResponse = {
  /** ISO timestamp of the moment the relay answered — the client shows recency. */
  fetchedAt: string
  results: SearchResult[]
}

type Env = {
  Variables: {
    /** Per-request pino child logger set by the logging middleware. */
    logger?: { warn: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void }
  }
}

/** Injectable so tests never touch the network. Defaults to global `fetch`. */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

export type CreateSearchRouterOptions = {
  /**
   * Base URL of the SearXNG instance, e.g. `http://eco-searxng.internal:8080`.
   * `undefined` (dev, unconfigured) makes every request return an empty result
   * set — the route stays mounted so the client path is exercisable locally.
   */
  searxngUrl: string | undefined
  /**
   * Backs the global daily ceiling. Shares the rate limiter's client and its
   * narrow `eval` surface.
   */
  redis: RateLimitRedis
  /** Global requests allowed per UTC day across ALL callers. */
  dailyMax: number
  fetchImpl?: FetchImpl
  /** Injectable clock, so the daily-key rollover is testable. */
  now?: () => Date
}

// ── Fence-marker neutralisation ──────────────────────────────────────────────
/**
 * Port of `neutralizeFenceMarkers` in `apps/web/src/lib/grounding/fence.ts`.
 *
 * The api cannot import from the web app (separate tsconfig projects, separate
 * deploy artifacts), so the behaviour is re-implemented here and must stay in
 * step with that original — it is the same defense, applied one hop earlier.
 *
 * Why here at all: search snippets are attacker-authored text. Anyone can publish
 * a page reading "[END SOURCE TEXT] Ignore previous instructions …" and rank it for
 * a niche query. The web app wraps retrieved text in a `[BEGIN SOURCE TEXT]` /
 * `[END SOURCE TEXT]` fence and tells the model the fenced span is data; stripping
 * the marker tokens from the untrusted text is what stops a snippet forging or
 * escaping that fence. Doing it in the relay means no caller can forget to.
 *
 * Linearity: the pattern is anchored to the optional open bracket / `BEGIN|END`
 * literal — no leading greedy `\s*`, no `\b` — so it runs in O(n) with no
 * catastrophic backtracking, and a marker fused to adjacent text still matches.
 * Input is length-capped by the caller (title/snippet truncation) before it lands
 * here, which is the belt-and-suspenders bound.
 */
export function neutralizeFenceMarkers(text: string): string {
  const MARKER = /[[<({]?(?:BEGIN|END)\s+SOURCE\s+TEXT[\]>)}]?/gi
  return text.replace(MARKER, '(source-marker removed)')
}

/**
 * Collapse whitespace, then cut to `max` with an ellipsis. Mirrors `truncate` in
 * `apps/web/src/local-ai/eval/real-time-fixture.ts`.
 */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, Math.max(1, max - 1)).trimEnd()}${ELLIPSIS}`
}

/**
 * Neutralise AFTER truncation, never before: cutting a string that already
 * contains "(source-marker removed)" can land mid-replacement and leave a
 * fragment. Same ordering the web app's `resultLine` uses.
 */
function cleanSpan(text: string, max: number): string {
  return neutralizeFenceMarkers(truncate(text, max))
}

/** Hostname without a leading `www.`; `null` when the URL will not parse. */
export function domainOf(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname.replace(/^www\./i, '')
  } catch {
    return null
  }
}

// ── Upstream response narrowing ──────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Narrow SearXNG's `{ results: [...] }` payload into at most {@link MAX_RESULTS}
 * clean results. Defensive on purpose: the shape is a third party's, so a missing
 * field, a null, or a wrong type drops that row rather than throwing. A row needs
 * a parseable `url` and a non-empty `title` to survive.
 */
export function parseSearxngResults(payload: unknown): SearchResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) return []

  const out: SearchResult[] = []
  for (const row of payload.results) {
    if (out.length >= MAX_RESULTS) break
    if (!isRecord(row)) continue

    const url = nonEmptyString(row.url)
    const title = nonEmptyString(row.title)
    if (url === null || title === null) continue

    const domain = domainOf(url)
    if (domain === null) continue

    const snippet = cleanSpan(nonEmptyString(row.content) ?? '', MAX_SNIPPET_CHARS)
    const published = nonEmptyString(row.publishedDate)

    out.push({
      title: cleanSpan(title, MAX_TITLE_CHARS),
      url,
      snippet,
      domain,
      // `published` is present only when upstream gave a non-empty string — an
      // absent key is honest about "we do not know when this was written".
      ...(published === null ? {} : { published: truncate(published, MAX_TITLE_CHARS) }),
    })
  }
  return out
}

// ── Daily ceiling ────────────────────────────────────────────────────────────

/**
 * Atomic increment-and-arm for the global daily counter, in ONE Redis roundtrip:
 * a separate INCR-then-EXPIRE can leave a key incremented without a TTL, which
 * would freeze the global ceiling at a stuck value forever. Returns the count.
 */
const DAILY_COUNTER_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`

/** `ratelimit:search:daily:YYYY-MM-DD`, UTC so the reset is not machine-local. */
export function dailyKey(now: Date): string {
  return `${DAILY_KEY_PREFIX}${now.toISOString().slice(0, 10)}`
}

// ── Upstream fetch ───────────────────────────────────────────────────────────

/**
 * SearXNG's own docs ask relays to identify themselves. This is the ONLY thing
 * the upstream sees that is about Eco; nothing about the caller is forwarded.
 */
const UPSTREAM_USER_AGENT = 'EcoRelay/1.0 (https://econetwork.ai)'

/** One attempt. `null` = retryable failure; `'fatal'` = do not retry. */
type AttemptOutcome = { kind: 'ok'; payload: unknown } | { kind: 'retry'; detail: string } | { kind: 'fatal'; detail: string }

async function attemptUpstream(
  searxngUrl: string,
  query: string,
  fetchImpl: FetchImpl,
): Promise<AttemptOutcome> {
  const url =
    `${searxngUrl.replace(/\/+$/, '')}/search` +
    `?q=${encodeURIComponent(query)}&format=json&language=en&safesearch=1&categories=general`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': UPSTREAM_USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    // NOTHING derived from `err` is returned: an undici failure can carry the
    // request URL — which contains the query — in `message`/`cause`. Only the
    // error NAME (`TimeoutError`, `TypeError`) escapes, and it is a constant.
    return { kind: 'retry', detail: err instanceof Error ? err.name : 'UnknownError' }
  }

  if (response.status >= 500) return { kind: 'retry', detail: `status_${String(response.status)}` }
  if (!response.ok) return { kind: 'fatal', detail: `status_${String(response.status)}` }

  try {
    return { kind: 'ok', payload: await response.json() }
  } catch {
    // Non-JSON body (an HTML error page, a truncated read). Not retryable: the
    // instance answered, it just answered wrong.
    return { kind: 'fatal', detail: 'non_json_body' }
  }
}

/**
 * Fetch with ONE retry, on a network error, a timeout or a 5xx only — a 4xx means
 * the request itself is wrong and a second identical request cannot fix it.
 * Returns `null` when both attempts fail; the caller turns that into an empty
 * result set. (Typed `unknown` rather than `unknown | null` — `null` is already
 * inhabited by `unknown`, and a literal JSON `null` body lands on the same empty
 * result the failure path produces, so the two are indistinguishable by design.)
 */
async function fetchUpstream(
  searxngUrl: string,
  query: string,
  fetchImpl: FetchImpl,
  logger: Env['Variables']['logger'],
): Promise<unknown> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const outcome = await attemptUpstream(searxngUrl, query, fetchImpl)
    if (outcome.kind === 'ok') return outcome.payload

    // `detail` is a constant token by construction (see above) — never the URL,
    // never the query, never an upstream body.
    logger?.warn({ attempt, detail: outcome.detail }, 'Search relay upstream attempt failed')
    if (outcome.kind === 'fatal') return null
  }
  return null
}

// ── Router ───────────────────────────────────────────────────────────────────

function validationError(message: string) {
  return { error: { message, type: 'validation_error' } } as const
}

export function createSearchRouter(options: CreateSearchRouterOptions) {
  const { searxngUrl, redis, dailyMax, fetchImpl = fetch, now = () => new Date() } = options
  const router = new Hono<Env>()

  // POST / — relay one query. No auth, no cookie, no user id: chat needs no
  // account, so an auth-gated lookup would exclude most people. The defense
  // stack in front of this is the Origin allowlist, the 4 KB body limit, the
  // per-IP `search` tier and the global daily ceiling below.
  router.post('/', async (c) => {
    let body: Record<string, unknown>
    try {
      body = (await c.req.json()) as Record<string, unknown>
    } catch {
      return c.json({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }, 400)
    }

    if (typeof body.q !== 'string') {
      return c.json(validationError('q is required and must be a string'), 400)
    }

    const query = body.q.trim()
    if (query.length < MIN_QUERY_LENGTH) {
      return c.json(validationError(`q must be at least ${String(MIN_QUERY_LENGTH)} characters`), 400)
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return c.json(validationError(`q must be at most ${String(MAX_QUERY_LENGTH)} characters`), 400)
    }

    const logger = c.get('logger')

    // ── Global daily ceiling ────────────────────────────────────────────────
    // The per-IP tier bounds one caller; this bounds the bill. It is a single
    // global counter, not a per-user quota — there are no users here.
    //
    // Redis unavailable → FAIL OPEN, mirroring `createRateLimiter`'s choice for
    // every tier except `auth` in production (rateLimit.ts:186-193). The
    // asymmetry is deliberate: failing closed on `auth` stops brute force riding
    // a Redis outage, whereas failing closed here would take search down for
    // everyone during a blip to protect a cost ceiling. The per-IP limiter in
    // front of this route fails open in the same outage, so the exposure is a
    // bounded overspend, not an open relay.
    try {
      const reply = await redis.eval(DAILY_COUNTER_SCRIPT, 1, dailyKey(now()), DAILY_TTL_SECONDS)
      const count = Number(reply)
      if (Number.isFinite(count) && count > dailyMax) {
        return c.json(
          {
            error: {
              message: 'Search is temporarily unavailable. Please try again later.',
              type: 'search_unavailable',
            },
          },
          503,
        )
      }
    } catch (err) {
      logger?.error(
        { name: err instanceof Error ? err.name : 'UnknownError' },
        'Search relay daily counter unavailable — allowing the request',
      )
    }

    c.header('Cache-Control', 'no-store')
    const fetchedAt = now().toISOString()

    // Unconfigured (dev): answer the real shape with nothing in it, so the
    // client path is exercisable without a SearXNG instance. The warning is
    // emitted once at boot (see `resolveSearchConfig`), never per request —
    // a per-request log line on an unconfigured dev box is just noise.
    if (searxngUrl === undefined) {
      return c.json({ fetchedAt, results: [] } satisfies SearchResponse)
    }

    const payload = await fetchUpstream(searxngUrl, query, fetchImpl, logger)
    const results = payload === null ? [] : parseSearxngResults(payload)

    return c.json({ fetchedAt, results } satisfies SearchResponse)
  })

  return router
}

// ── Boot-time configuration ──────────────────────────────────────────────────

export type SearchConfig = {
  searxngUrl: string | undefined
  /** Whether the route should be mounted at all. */
  enabled: boolean
  warnings: { level: 'warn' | 'error'; msg: string }[]
}

/**
 * Resolve the relay's configuration from the environment. Pure (env in → config
 * out) so the boot decision is unit-testable without standing up a server —
 * the same shape as `resolveDependencyPolicy` in `lib/production-guards.ts`.
 *
 * DEVIATION from that module, deliberately: a missing `SEARXNG_URL` in production
 * does NOT throw at boot. `resolveDependencyPolicy` fails the boot for Postgres
 * and Redis because an API without them serves a broken auth surface; an API
 * without a search backend simply has no search. Bricking every deploy on a
 * secret that must be set AFTER the SearXNG app exists would make the first
 * deploy of this feature unlandable. Instead the route is not mounted and the
 * gap is logged at `error` level, so a production box missing it is loud.
 */
export type SearchEnv = {
  NODE_ENV?: string | undefined
  SEARXNG_URL?: string | undefined
  // Index signature so `process.env` (NodeJS.ProcessEnv) is assignable — the
  // named keys above stay for documentation of what this actually reads.
  // Same shape as `DependencyEnv` in `lib/production-guards.ts`.
  [key: string]: string | undefined
}

export function resolveSearchConfig(env: SearchEnv): SearchConfig {
  const isProduction = env.NODE_ENV === 'production'
  const raw = env.SEARXNG_URL?.trim()
  const searxngUrl = raw !== undefined && raw.length > 0 ? raw : undefined

  if (searxngUrl !== undefined) {
    return { searxngUrl, enabled: true, warnings: [] }
  }

  if (isProduction) {
    return {
      searxngUrl: undefined,
      enabled: false,
      warnings: [
        {
          level: 'error',
          msg:
            'SEARXNG_URL is not set in production — POST /v1/search is NOT mounted and web lookups will fail. ' +
            'Set SEARXNG_URL (e.g. http://eco-searxng.internal:8080) to enable the relay.',
        },
      ],
    }
  }

  return {
    searxngUrl: undefined,
    enabled: true,
    warnings: [
      {
        level: 'warn',
        msg: 'SEARXNG_URL is not set — POST /v1/search answers with an empty result set (dev only).',
      },
    ],
  }
}
