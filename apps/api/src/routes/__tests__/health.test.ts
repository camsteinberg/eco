// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createHealthRouter } from '../health.js'

describe('createHealthRouter', () => {
  describe('GET / (shallow liveness)', () => {
    it('returns 200 with status ok', async () => {
      const app = new Hono()
      app.route('/health', createHealthRouter())

      const res = await app.request('/health')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.status).toBe('ok')
    })

    it('returns version string', async () => {
      const app = new Hono()
      app.route('/health', createHealthRouter())

      const res = await app.request('/health')
      const body = await res.json()
      expect(typeof body.version).toBe('string')
    })

    it('returns uptime as a non-negative number', async () => {
      const app = new Hono()
      app.route('/health', createHealthRouter())

      const res = await app.request('/health')
      const body = await res.json()
      expect(typeof body.uptime).toBe('number')
      expect(body.uptime).toBeGreaterThanOrEqual(0)
    })
  })

  describe('GET /ready (deep readiness)', () => {
    it('returns 200 when no probes are provided', async () => {
      const app = new Hono()
      app.route('/health', createHealthRouter())

      const res = await app.request('/health/ready')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.server).toBe('ok')
    })

    it('returns 200 when all probes succeed', async () => {
      const app = new Hono()
      app.route(
        '/health',
        createHealthRouter({
          dbProbe: async () => {},
          redisProbe: async () => {},
        }),
      )

      const res = await app.request('/health/ready')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.server).toBe('ok')
      expect(body.checks.database).toBe('ok')
      expect(body.checks.redis).toBe('ok')
    })

    it('returns 503 when DB probe fails', async () => {
      const app = new Hono()
      app.route(
        '/health',
        createHealthRouter({
          dbProbe: async () => {
            throw new Error('connection refused')
          },
          redisProbe: async () => {},
        }),
      )

      const res = await app.request('/health/ready')
      expect(res.status).toBe(503)

      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.checks.database).toBe('error')
      expect(body.checks.redis).toBe('ok')
    })

    it('returns 503 when Redis probe fails', async () => {
      const app = new Hono()
      app.route(
        '/health',
        createHealthRouter({
          dbProbe: async () => {},
          redisProbe: async () => {
            throw new Error('ECONNREFUSED')
          },
        }),
      )

      const res = await app.request('/health/ready')
      expect(res.status).toBe(503)

      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.checks.redis).toBe('error')
      expect(body.checks.database).toBe('ok')
    })

    it('returns degraded status when both probes fail', async () => {
      const app = new Hono()
      app.route(
        '/health',
        createHealthRouter({
          dbProbe: async () => {
            throw new Error('db down')
          },
          redisProbe: async () => {
            throw new Error('redis down')
          },
        }),
      )

      const res = await app.request('/health/ready')
      expect(res.status).toBe(503)

      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.checks.database).toBe('error')
      expect(body.checks.redis).toBe('error')
      expect(body.checks.server).toBe('ok')
    })
  })

  describe('GET /ready with expected-but-missing dependencies (production fail-closed)', () => {
    it('reports the database missing and returns 503 when expected but no probe is wired (break-glass)', async () => {
      const app = new Hono()
      app.route('/health', createHealthRouter({ expectDatabase: true }))

      const res = await app.request('/health/ready')
      expect(res.status).toBe(503)

      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.checks.database).toBe('missing')
    })

    it('reports redis missing and returns 503 when expected but no probe is wired (break-glass)', async () => {
      const app = new Hono()
      app.route('/health', createHealthRouter({ expectRedis: true }))

      const res = await app.request('/health/ready')
      expect(res.status).toBe(503)

      const body = await res.json()
      expect(body.status).toBe('degraded')
      expect(body.checks.redis).toBe('missing')
    })

    it('uses the live probe when one is wired even if the dependency is also expected', async () => {
      const app = new Hono()
      app.route(
        '/health',
        createHealthRouter({
          expectDatabase: true,
          expectRedis: true,
          dbProbe: async () => {},
          redisProbe: async () => {},
        }),
      )

      const res = await app.request('/health/ready')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.checks.database).toBe('ok')
      expect(body.checks.redis).toBe('ok')
    })
  })
})
