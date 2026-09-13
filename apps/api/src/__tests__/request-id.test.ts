// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'

// Stub heavy side-effect modules before importing the app
vi.mock('../lib/logger.js', () => ({
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

vi.mock('../lib/metrics.js', () => ({
  register: { contentType: 'text/plain', metrics: async () => '' },
  httpRequestsTotal: { inc: vi.fn() },
  httpRequestDuration: { observe: vi.fn() },
  routeLabelFromMatchedRoutes: () => '/health',
}))

import app from '../index.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function requestIdFor(header?: string) {
  const res = await app.request(
    '/health',
    header === undefined ? {} : { headers: { 'x-request-id': header } },
  )
  return res.headers.get('X-Request-Id')
}

describe('X-Request-Id handling', () => {
  it('generates a UUID when the client sends none', async () => {
    expect(await requestIdFor()).toMatch(UUID)
  })

  it('echoes a well-formed client id', async () => {
    const id = 'req_abc-123.XYZ'
    expect(await requestIdFor(id)).toBe(id)
  })

  it('replaces a header carrying whitespace, quotes, markup or separators', async () => {
    // The id is echoed into a response header and into every log line for the
    // request, so it is attacker-controlled text on two sinks. (CRLF is not
    // exercised here: the HTTP parser rejects such a header before any
    // handler sees it, so it cannot be constructed through `app.request`.)
    for (const hostile of ['a b', '<script>', '"quoted"', 'a;b', 'a/b', 'id\u00e9']) {
      expect(await requestIdFor(hostile)).toMatch(UUID)
    }
  })

  it('replaces an over-long header (128 characters is the ceiling)', async () => {
    expect(await requestIdFor('a'.repeat(128))).toBe('a'.repeat(128))
    expect(await requestIdFor('a'.repeat(129))).toMatch(UUID)
  })

  it('replaces an empty header', async () => {
    expect(await requestIdFor('')).toMatch(UUID)
  })
})
