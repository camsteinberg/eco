// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { createAuthRouter } from '../routes/auth.js'

describe('Auth Router', () => {
  it('creates a router from a Better Auth instance', () => {
    const mockAuth = {
      handler: async (_req: Request) => new Response('OK', { status: 200 }),
    }
    const router = createAuthRouter(mockAuth as Parameters<typeof createAuthRouter>[0])
    expect(router).toBeDefined()
  })

  it('delegates requests to the auth handler', async () => {
    let receivedUrl = ''
    const mockAuth = {
      handler: async (req: Request) => {
        receivedUrl = req.url
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    }
    const router = createAuthRouter(mockAuth as Parameters<typeof createAuthRouter>[0])

    // The router is a Hono instance with a fetch method
    expect(typeof router.fetch).toBe('function')

    // Make a request through the router
    const res = await router.request('/sign-in', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(receivedUrl).toContain('/sign-in')
  })

  it('forwards GET requests to the auth handler', async () => {
    let receivedMethod = ''
    const mockAuth = {
      handler: async (req: Request) => {
        receivedMethod = req.method
        return new Response('session', { status: 200 })
      },
    }
    const router = createAuthRouter(mockAuth as Parameters<typeof createAuthRouter>[0])

    const res = await router.request('/session', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(receivedMethod).toBe('GET')
  })

  it('returns the response from the auth handler unchanged', async () => {
    const mockAuth = {
      handler: async () =>
        new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    }
    const router = createAuthRouter(mockAuth as Parameters<typeof createAuthRouter>[0])

    const res = await router.request('/protected', { method: 'GET' })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'unauthorized' })
  })
})
