// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { Hono } from 'hono'

export type HealthDeps = {
  dbProbe?: (() => Promise<void>) | undefined
  redisProbe?: (() => Promise<void>) | undefined
  /**
   * Whether the database is a required dependency. When true but no `dbProbe`
   * is wired (e.g. production running under the DB break-glass), readiness
   * reports the database as `missing` and returns 503 — the dependency is
   * expected, so its absence is a degraded state, not a healthy one.
   */
  expectDatabase?: boolean
  /** As `expectDatabase`, for Redis-backed rate limiting. */
  expectRedis?: boolean
}

type CheckState = 'ok' | 'error' | 'missing'

const startTime = Date.now()

export function createHealthRouter({
  dbProbe,
  redisProbe,
  expectDatabase = false,
  expectRedis = false,
}: HealthDeps = {}) {
  const router = new Hono()

  // Shallow liveness probe (no dependency calls)
  router.get('/', (c) => {
    return c.json({
      status: 'ok',
      version: process.env.npm_package_version ?? '0.0.1',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    })
  })

  // Deep readiness probe
  router.get('/ready', async (c) => {
    const checks: Record<string, CheckState> = {
      server: 'ok',
    }

    // A wired probe is authoritative. When a dependency is expected but no probe
    // exists, mark it `missing` so an unconfigured/break-glass deploy is visibly
    // degraded rather than reporting a false "ok".
    if (dbProbe) {
      try {
        await dbProbe()
        checks.database = 'ok'
      } catch {
        checks.database = 'error'
      }
    } else if (expectDatabase) {
      checks.database = 'missing'
    }

    if (redisProbe) {
      try {
        await redisProbe()
        checks.redis = 'ok'
      } catch {
        checks.redis = 'error'
      }
    } else if (expectRedis) {
      checks.redis = 'missing'
    }

    const hasErrors = Object.values(checks).some((v) => v !== 'ok')
    const status = hasErrors ? 'degraded' : 'ok'
    const statusCode = hasErrors ? 503 : 200

    return c.json({ status, checks }, statusCode)
  })

  return router
}
