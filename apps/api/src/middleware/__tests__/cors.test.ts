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

describe('CORS middleware', () => {
  const allowedOrigin = 'http://localhost:3000' // default WEB_URL

  describe('preflight (OPTIONS) requests', () => {
    it('returns CORS headers for allowed origin on /v1/* routes', async () => {
      const res = await app.request('/v1/models', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': 'GET',
        },
      })

      expect(res.status).toBeLessThan(400)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowedOrigin)
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    })

    it('returns exposed rate-limit headers in Access-Control-Expose-Headers', async () => {
      const res = await app.request('/v1/models', {
        method: 'OPTIONS',
        headers: {
          Origin: allowedOrigin,
          'Access-Control-Request-Method': 'GET',
        },
      })

      const exposed = res.headers.get('Access-Control-Expose-Headers') ?? ''
      expect(exposed).toContain('X-RateLimit-Limit')
      expect(exposed).toContain('X-RateLimit-Remaining')
      expect(exposed).toContain('X-RateLimit-Reset')
    })
  })

  describe('simple requests', () => {
    it('sets Access-Control-Allow-Origin for allowed origin', async () => {
      const res = await app.request('/v1/models', {
        headers: { Origin: allowedOrigin },
      })

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(allowedOrigin)
    })

    it('does not set Access-Control-Allow-Origin for disallowed origin', async () => {
      const res = await app.request('/v1/models', {
        headers: { Origin: 'https://evil.example.com' },
      })

      // Hono cors middleware omits the header when origin is not allowed
      const acao = res.headers.get('Access-Control-Allow-Origin')
      expect(acao === null || acao !== 'https://evil.example.com').toBe(true)
    })
  })

  describe('non-API routes', () => {
    it('does not apply CORS headers to /health', async () => {
      const res = await app.request('/health', {
        headers: { Origin: allowedOrigin },
      })

      // /health is outside /v1/* so CORS middleware does not run
      const acao = res.headers.get('Access-Control-Allow-Origin')
      expect(acao).toBeNull()
    })

    it('does not apply CORS headers to /metrics', async () => {
      const res = await app.request('/metrics', {
        headers: { Origin: allowedOrigin },
      })

      const acao = res.headers.get('Access-Control-Allow-Origin')
      expect(acao).toBeNull()
    })
  })
})
