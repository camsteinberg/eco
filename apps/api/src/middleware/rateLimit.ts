// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Context, MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { rateLimitHitsTotal } from '../lib/metrics.js'

// ── Tiers ─────────────────────────────────────────────────────────────────────
// `auth` guards the credential surface (`/api/auth/*`) — sign-in, sign-up,
// password-reset, magic-link send — so its window is tight to stop brute-force,
// account enumeration, and email-send spam. `api` guards the broader `/v1/*`
// surface with a looser ceiling.
export type RateLimitTier = 'auth' | 'api'

// Default limits — named, not inlined as magic numbers. Each is overridable per
// construction call and via env (`RATE_LIMIT_*`) at the wiring site.
const DEFAULT_AUTH_LIMIT = 10
const DEFAULT_API_LIMIT = 100
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
   * the limiter prefers the `Fly-Client-IP` header (set by Fly's proxy, not
   * client-spoofable) and falls back to Hono connection info for local/dev.
   * Raw `X-Forwarded-For` is deliberately NOT trusted (client-spoofable).
   */
  getClientIp?: (c: Context) => string
  logger?: RateLimitLogger
}

const FALLBACK_CLIENT_IP = 'unknown'

const noopLogger: RateLimitLogger = {
  warn: () => undefined,
  error: () => undefined,
}

/**
 * Resolve a TRUSTED client identifier. `Fly-Client-IP` is injected by Fly's
 * edge proxy and cannot be spoofed by the client, so it is preferred. For
 * local/dev (no Fly proxy) we fall back to the TCP peer address via Hono's
 * connection-info helper. We never key on raw `X-Forwarded-For` — a client can
 * set it to any value and trivially evade the limit.
 */
function defaultGetClientIp(c: Context): string {
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
    getClientIp = defaultGetClientIp,
    logger = noopLogger,
  } = options
  const limit = options.limit ?? (tier === 'auth' ? DEFAULT_AUTH_LIMIT : DEFAULT_API_LIMIT)

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
