// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { initSentry, Sentry } from './lib/sentry.js'
initSentry()

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { bodyLimit } from 'hono/body-limit'
import type { AuthUser } from './lib/types/auth.js'
import { createHealthRouter } from './routes/health.js'
import { logger } from './lib/logger.js'
import { register, httpRequestsTotal, httpRequestDuration, routeLabelFromMatchedRoutes } from './lib/metrics.js'
import { matchedRoutes } from 'hono/route'
import { docsRouter } from './routes/docs.js'
import { createOriginCheck } from './middleware/originCheck.js'
import { createMetricsHandler } from './middleware/metricsAuth.js'
import { createRateLimiter, type RateLimitRedis } from './middleware/rateLimit.js'
import { createAuthRouter } from './routes/auth.js'
import { createAuth } from './auth/index.js'
import { createDb, probeDatabase } from './db/index.js'
import { getAllowedWebOrigins } from './lib/auth-origins.js'
import { resolveDependencyPolicy } from './lib/production-guards.js'

// ── Simulated TEE production guard ──────────────────────────────────────────
if (
  process.env.NODE_ENV === 'production' &&
  (process.env.ECO_SIMULATE_TEE || process.env.ECO_SIMULATED_TEE)
) {
  throw new Error('Simulated TEE mode is not allowed in production')
}

// ── Production dependency gate (fail closed) ─────────────────────────────────
// Resolve required-dependency policy BEFORE wiring routes. In production a
// missing DATABASE_URL or REDIS_URL throws here (the server never boots, so the
// deploy fails safely and Fly keeps the previous release) unless an explicit
// break-glass env var is set. Outside production this is a no-op. Emitting the
// warnings up front means a break-glass deploy is loud in the logs from the
// first line.
const dependencyPolicy = resolveDependencyPolicy(process.env)
for (const warning of dependencyPolicy.warnings) {
  logger[warning.level](warning.meta ?? {}, warning.msg)
}

// Support multiple allowed origins via comma-separated WEB_URL
const ALLOWED_ORIGINS = getAllowedWebOrigins()

type AppEnv = {
  Variables: {
    logger: typeof logger
    user?: AuthUser
  }
}

const app = new Hono<AppEnv>()

// Body limit on auth and feedback routes (64 KB)
for (const routePattern of ['/v1/auth/*', '/api/auth/*', '/v1/feedback', '/v1/feedback/*']) {
  app.use(
    routePattern,
    bodyLimit({
      maxSize: 64 * 1024, // 64 KB
      onError: (c) =>
        c.json(
          { error: { message: 'Request body too large', type: 'payload_too_large' } },
          413,
        ),
    }),
  )
}

// CORS — whitelist the web frontend origin(s)
app.use(
  '/v1/*',
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }),
)

// CORS for Better Auth routes (cross-origin session cookies)
app.use(
  '/api/auth/*',
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST'],
  }),
)

// API documentation (Scalar UI + OpenAPI spec) is internal-only. The spec
// describes the full API surface — including legacy network/inference routes —
// so it must NOT be exposed publicly in production (it would contradict the
// on-device v1.0 story). Served in non-production by default; set
// ECO_ENABLE_API_DOCS=true to expose it on a production-like deploy.
const serveApiDocs =
  process.env.NODE_ENV !== 'production' ||
  process.env.ECO_ENABLE_API_DOCS === 'true'

// Relaxed CSP for /docs (Scalar loads JS/CSS from cdn.jsdelivr.net)
if (serveApiDocs) {
  app.use('/docs', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
    referrerPolicy: 'no-referrer',
  }))
}

// Security headers — HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
app.use(
  '*',
  secureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'none'"] },
    referrerPolicy: 'no-referrer',
  }),
)

// Prometheus metrics endpoint. Registered AFTER the global secure-headers
// middleware (so the response carries HSTS/X-Frame-Options/CSP — H2 fix) but
// BEFORE request logging (so scrapes stay out of the request log, preserving the
// original intent). Gated behind a bearer token: METRICS_TOKEN set → require
// `Authorization: Bearer <token>` (timing-safe compare); unset → open in dev,
// 404 (disabled, fail closed) in production. See SECURITY.md H2.
const METRICS_TOKEN = process.env.METRICS_TOKEN ?? ''
const IS_PRODUCTION = process.env.NODE_ENV === 'production'
if (METRICS_TOKEN === '' && IS_PRODUCTION) {
  logger.warn(
    'METRICS_TOKEN is not set — /metrics is disabled (404) in production. Set METRICS_TOKEN to enable authenticated Prometheus scraping.',
  )
}
app.get(
  '/metrics',
  createMetricsHandler({ register, token: METRICS_TOKEN, isProduction: IS_PRODUCTION }),
)

// Request logging middleware
app.use('*', async (c, next) => {
  const requestId =
    c.req.header('x-request-id') ?? randomUUID()
  c.header('X-Request-Id', requestId)

  const childLogger = logger.child({ requestId })
  c.set('logger', childLogger)

  const method = c.req.method
  const path = c.req.path
  childLogger.debug({ method, path }, 'Request start')

  const start = Date.now()
  await next()
  const durationMs = Date.now() - start

  // Metrics labels use the matched route pattern, never the raw path — unique
  // 404 paths would create unbounded label cardinality. Raw path stays in logs.
  const routeLabel = routeLabelFromMatchedRoutes(matchedRoutes(c))

  const status = String(c.res.status)
  httpRequestsTotal.inc({ method, path: routeLabel, status })
  httpRequestDuration.observe({ method, path: routeLabel, status }, durationMs / 1000)

  childLogger.info(
    { method, path, status: c.res.status, duration_ms: durationMs },
    'Request complete',
  )
})

// ── Health probes (conditional on backing services) ──────────────────────────
const dbProbe = process.env.DATABASE_URL
  ? async () => {
      await probeDatabase(process.env.DATABASE_URL)
    }
  : undefined

let redisProbe: (() => Promise<void>) | undefined

// A single Redis client backs BOTH the health readiness probe AND rate limiting.
// Create it once and share it — don't open two connections to the same Upstash.
let rateLimitRedis: RateLimitRedis | undefined
if (process.env.REDIS_URL) {
  const { createRedisClient } = await import('./lib/redis.js')
  const redis = createRedisClient()
  redisProbe = async () => { await redis.ping() }
  rateLimitRedis = redis
  logger.info('Redis client initialized for health probe + rate limiting')
}

// ── Rate limiting (Redis fixed-window) ───────────────────────────────────────
// Registered AFTER CORS (so OPTIONS preflight is short-circuited and never hits
// the limiter) and AFTER secure-headers + request logging (so a 429 still gets
// security headers and is logged), but BEFORE the route mounts below — Hono's
// `app.use(path, mw)` only applies to routes registered AFTER it. When REDIS_URL
// is unset the limiter is a no-op pass-through (keeps local dev + tests working).
// Limits/window are overridable via RATE_LIMIT_* env vars. Parse defensively: a
// typo (e.g. RATE_LIMIT_AUTH_MAX=abc) must NOT silently disable the control by
// yielding NaN (count > NaN is always false → unlimited). Fall back to the named
// default and log a loud warning so a misconfig is visible, not silent-open.
// `name` is for the log line only; the raw value is passed in directly (no
// dynamic process.env indexing) so call sites read the literal env var.
function parsePositiveIntEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { env: name, value: raw, fallback },
      'Invalid RATE_LIMIT_* env value — using default (rate limiting stays enforced)',
    )
    return fallback
  }
  return parsed
}

const RATE_LIMIT_WINDOW_MS = parsePositiveIntEnv('RATE_LIMIT_WINDOW_MS', process.env.RATE_LIMIT_WINDOW_MS, 60_000)
const RATE_LIMIT_AUTH_MAX = parsePositiveIntEnv('RATE_LIMIT_AUTH_MAX', process.env.RATE_LIMIT_AUTH_MAX, 10)
const RATE_LIMIT_API_MAX = parsePositiveIntEnv('RATE_LIMIT_API_MAX', process.env.RATE_LIMIT_API_MAX, 100)
const RATE_LIMIT_FEEDBACK_MAX = parsePositiveIntEnv('RATE_LIMIT_FEEDBACK_MAX', process.env.RATE_LIMIT_FEEDBACK_MAX, 5)

app.use(
  '/api/auth/*',
  createRateLimiter({
    redis: rateLimitRedis,
    tier: 'auth',
    limit: RATE_LIMIT_AUTH_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
    logger,
  }),
)
app.use(
  '/v1/*',
  createRateLimiter({
    redis: rateLimitRedis,
    tier: 'api',
    limit: RATE_LIMIT_API_MAX,
    windowMs: RATE_LIMIT_WINDOW_MS,
    logger,
  }),
)

app.route(
  '/health',
  createHealthRouter({
    dbProbe,
    redisProbe,
    expectDatabase: dependencyPolicy.expectDatabase,
    expectRedis: dependencyPolicy.expectRedis,
  }),
)

// API documentation — gated to non-production (see serveApiDocs above)
if (serveApiDocs) {
  app.route('/v1', docsRouter)   // serves /v1/openapi.json
  app.route('', docsRouter)      // serves /docs
}

// ── Better Auth routes ───────────────────────────────────────────────────────
if (process.env.DATABASE_URL) {
  const db = createDb()
  const auth = await createAuth(db)
  app.route('/api/auth', createAuthRouter(auth))
  logger.info('Better Auth routes mounted at /api/auth')

  // ── Session cookie verification ─────────────────────────────────────────
  // The web app authenticates via the Better Auth session cookie — the only
  // client is the browser. This guards the profile and account routes. The
  // former bearer-token (API-key) auth path was removed pre-launch
  // (security-review 2026-07-03, M4) to shrink authn to one well-understood path.
  const { createSessionCookieVerifier } = await import('./lib/verify-api-key.js')
  const verifySessionCookie = createSessionCookieVerifier(db)

  const { createAuthMiddleware: createAuthMw } = await import('./middleware/auth.js')
  const sessionAuth = createAuthMw(verifySessionCookie)

  // Explicit Origin allowlist on the mutating custom routes (CSRF
  // defense-in-depth on top of the session cookie's SameSite=Lax). Uses the
  // same ALLOWED_ORIGINS as CORS — so the prod deploy smoke's trusted Origin
  // (= WEB_URL) passes. Skips GET/HEAD/OPTIONS, so GET profile + preflight are
  // unaffected.
  const originCheck = createOriginCheck(ALLOWED_ORIGINS)

  // ── Profile management ──────────────────────────────────────────────────
  const { createProfileRouter } = await import('./routes/profile.js')
  app.use('/v1/auth/profile', originCheck)
  app.use('/v1/auth/profile', sessionAuth)
  app.route('/v1/auth/profile', createProfileRouter({ db }))
  logger.info('Profile route mounted at /v1/auth/profile')

  // ── Account deletion ────────────────────────────────────────────────────
  const { createAccountRouter } = await import('./routes/account.js')
  app.use('/v1/auth/account', originCheck)
  app.use('/v1/auth/account', sessionAuth)
  app.route('/v1/auth/account', createAccountRouter({ db }))
  logger.info('Account deletion route mounted at /v1/auth/account')

  // ── Feedback ────────────────────────────────────────────────────────────
  // Anonymous by design (chat needs no account, so auth-required feedback
  // would exclude most users). Defense stack: Origin allowlist + 64 KB body
  // limit (wired above) + the tight `feedback` rate-limit tier here on top of
  // the general `api` tier + field-length caps in the route itself.
  const { createFeedbackRouter } = await import('./routes/feedback.js')
  app.use('/v1/feedback', originCheck)
  app.use(
    '/v1/feedback',
    createRateLimiter({
      redis: rateLimitRedis,
      tier: 'feedback',
      limit: RATE_LIMIT_FEEDBACK_MAX,
      windowMs: RATE_LIMIT_WINDOW_MS,
      logger,
    }),
  )
  app.route('/v1/feedback', createFeedbackRouter({ db }))
  logger.info('Feedback route mounted at /v1/feedback')
}

app.onError((err, c) => {
  Sentry.captureException(err)
  const reqLogger = c.get('logger') ?? logger
  reqLogger.error({ err }, 'Unhandled error')
  return c.json({ error: { message: 'Internal server error', type: 'server_error' } }, 500)
})

app.notFound((c) => c.json({ error: { message: 'Not found', type: 'not_found_error' } }, 404))

// Only start server when run directly (not when imported for tests)
let server: ReturnType<typeof serve> | undefined

const isTestEnv = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'

// Fail-fast database connectivity gate. `migrate.js` runs before this process,
// but over the neon-http driver — it does not validate the runtime serverless
// (WebSocket pool) transport. Exercise the real runtime driver here so a broken
// database connection fails the boot: the machine never becomes healthy, Fly
// keeps the previous release serving, and the deploy fails safely instead of
// shifting traffic to an API that cannot reach its database. Retries absorb a
// transient blip during a deploy or restart.
if (!isTestEnv && process.env.DATABASE_URL) {
  const maxAttempts = 5
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await probeDatabase(process.env.DATABASE_URL)
      lastError = undefined
      break
    } catch (err) {
      lastError = err
      logger.warn({ attempt, maxAttempts }, 'Database connectivity probe failed; retrying')
      await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  if (lastError) {
    logger.fatal(
      { err: lastError },
      'Database unreachable after retries — exiting so the deploy fails safely',
    )
    Sentry.captureException(lastError)
    process.exit(1)
  }
  logger.info('Database connectivity verified (runtime driver)')
}

if (!isTestEnv) {
  const port = Number(process.env.PORT ?? 3001)
  server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
    logger.info({ port }, 'API server listening')
  })
}

// Graceful shutdown
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10)

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received')
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed')
      process.exit(0)
    })
    // Force shutdown after configured timeout
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS).unref()
  } else {
    process.exit(0)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app
