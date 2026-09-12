// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { rateLimitHitsTotal } from '../lib/metrics.js'

// ── Tiers ─────────────────────────────────────────────────────────────────────
// `auth` guards the credential surface (`/api/auth/*`) — sign-in, sign-up,
// password-reset, magic-link send — so its window is tight to stop brute-force,
// account enumeration, and email-send spam. `api` guards the broader `/v1/*`
// surface with a looser ceiling. `feedback` guards the anonymous free-text
// write endpoint (`/v1/feedback`) with a tight per-IP window on top of the
// general `api` tier — its own tier so its Redis key never collides with the
// `api` counter. `search` guards the unauthenticated web-search relay
// (`POST /v1/search`), whose every request costs an outbound fetch from Eco's
// own IP; its window is looser than `feedback` because one chat session asks
// several questions in a row, and its own tier keeps that burst off the
// feedback counter.
export type RateLimitTier = 'auth' | 'api' | 'feedback' | 'search'

// Default limits — named, not inlined as magic numbers. Each is overridable per
// construction call and via env (`RATE_LIMIT_*`) at the wiring site.
const DEFAULT_AUTH_LIMIT = 10
const DEFAULT_API_LIMIT = 100
const DEFAULT_FEEDBACK_LIMIT = 5
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_WINDOW_MS = 60_000 // 60s fixed window

/**
 * The narrow Redis surface the limiter depends on. Both `createRedisClient`'s
 * ioredis instance and the test fake satisfy this, so the limiter can be unit
 * tested without a live Redis.
 *
 * The limiter goes through a single `EVAL` (Lua) call — increment + arm-TTL in
 * ONE atomic Redis roundtrip. This structurally eliminates the window where a
 * key could be left incremented but WITHOUT a TTL (a separate INCR-then-PEXPIRE
 * could leak such a key on a mid-pair failure, leaving the count stuck above 1
 * forever and locking that IP out permanently). The script returns
 * `[count, pttlMs]`. ioredis types the `eval` reply as `unknown`, so we keep the
 * surface `unknown` and narrow at the call site.
 */
export type RateLimitRedis = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
}

// Atomic fixed-window increment-and-arm. Returns [count, pttlMs].
//  - INCR the key (creates it at 1 on the first hit of a window)
//  - on the first hit, set the window TTL in the SAME atomic call (no leaked-key
//    window — the key can never exist without an expiry)
//  - always return the live PTTL so callers report an accurate Retry-After
const FIXED_WINDOW_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`

type RateLimitLogger = {
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export type CreateRateLimiterOptions = {
  /**
   * The Redis client. When `undefined` (e.g. `REDIS_URL` unset in local dev,
   * tests, or an unconfigured deploy) the limiter is a no-op pass-through and
   * logs a single warning at construction. This is a conscious tradeoff: it
   * keeps existing API tests and local dev working unchanged, and means an
   * unconfigured deploy degrades to "no rate limiting" rather than being
   * hard-bricked. A configured prod deploy MUST set `REDIS_URL`.
   */
  redis: RateLimitRedis | undefined
  tier: RateLimitTier
  /** Max requests per window per client. Defaults to the tier default. */
  limit?: number
  /** Fixed-window length in milliseconds. */
  windowMs?: number
  /**
   * Resolve the trusted client identifier. Injectable for tests. When omitted,
   * the limiter trusts, in order: `X-Eco-Client-IP` when it arrives with a
   * matching `X-Eco-Proxy-Key` (see `proxySecret`), then `Fly-Client-IP` (set by
   * Fly's proxy, not client-spoofable), then Hono connection info for local/dev.
   * Raw `X-Forwarded-For` is deliberately NOT trusted (client-spoofable).
   */
  getClientIp?: (c: Context) => string
  /**
   * Shared secret the web app's `/v1/*` proxy presents in `X-Eco-Proxy-Key` to
   * vouch for the `X-Eco-Client-IP` it sets. Defaults to `API_PROXY_SECRET`,
   * read once here; injectable for tests. Unset (the local-dev and
   * single-host cases) → both headers are ignored entirely.
   */
  proxySecret?: string
  logger?: RateLimitLogger
}

const FALLBACK_CLIENT_IP = 'unknown'

const noopLogger: RateLimitLogger = {
  warn: () => undefined,
  error: () => undefined,
}

/** Header the web app's `/v1/*` proxy uses to name the real browser client. */
const CLIENT_IP_HEADER = 'X-Eco-Client-IP'
/** Header carrying the shared secret that makes `CLIENT_IP_HEADER` trustworthy. */
const PROXY_KEY_HEADER = 'X-Eco-Proxy-Key'

/**
 * Constant-time compare of a presented key against the configured secret.
 * `timingSafeEqual` throws on unequal lengths, so the length check happens
 * first — it leaks only the length, which the caller chose anyway.
 */
function keyMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(secret)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Build the trusted client-IP resolver.
 *
 * Three sources, most specific first:
 *
 * 1. `X-Eco-Client-IP`, but ONLY when `X-Eco-Proxy-Key` matches the configured
 *    secret. This exists because the web app proxies `/v1/*` server-side
 *    (`apps/web/app/v1/[...path]/route.ts`): without it the api's idea of the
 *    caller is Vercel's egress address, so every user of a region shares one
 *    per-IP bucket while a direct caller gets a private one. The proxy runs on
 *    Vercel, which overwrites `x-real-ip`/`x-forwarded-for` with the real client
 *    address, so the value it passes on is sound at its source; the shared
 *    secret is what makes it sound here, since any peer can send the header.
 * 2. `Fly-Client-IP`, injected by Fly's edge proxy and not client-settable.
 * 3. The TCP peer address via Hono's connection-info helper (local/dev).
 *
 * Raw `X-Forwarded-For` is still never trusted at this layer — nothing in front
 * of the api authenticates it, so a client could set it to any value and evade
 * the limit. `X-Eco-Client-IP` is the narrow, authenticated exception: with no
 * secret configured, or on a key mismatch, or on an IP that is not an IP, the
 * resolver falls through to (2) and (3) exactly as before.
 */
export function createClientIpResolver(proxySecret: string | undefined) {
  return function getClientIp(c: Context): string {
    if (proxySecret) {
      const presentedKey = c.req.header(PROXY_KEY_HEADER)
      if (presentedKey && keyMatches(presentedKey, proxySecret)) {
        // A list (`1.2.3.4, 5.6.7.8`), a hostname or junk is a misconfigured or
        // hostile proxy; `isIP` rejects all three and we fall through rather
        // than key the limiter on an attacker-chosen string.
        const claimedIp = c.req.header(CLIENT_IP_HEADER)?.trim()
        if (claimedIp && isIP(claimedIp) !== 0) return claimedIp
      }
    }

    const flyIp = c.req.header('Fly-Client-IP')
    if (flyIp) return flyIp

    try {
      const info = getConnInfo(c)
      if (info.remote.address) return info.remote.address
    } catch {
      // getConnInfo reads the underlying Node socket, which is absent in
      // Web-Fetch contexts (e.g. Vitest's app.request). Degrade safely.
    }
    return FALLBACK_CLIENT_IP
  }
}

/**
 * Narrow the `EVAL` reply (`[count, pttlMs]`). ioredis returns the Lua table as
 * an array of (typically) numbers; some drivers stringify integers, so coerce
 * defensively. Returns `null` if the shape is unrecognizable so the caller can
 * treat it as a transient failure.
 */
function parseEvalResult(reply: unknown): { count: number; pttlMs: number } | null {
  if (!Array.isArray(reply) || reply.length < 2) return null
  const count = Number(reply[0])
  const pttlMs = Number(reply[1])
  if (!Number.isFinite(count) || !Number.isFinite(pttlMs)) return null
  return { count, pttlMs }
}

/**
 * Create a Redis-backed fixed-window rate limiter as Hono middleware.
 *
 * Algorithm (per client, per window): a single atomic `EVAL` does `INCR` + arm
 * the window TTL on the first hit, and returns `[count, pttlMs]`. Reject once
 * the count exceeds `limit`. Because increment-and-arm is one atomic roundtrip,
 * a key can never be left incremented without a TTL (no permanent-lockout race).
 *
 * Failure semantics:
 *  - No Redis configured → no-op pass-through (warned once at construction).
 *  - Redis configured but a call throws/times out → fail CLOSED in production
 *    for the `auth` tier (so brute-force cannot ride a Redis outage), fail OPEN
 *    in development, and the `api` tier fails open everywhere.
 */
export function createRateLimiter(options: CreateRateLimiterOptions): MiddlewareHandler {
  const {
    redis,
    tier,
    windowMs = DEFAULT_WINDOW_MS,
    proxySecret = process.env.API_PROXY_SECRET,
    logger = noopLogger,
  } = options
  const getClientIp = options.getClientIp ?? createClientIpResolver(proxySecret)
  const limit =
    options.limit ??
    (tier === 'auth'
      ? DEFAULT_AUTH_LIMIT
      : tier === 'feedback'
        ? DEFAULT_FEEDBACK_LIMIT
        : tier === 'search'
          ? DEFAULT_SEARCH_LIMIT
          : DEFAULT_API_LIMIT)

  if (!redis) {
    logger.warn(
      { tier },
      'Rate limiting disabled: no Redis client configured (REDIS_URL unset). Requests pass through unlimited.',
    )
    return async (_c, next) => next()
  }

  return async (c, next) => {
    // OPTIONS preflight is short-circuited by CORS upstream; skip here too as
    // defense-in-depth so preflight is never counted against the window.
    if (c.req.method === 'OPTIONS') return next()

    const ip = getClientIp(c)
    const key = `rl:${tier}:${ip}`

    let count: number
    let pttlMs: number
    try {
      const reply = await redis.eval(FIXED_WINDOW_SCRIPT, 1, key, String(windowMs))
      const parsed = parseEvalResult(reply)
      if (!parsed) {
        // Unexpected reply shape — treat like a transient failure rather than
        // silently allowing/denying on garbage.
        throw new Error('Unexpected rate-limit EVAL reply shape')
      }
      count = parsed.count
      pttlMs = parsed.pttlMs
    } catch (err) {
      // Transient Redis failure. Never log the key as a secret; the IP is fine.
      logger.error({ err, tier, ip }, 'Rate limiter Redis error')
      const failClosed = tier === 'auth' && process.env.NODE_ENV === 'production'
      if (failClosed) {
        // Fail CLOSED: reject so brute-force cannot ride a Redis outage. Count
        // it so operators can see auth rejections even while Redis is down.
        return rejectUnavailable(c, tier, windowMs)
      }
      // Fail open: allow the request through.
      return next()
    }

    // Report the ACTUAL remaining window from the live PTTL (not a constant full
    // window). PTTL is -1 (no expiry) / -2 (no key) only in pathological cases
    // the atomic script prevents; guard anyway and fall back to the full window.
    const resetSeconds = pttlMs > 0 ? Math.ceil(pttlMs / 1000) : Math.ceil(windowMs / 1000)
    const remaining = Math.max(0, limit - count)

    if (count > limit) {
      rateLimitHitsTotal.inc({ tier })
      return rejectRateLimited(c, limit, resetSeconds)
    }

    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(remaining))
    c.header('X-RateLimit-Reset', String(resetSeconds))
    return next()
  }
}

function rejectRateLimited(c: Context, limit: number, resetSeconds: number): Response {
  c.header('Retry-After', String(resetSeconds))
  c.header('X-RateLimit-Limit', String(limit))
  c.header('X-RateLimit-Remaining', '0')
  c.header('X-RateLimit-Reset', String(resetSeconds))
  return c.json(
    { error: { message: 'Too many requests. Please slow down and try again shortly.', type: 'rate_limited' } },
    429,
  )
}

// Fail-closed response when Redis is unavailable for a protected tier: a 503 so
// callers know it is transient (not their own quota), still carrying Retry-After.
// Counted on `rate_limit_hits_total` so the outage rejections are observable.
function rejectUnavailable(c: Context, tier: RateLimitTier, windowMs: number): Response {
  rateLimitHitsTotal.inc({ tier })
  const resetSeconds = Math.ceil(windowMs / 1000)
  c.header('Retry-After', String(resetSeconds))
  return c.json(
    {
      error: {
        message: 'Rate limiter temporarily unavailable. Please retry shortly.',
        type: 'rate_limited',
      },
    },
    503,
  )
}
