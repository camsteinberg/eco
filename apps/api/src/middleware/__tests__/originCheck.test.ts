// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createOriginCheck } from '../originCheck.js'

const ALLOWED = ['https://econetwork.ai', 'http://localhost:3000']

function makeApp(handler = vi.fn((c) => c.json({ ok: true }))) {
  const app = new Hono()
  app.use('/protected/*', createOriginCheck(ALLOWED))
  app.get('/protected/data', handler)
  app.patch('/protected/data', handler)
  app.post('/protected/data', handler)
  app.delete('/protected/data', handler)
  app.options('/protected/data', handler)
  return { app, handler }
}

describe('createOriginCheck', () => {
  it('lets a state-changing request with an allowlisted Origin through (PATCH → calls next)', async () => {
    const { app, handler } = makeApp()
    const res = await app.request('/protected/data', {
      method: 'PATCH',
      headers: { Origin: 'https://econetwork.ai' },
    })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rejects a state-changing request with a non-allowlisted Origin (DELETE → 403, handler not reached)', async () => {
    const { app, handler } = makeApp()
    const res = await app.request('/protected/data', {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('forbidden')
    expect(body.error.message).toBe('Cross-origin request rejected')
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets a state-changing request with NO Origin header through (POST → calls next)', async () => {
    const { app, handler } = makeApp()
    const res = await app.request('/protected/data', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('skips the Origin check on a non-state-changing method even with a bad Origin (GET → passes)', async () => {
    const { app, handler } = makeApp()
    const res = await app.request('/protected/data', {
      method: 'GET',
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('skips the Origin check on OPTIONS preflight even with a bad Origin (OPTIONS → passes)', async () => {
    const { app, handler } = makeApp()
    const res = await app.request('/protected/data', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('accepts the production smoke Origin so a future allowlist change cannot silently break the deploy smoke', async () => {
    // production-auth-flow-smoke.sh sends Origin: $ECO_WEB_URL (= WEB_URL,
    // https://econetwork.ai in prod) on its PATCH/DELETE requests. The Origin
    // check uses the same getAllowedWebOrigins() allowlist, so it must pass.
    const { app, handler } = makeApp()
    const patchRes = await app.request('/protected/data', {
      method: 'PATCH',
      headers: { Origin: 'https://econetwork.ai' },
    })
    expect(patchRes.status).toBe(200)
    const deleteRes = await app.request('/protected/data', {
      method: 'DELETE',
      headers: { Origin: 'https://econetwork.ai' },
    })
    expect(deleteRes.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(2)
  })
})
