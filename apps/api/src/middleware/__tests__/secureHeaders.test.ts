// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'

// Stub heavy side-effect modules before importing the app
vi.mock('../../lib/logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../lib/metrics.js', () => ({
  register: { contentType: 'text/plain', metrics: async () => '' },
  httpRequestsTotal: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
}))

import app from '../../index.js'

describe('secure headers middleware', () => {
  it('sets Strict-Transport-Security header', async () => {
    const res = await app.request('/health')

    const hsts = res.headers.get('Strict-Transport-Security')
    expect(hsts).toBeTruthy()
    expect(hsts).toContain('max-age=')
  })

  it('sets X-Frame-Options header', async () => {
    const res = await app.request('/health')

    const xfo = res.headers.get('X-Frame-Options')
    expect(xfo).toBeTruthy()
    expect(xfo).toBe('SAMEORIGIN')
  })

  it('sets X-Content-Type-Options to nosniff', async () => {
    const res = await app.request('/health')

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('sets Referrer-Policy to no-referrer', async () => {
    const res = await app.request('/health')

    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('sets Content-Security-Policy with default-src none', async () => {
    const res = await app.request('/health')

    const csp = res.headers.get('Content-Security-Policy')
    expect(csp).toBeTruthy()
    expect(csp).toContain("default-src 'none'")
  })

  it('applies security headers to /v1 routes as well', async () => {
    const res = await app.request('/v1/models')

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })

  it('applies security headers to /metrics', async () => {
    // /metrics is now registered AFTER the global secureHeaders middleware
    // (SECURITY.md H2), so the response carries the security headers. In the test
    // env METRICS_TOKEN is unset and NODE_ENV != production, so the route is open
    // (200) — exercising the header path.
    const res = await app.request('/metrics')

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=')
  })
})
