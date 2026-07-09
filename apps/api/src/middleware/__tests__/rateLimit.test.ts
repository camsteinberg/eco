// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createRateLimiter, type RateLimitRedis } from '../rateLimit.js'
import { rateLimitHitsTotal } from '../../lib/metrics.js'

// ── Fake in-memory Redis modeling the single atomic EVAL the limiter uses ─────
// The real limiter runs ONE Lua script: INCR + (PEXPIRE on first hit) + PTTL,
// returning [count, pttlMs]. The fake reproduces that atomic behavior, tracking
// a per-key TTL so tests can assert accurate Retry-After AND prove the key can
// never be left without an expiry (the permanent-lockout regression).
function makeFakeRedis(opts: { pttlMs?: number } = {}): RateLimitRedis & {
  counts: Map<string, number>
  ttls: Map<string, number>
  evalCalls: number
} {
  const counts = new Map<string, number>()
  const ttls = new Map<string, number>()
  // The PTTL the fake reports once a key is armed. Defaults to the window so the
  // first-hit reset reflects (close to) the full window; overridable per test to
  // assert that the middleware echoes the ACTUAL live PTTL, not a constant.
  const reportedPttl = opts.pttlMs
  const redis = {
    counts,
    ttls,
    evalCalls: 0,
    async eval(_script: string, _numKeys: number, ...args: (string | number)[]) {
      redis.evalCalls += 1
      const key = String(args[0])
      const windowMs = Number(args[1])
      const next = (counts.get(key) ?? 0) + 1
      counts.set(key, next)
      if (next === 1) {
        ttls.set(key, reportedPttl ?? windowMs)
      }
      const pttl = ttls.get(key) ?? -1
      return [next, pttl]
    },
  }
  return redis
}

// A Redis whose eval always rejects — exercises the transient-failure path.
function makeThrowingRedis(): RateLimitRedis {
  return {
    async eval() {
      throw new Error('redis down')
    },
  }
}

type Env = { Variables: Record<string, never> }

function makeApp(
  middleware: ReturnType<typeof createRateLimiter>,
  path = '/api/auth/*',
  mount = '/api/auth/sign-in',
) {
  const app = new Hono<Env>()
  app.use(path, middleware)
  app.post(mount, (c) => c.json({ ok: true }))
  app.get(mount, (c) => c.json({ ok: true }))
  return app
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

describe('createRateLimiter', () => {
  beforeEach(() => {
    rateLimitHitsTotal.reset()
  })

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV
    vi.restoreAllMocks()
  })

  describe('(a) allows requests under the limit', () => {
    it('passes the first N requests where N === limit', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 3,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      for (let i = 0; i < 3; i += 1) {
        const res = await app.request('/api/auth/sign-in', { method: 'POST' })
        expect(res.status).toBe(200)
      }
    })

    it('sets X-RateLimit headers on allowed responses', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      const res = await app.request('/api/auth/sign-in', { method: 'POST' })
      expect(res.status).toBe(200)
      expect(res.headers.get('X-RateLimit-Limit')).toBe('5')
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('4')
      expect(res.headers.get('X-RateLimit-Reset')).not.toBeNull()
    })

    it('X-RateLimit-Reset reflects the ACTUAL live PTTL, not a constant window', async () => {
      // Redis reports 12_345ms remaining on this window → reset should be ceil(12.345s) = 13s.
      const redis = makeFakeRedis({ pttlMs: 12_345 })
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      const res = await app.request('/api/auth/sign-in', { method: 'POST' })
      expect(res.headers.get('X-RateLimit-Reset')).toBe('13')
    })

    it('arms the window TTL atomically inside a single EVAL roundtrip', async () => {
      const redis = makeFakeRedis()
      const evalSpy = vi.spyOn(redis, 'eval')
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', { method: 'POST' })
      await app.request('/api/auth/sign-in', { method: 'POST' })

      // One EVAL per request — no separate INCR/PEXPIRE roundtrips.
      expect(evalSpy).toHaveBeenCalledTimes(2)
      expect(evalSpy).toHaveBeenCalledWith(
        expect.any(String),
        1,
        expect.stringContaining('rl:auth:'),
        '60000',
      )
      // The key is armed with a TTL on the first hit.
      expect(redis.ttls.get('rl:auth:1.2.3.4')).toBe(60_000)
    })
  })

  describe('(b) blocks the (limit+1)th request', () => {
    it('returns 429 with accurate Retry-After and rate_limited error body', async () => {
      // Window reports 30s remaining when the block happens.
      const redis = makeFakeRedis({ pttlMs: 30_000 })
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 2,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', { method: 'POST' })
      await app.request('/api/auth/sign-in', { method: 'POST' })
      const res = await app.request('/api/auth/sign-in', { method: 'POST' })

      expect(res.status).toBe(429)
      // Retry-After is the REAL remaining window (ceil(30s)), not a constant 60.
      expect(res.headers.get('Retry-After')).toBe('30')
      expect(res.headers.get('X-RateLimit-Reset')).toBe('30')
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
      const body = await res.json()
      expect(body.error.type).toBe('rate_limited')
      expect(typeof body.error.message).toBe('string')
    })

    it('increments rate_limit_hits_total for the tier on rejection', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 1,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', { method: 'POST' })
      await app.request('/api/auth/sign-in', { method: 'POST' })

      const metric = await rateLimitHitsTotal.get()
      const authSample = metric.values.find((v) => v.labels.tier === 'auth')
      expect(authSample?.value).toBe(1)
    })

    it('does NOT increment the metric while under the limit', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', { method: 'POST' })

      const metric = await rateLimitHitsTotal.get()
      const authSample = metric.values.find((v) => v.labels.tier === 'auth')
      expect(authSample?.value ?? 0).toBe(0)
    })
  })

  describe('(c) separate clients have independent windows', () => {
    it('keys per IP so one client cannot exhaust another', async () => {
      const redis = makeFakeRedis()
      let ip = '10.0.0.1'
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 1,
        windowMs: 60_000,
        getClientIp: () => ip,
      })
      const app = makeApp(limiter)

      // Client A exhausts its window
      expect((await app.request('/api/auth/sign-in', { method: 'POST' })).status).toBe(200)
      expect((await app.request('/api/auth/sign-in', { method: 'POST' })).status).toBe(429)

      // Client B (different IP) is unaffected
      ip = '10.0.0.2'
      expect((await app.request('/api/auth/sign-in', { method: 'POST' })).status).toBe(200)
    })
  })

  describe('(d) auth vs api tiers have independent counters/limits', () => {
    it('uses tier-namespaced keys so tiers do not collide', async () => {
      const redis = makeFakeRedis()
      const authLimiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 1,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const apiLimiter = createRateLimiter({
        redis,
        tier: 'api',
        limit: 5,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })

      const app = new Hono<Env>()
      app.use('/api/auth/*', authLimiter)
      app.use('/v1/*', apiLimiter)
      app.post('/api/auth/sign-in', (c) => c.json({ ok: true }))
      app.get('/v1/thing', (c) => c.json({ ok: true }))

      // Exhaust the tight auth tier
      expect((await app.request('/api/auth/sign-in', { method: 'POST' })).status).toBe(200)
      expect((await app.request('/api/auth/sign-in', { method: 'POST' })).status).toBe(429)

      // The looser api tier for the SAME IP is unaffected (separate counter)
      expect((await app.request('/v1/thing')).status).toBe(200)

      // Keys are namespaced by tier
      const keys = [...redis.counts.keys()]
      expect(keys.some((k) => k.startsWith('rl:auth:'))).toBe(true)
      expect(keys.some((k) => k.startsWith('rl:api:'))).toBe(true)
    })
  })

  describe('(e) transient Redis failure: fail-closed in prod, fail-open in dev', () => {
    it('auth tier fails CLOSED (rejects) in production AND counts the rejection', async () => {
      process.env.NODE_ENV = 'production'
      const limiter = createRateLimiter({
        redis: makeThrowingRedis(),
        tier: 'auth',
        limit: 10,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      const res = await app.request('/api/auth/sign-in', { method: 'POST' })
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).not.toBeNull()
      const body = await res.json()
      expect(body.error.type).toBe('rate_limited')

      // The outage rejection is observable on the metric (operators need this).
      const metric = await rateLimitHitsTotal.get()
      const authSample = metric.values.find((v) => v.labels.tier === 'auth')
      expect(authSample?.value).toBe(1)
    })

    it('auth tier fails OPEN (allows) in development', async () => {
      process.env.NODE_ENV = 'development'
      const limiter = createRateLimiter({
        redis: makeThrowingRedis(),
        tier: 'auth',
        limit: 10,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      const res = await app.request('/api/auth/sign-in', { method: 'POST' })
      expect(res.status).toBe(200)
    })

    it('api tier fails OPEN even in production', async () => {
      process.env.NODE_ENV = 'production'
      const limiter = createRateLimiter({
        redis: makeThrowingRedis(),
        tier: 'api',
        limit: 100,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = new Hono<Env>()
      app.use('/v1/*', limiter)
      app.get('/v1/thing', (c) => c.json({ ok: true }))

      const res = await app.request('/v1/thing')
      expect(res.status).toBe(200)
    })
  })

  describe('(f) no Redis configured: pass-through no-op', () => {
    it('allows unlimited requests and logs a single startup warning', async () => {
      const warn = vi.fn()
      const limiter = createRateLimiter({
        redis: undefined,
        tier: 'auth',
        limit: 1,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
        logger: { warn, error: vi.fn() },
      })
      const app = makeApp(limiter)

      // Far exceeds the limit but never blocks
      for (let i = 0; i < 5; i += 1) {
        const res = await app.request('/api/auth/sign-in', { method: 'POST' })
        expect(res.status).toBe(200)
      }
      // Warning emitted exactly once at construction, not per-request
      expect(warn).toHaveBeenCalledTimes(1)
    })
  })

  describe('(g) keys on Fly-Client-IP when present', () => {
    it('prefers the Fly-Client-IP header over the conn-info fallback', async () => {
      const redis = makeFakeRedis()
      // getClientIp default uses the real resolver; here we let the middleware
      // read the header itself by NOT passing getClientIp.
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Fly-Client-IP': '203.0.113.7' },
      })

      const keys = [...redis.counts.keys()]
      expect(keys).toContain('rl:auth:203.0.113.7')
    })

    it('does NOT key on spoofable X-Forwarded-For', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', {
        method: 'POST',
        headers: {
          'Fly-Client-IP': '203.0.113.7',
          'X-Forwarded-For': '6.6.6.6',
        },
      })

      const keys = [...redis.counts.keys()]
      expect(keys).toContain('rl:auth:203.0.113.7')
      expect(keys.some((k) => k.includes('6.6.6.6'))).toBe(false)
    })

    it('falls back to "unknown" when no Fly-Client-IP and no resolvable socket', async () => {
      // The real defaultGetClientIp runs: no Fly-Client-IP header is set, and in
      // Vitest's Web-Fetch context getConnInfo cannot read a Node socket, so it
      // degrades to FALLBACK_CLIENT_IP. Lock in that documented behavior.
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 5,
        windowMs: 60_000,
        // No getClientIp override → exercises the real resolver + fallback path.
      })
      const app = makeApp(limiter)

      const res = await app.request('/api/auth/sign-in', { method: 'POST' })
      expect(res.status).toBe(200)

      const keys = [...redis.counts.keys()]
      expect(keys).toContain('rl:auth:unknown')
    })
  })

  describe('skips OPTIONS preflight', () => {
    it('does not count OPTIONS requests against the limit', async () => {
      const redis = makeFakeRedis()
      const evalSpy = vi.spyOn(redis, 'eval')
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 1,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = new Hono<Env>()
      app.use('/api/auth/*', limiter)
      app.on('OPTIONS', '/api/auth/sign-in', (c) => c.body(null, 204))

      const res = await app.request('/api/auth/sign-in', { method: 'OPTIONS' })
      expect(res.status).toBe(204)
      expect(evalSpy).not.toHaveBeenCalled()
    })
  })

  describe('regression: permanent-lockout bug is structurally eliminated', () => {
    it('every counted request carries a TTL — a key can never increment without expiry', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 3,
        windowMs: 60_000,
        getClientIp: () => '1.2.3.4',
      })
      const app = makeApp(limiter)

      const key = 'rl:auth:1.2.3.4'
      // Drive several requests across the limit boundary.
      for (let i = 0; i < 6; i += 1) {
        await app.request('/api/auth/sign-in', { method: 'POST' })
        // Invariant: as soon as the key exists (count >= 1), it has a TTL.
        // The old non-atomic INCR-then-PEXPIRE could leave the key with a count
        // but no TTL → permanent lockout. The atomic EVAL makes that impossible.
        expect(redis.counts.get(key)).toBe(i + 1)
        expect(redis.ttls.get(key)).toBe(60_000)
      }
    })

    it('a key is never left incremented-without-TTL after the first hit', async () => {
      const redis = makeFakeRedis()
      const limiter = createRateLimiter({
        redis,
        tier: 'auth',
        limit: 1,
        windowMs: 60_000,
        getClientIp: () => '9.9.9.9',
      })
      const app = makeApp(limiter)

      await app.request('/api/auth/sign-in', { method: 'POST' }) // count=1, armed
      await app.request('/api/auth/sign-in', { method: 'POST' }) // count=2, blocked

      const key = 'rl:auth:9.9.9.9'
      expect(redis.counts.get(key)).toBe(2)
      // Critically: the TTL is present and positive — the window WILL expire and
      // the client is NOT locked out forever.
      const ttl = redis.ttls.get(key)
      expect(ttl).toBeDefined()
      expect(ttl).toBeGreaterThan(0)
    })
  })
})
