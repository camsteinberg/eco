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
  ECO_ALLOW_PROD_WITHOUT_DATABASE?: string | undefined
  ECO_ALLOW_UNLIMITED_RATE_LIMITING?: string | undefined
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
   * Whether the readiness probe should treat the database as a required
   * dependency. True in production even when running under break-glass, so
   * `/health/ready` visibly reports the missing dependency as degraded.
   */
  expectDatabase: boolean
  /** As `expectDatabase`, for Redis-backed rate limiting. */
  expectRedis: boolean
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

  return {
    isProduction,
    databaseConfigured,
    redisConfigured,
    // In production we always expect both backing services, so readiness flags
    // their absence even under break-glass.
    expectDatabase: isProduction,
    expectRedis: isProduction,
    warnings,
  }
}
