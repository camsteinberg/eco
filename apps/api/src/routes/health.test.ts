// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import app from '../index.js'

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
