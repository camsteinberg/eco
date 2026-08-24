// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { createMetricsHandler } from '../metricsAuth.js'

const METRIC_BODY = 'metric_data 1'

function fakeRegister() {
  return {
    contentType: 'text/plain; version=0.0.4; charset=utf-8',
    metrics: async () => METRIC_BODY,
  }
}

/**
 * Mount the handler on a throwaway Hono app so we exercise the real
 * request/response path (header reads, status codes, body) without
 * standing up the whole gateway.
 */
function appWith(opts: Parameters<typeof createMetricsHandler>[0]) {
  const app = new Hono()
  app.get('/metrics', createMetricsHandler(opts))
  return app
}

describe('createMetricsHandler', () => {
  describe('token configured', () => {
    const token = 'super-secret-scrape-token'

    it('returns 200 + metrics body for a correct Bearer token', async () => {
      const register = fakeRegister()
      const app = appWith({ register, token, isProduction: true })

      const res = await app.request('/metrics', {
        headers: { Authorization: `Bearer ${token}` },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe(register.contentType)
      expect(await res.text()).toBe(METRIC_BODY)
    })

    it('returns 401 (no metrics body) for a wrong token, with WWW-Authenticate', async () => {
      const app = appWith({ register: fakeRegister(), token, isProduction: true })

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer not-the-right-token' },
      })

      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
      const body = await res.text()
      expect(body).not.toContain(METRIC_BODY)
      expect(JSON.parse(body)).toEqual({
        error: { message: 'Unauthorized', type: 'unauthorized' },
      })
    })

    it('returns 401 when the Authorization header is missing', async () => {
      const app = appWith({ register: fakeRegister(), token, isProduction: true })

      const res = await app.request('/metrics')

      expect(res.status).toBe(401)
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer')
      expect(await res.text()).not.toContain(METRIC_BODY)
    })

    it('returns 401 for a malformed Authorization header (no Bearer scheme)', async () => {
      const app = appWith({ register: fakeRegister(), token, isProduction: true })

      const res = await app.request('/metrics', {
        headers: { Authorization: token },
      })

      expect(res.status).toBe(401)
      expect(await res.text()).not.toContain(METRIC_BODY)
    })

    it('compares with a timing-safe equal — a correct-prefix shorter token is rejected', async () => {
      // 'super-secret' is a length-mismatched prefix of the real token. A naive
      // startsWith/=== bug would behave differently; safeCompare hashes both
      // sides to a fixed-length digest, so a mismatched prefix still fails.
      const app = appWith({ register: fakeRegister(), token, isProduction: true })

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer super-secret' },
      })

      expect(res.status).toBe(401)
      expect(await res.text()).not.toContain(METRIC_BODY)
    })

    it('rejects an empty Bearer value', async () => {
      const app = appWith({ register: fakeRegister(), token, isProduction: true })

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer ' },
      })

      expect(res.status).toBe(401)
      expect(await res.text()).not.toContain(METRIC_BODY)
    })
  })

  describe('token unset', () => {
    it('returns 404 (no metrics body) in production — fail closed', async () => {
      const app = appWith({ register: fakeRegister(), token: '', isProduction: true })

      const res = await app.request('/metrics')

      expect(res.status).toBe(404)
      const body = await res.text()
      expect(body).not.toContain(METRIC_BODY)
      expect(JSON.parse(body)).toEqual({
        error: { message: 'Not found', type: 'not_found_error' },
      })
    })

    it('returns 200 + metrics body in non-production — open for local scraping', async () => {
      const register = fakeRegister()
      const app = appWith({ register, token: '', isProduction: false })

      const res = await app.request('/metrics')

      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe(register.contentType)
      expect(await res.text()).toBe(METRIC_BODY)
    })

    it('ignores any Authorization header when unconfigured in non-production', async () => {
      const register = fakeRegister()
      const app = appWith({ register, token: '', isProduction: false })

      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer whatever' },
      })

      expect(res.status).toBe(200)
      expect(await res.text()).toBe(METRIC_BODY)
    })
  })
})
