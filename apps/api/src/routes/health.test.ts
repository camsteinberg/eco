// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import app from '../index.js'
import { createHealthRouter } from './health.js'

describe('GET /health', () => {
  it('returns 200', async () => {
    const res = await app.request('/health')
    expect(res.status).toBe(200)
  })

  it('returns status ok', async () => {
    const res = await app.request('/health')
    const body = await res.json()
    expect(body.status).toBe('ok')
  })

  it('returns version string', async () => {
    const res = await app.request('/health')
    const body = await res.json()
    expect(typeof body.version).toBe('string')
  })

  it('returns uptime as a number', async () => {
    const res = await app.request('/health')
    const body = await res.json()
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })
})

describe('GET /health/ready (deploy health check)', () => {
  const ok = async () => {}
  const boom = async () => {
    throw new Error('down')
  }

  it('is 200 only when every wired dependency answers', async () => {
    const router = createHealthRouter({ dbProbe: ok, redisProbe: ok })
    const res = await router.request('/ready')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'ok',
      checks: { server: 'ok', database: 'ok', redis: 'ok' },
    })
  })

  it('is 503 when a dependency probe fails', async () => {
    const router = createHealthRouter({ dbProbe: boom, redisProbe: ok })
    const res = await router.request('/ready')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('degraded')
    expect(body.checks.database).toBe('error')
  })

  it('is 503 when production expects a dependency that is not wired', async () => {
    const router = createHealthRouter({ expectDatabase: true, expectRedis: true })
    const res = await router.request('/ready')
    expect(res.status).toBe(503)
    expect((await res.json()).checks).toEqual({
      server: 'ok',
      database: 'missing',
      redis: 'missing',
    })
  })
})
