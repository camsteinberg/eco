// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { matchedRoutes } from 'hono/route'
import { routeLabelFromMatchedRoutes } from '../lib/metrics.js'

/**
 * Tests that the metrics middleware uses the matched route pattern — not the
 * raw request path — as the label, preventing unbounded cardinality from unique
 * 404 paths. Exercises the REAL `routeLabelFromMatchedRoutes` helper (the same
 * one index.ts uses) inside a minimal Hono app.
 */
describe('Prometheus path-label cardinality', () => {
  function createTestApp() {
    const labels: { method: string; path: string; status: string }[] = []

    const app = new Hono()

    app.use('*', async (c, next) => {
      await next()

      labels.push({
        method: c.req.method,
        path: routeLabelFromMatchedRoutes(matchedRoutes(c)),
        status: String(c.res.status),
      })
    })

    // Register some routes with patterns
    app.get('/v1/auth/profile', (c) => c.json({ ok: true }))
    app.get('/v1/billing/checkout', (c) => c.json({ ok: true }))
    app.get('/health', (c) => c.json({ status: 'ok' }))

    app.notFound((c) => c.json({ error: 'Not found' }, 404))

    return { app, labels }
  }

  it('uses the route pattern, not the raw path, for matched routes', async () => {
    const { app, labels } = createTestApp()

    await app.request('/v1/auth/profile')

    expect(labels).toHaveLength(1)
    expect(labels[0].path).toBe('/v1/auth/profile')
  })

  it('labels unmatched routes (404s) as "unmatched"', async () => {
    const { app, labels } = createTestApp()

    await app.request('/some/random/path/12345')

    expect(labels).toHaveLength(1)
    expect(labels[0].path).toBe('unmatched')
  })

  it('different 404 paths all produce the same "unmatched" label', async () => {
    const { app, labels } = createTestApp()

    await app.request('/random/path/1')
    await app.request('/random/path/2')
    await app.request('/totally/different')

    expect(labels).toHaveLength(3)
    const uniquePaths = new Set(labels.map((l) => l.path))
    expect(uniquePaths.size).toBe(1)
    expect(uniquePaths.has('unmatched')).toBe(true)
  })
})
