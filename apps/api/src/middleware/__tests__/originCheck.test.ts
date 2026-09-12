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

/** The `requireOrigin` variant, as `POST /v1/search` mounts it. */
function makeStrictApp(handler = vi.fn((c) => c.json({ ok: true }))) {
  const app = new Hono()
  app.use('/protected/*', createOriginCheck(ALLOWED, { requireOrigin: true }))
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

describe('createOriginCheck with requireOrigin', () => {
  it('rejects a state-changing request with NO Origin header (POST → 403, handler not reached)', async () => {
    const { app, handler } = makeStrictApp()
    const res = await app.request('/protected/data', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = await res.json()
    // Same error shape as the disallowed-Origin rejection: a caller cannot tell
    // which of the two rules it tripped, and the client has one path to handle.
    expect(body.error.code).toBe('forbidden')
    expect(body.error.message).toBe('Cross-origin request rejected')
    expect(handler).not.toHaveBeenCalled()
  })

  it('still allows an allowlisted Origin', async () => {
    const { app, handler } = makeStrictApp()
    const res = await app.request('/protected/data', {
      method: 'POST',
      headers: { Origin: 'https://econetwork.ai' },
    })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('still rejects a non-allowlisted Origin', async () => {
    const { app } = makeStrictApp()
    const res = await app.request('/protected/data', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  it('does not require an Origin on a safe method (GET with none → passes)', async () => {
    const { app, handler } = makeStrictApp()
    const res = await app.request('/protected/data', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('leaves the default (auth/feedback) instance passing an absent Origin', async () => {
    const { app, handler } = makeApp()
    const res = await app.request('/protected/data', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })
})
