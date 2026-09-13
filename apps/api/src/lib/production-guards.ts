// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Production dependency gating.
//
// The API's job is auth + sessions. Auth and account routes require Postgres,
// and the public surface relies on Redis-backed rate limiting.
// Historically a production deploy with `DATABASE_URL` or `REDIS_URL` unset would
// boot "healthy" while silently serving an auth-less or unlimited API — the kind
// of quiet misconfiguration that only shows up once users hit it. This module
// makes those dependencies fail CLOSED in production: a missing required
// dependency throws at boot (the server never becomes live, so Fly keeps the
// previous release and the deploy fails safely), unless an operator deliberately
// sets a loud, specific break-glass env var to run degraded on purpose.
//
// The function is pure (env in → policy out, or throw) so the boot gate is
// unit-testable without standing up a server.

export type DependencyEnv = {
  NODE_ENV?: string | undefined
  DATABASE_URL?: string | undefined
  REDIS_URL?: string | undefined
  API_PROXY_SECRET?: string | undefined
  ECO_ALLOW_PROD_WITHOUT_DATABASE?: string | undefined
  ECO_ALLOW_UNLIMITED_RATE_LIMITING?: string | undefined
  ECO_ALLOW_SHARED_RATE_BUCKET?: string | undefined
  // Index signature so `process.env` (NodeJS.ProcessEnv) is assignable. The named
  // keys above stay for documentation + autocomplete of what this reads.
  [key: string]: string | undefined
}

export type DependencyWarning = {
  level: 'warn' | 'error'
  msg: string
  meta?: Record<string, unknown>
}

export type DependencyPolicy = {
  isProduction: boolean
  /** A usable DATABASE_URL is present. */
  databaseConfigured: boolean
  /** A usable REDIS_URL is present. */
  redisConfigured: boolean
  /**
   * A usable API_PROXY_SECRET is present. Without it the API cannot trust the
   * web proxy's `X-Eco-Client-IP`, so every browser behind the web host is rate
   * limited as one client.
   */
  proxySecretConfigured: boolean
  /**
   * Whether the readiness probe should treat the database as a required
   * dependency. True in production even when running under break-glass, so
   * `/health/ready` visibly reports the missing dependency as degraded.
   */
  expectDatabase: boolean
  /** As `expectDatabase`, for Redis-backed rate limiting. */
  expectRedis: boolean
  /** As `expectDatabase`, for the trusted client-IP shared secret. */
  expectProxySecret: boolean
  /** Boot-time log lines the caller should emit (break-glass + misconfig notices). */
  warnings: DependencyWarning[]
}

/** Thrown at boot when a required production dependency is missing without break-glass. */
export class ProductionDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductionDependencyError'
  }
}

// Break-glass flags must be exactly "true" — explicit and unambiguous, so a
// stray "1"/"yes"/"false" can never accidentally disable a production control.
function isBreakGlassEnabled(value: string | undefined): boolean {
  return value === 'true'
}

export function resolveDependencyPolicy(env: DependencyEnv): DependencyPolicy {
  const isProduction = env.NODE_ENV === 'production'
  const databaseConfigured = Boolean(env.DATABASE_URL)
  const redisConfigured = Boolean(env.REDIS_URL)
  const proxySecretConfigured = Boolean(env.API_PROXY_SECRET)
  const warnings: DependencyWarning[] = []

  // 3.1 — Required production database.
  if (isProduction && !databaseConfigured) {
    if (!isBreakGlassEnabled(env.ECO_ALLOW_PROD_WITHOUT_DATABASE)) {
      throw new ProductionDependencyError(
        'DATABASE_URL is required in production — auth and account routes depend on it. ' +
          'Set DATABASE_URL, or set ECO_ALLOW_PROD_WITHOUT_DATABASE=true to deliberately deploy a degraded, auth-less API.',
      )
    }
    warnings.push({
      level: 'error',
      msg:
        'BREAK-GLASS: running in production WITHOUT a database (ECO_ALLOW_PROD_WITHOUT_DATABASE=true). ' +
        'Auth and account routes are NOT mounted; readiness will report the database as missing.',
    })
  }

  // 3.2 — Required production Redis for rate limiting.
  if (isProduction && !redisConfigured) {
    if (!isBreakGlassEnabled(env.ECO_ALLOW_UNLIMITED_RATE_LIMITING)) {
      throw new ProductionDependencyError(
        'REDIS_URL is required in production — it backs rate limiting on the auth and API surfaces. ' +
          'Set REDIS_URL, or set ECO_ALLOW_UNLIMITED_RATE_LIMITING=true to deliberately deploy without rate limiting.',
      )
    }
    warnings.push({
      level: 'error',
      msg:
        'BREAK-GLASS: running in production WITHOUT rate limiting (ECO_ALLOW_UNLIMITED_RATE_LIMITING=true). ' +
        'All routes pass through unlimited; readiness will report rate limiting as missing.',
    })
  }

  // 3.3 — Required production proxy secret. The auth rate limiter keys on the
  // client IP; without this shared secret the API cannot trust the web proxy's
  // `X-Eco-Client-IP` and falls back to the web host's egress address, so every
  // user behind it shares a single auth rate-limit bucket — one attacker can
  // lock everyone out, and a distributed attacker is only limited in aggregate.
  if (isProduction && !proxySecretConfigured) {
    if (!isBreakGlassEnabled(env.ECO_ALLOW_SHARED_RATE_BUCKET)) {
      throw new ProductionDependencyError(
        'API_PROXY_SECRET is required in production — without it the rate limiter cannot identify the real client and every user behind the web host shares one bucket. ' +
          'Set API_PROXY_SECRET (the same value in the web app), or set ECO_ALLOW_SHARED_RATE_BUCKET=true to deliberately deploy with a shared rate bucket.',
      )
    }
    warnings.push({
      level: 'error',
      msg:
        'BREAK-GLASS: running in production WITHOUT the trusted client-IP secret (ECO_ALLOW_SHARED_RATE_BUCKET=true): ' +
        'every user behind the web host shares one rate bucket; readiness will report the proxy secret as missing.',
    })
  }

  return {
    isProduction,
    databaseConfigured,
    redisConfigured,
    proxySecretConfigured,
    // In production we always expect every required dependency, so readiness
    // flags an absence even under break-glass.
    expectDatabase: isProduction,
    expectRedis: isProduction,
    expectProxySecret: isProduction,
    warnings,
  }
}
