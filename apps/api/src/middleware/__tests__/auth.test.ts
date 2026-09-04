// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { createAuthMiddleware } from '../auth.js'
import type { AuthUser } from '../../lib/types/auth.js'

type Variables = { user: AuthUser }

function makeApp(verifyCookieFn: (cookieValue: string) => Promise<AuthUser | null>) {
  const app = new Hono<{ Variables: Variables }>()
  const middleware = createAuthMiddleware(verifyCookieFn)
  app.use('/protected/*', middleware)
  app.get('/protected/data', (c) => {
    const user = c.get('user')
    return c.json({ userId: user.id, email: user.email })
  })
  return app
}

describe('auth middleware (session-cookie only)', () => {
  const validUser: AuthUser = {
    id: 'user-123',
    email: 'test@eco.network',
    name: 'Test User',
  }

  it('authenticates via session cookie', async () => {
    const verifyCookie = vi.fn().mockResolvedValue(validUser)
    const app = makeApp(verifyCookie)
    const res = await app.request('/protected/data', {
      headers: { Cookie: 'better-auth.session_token=sess-abc-123' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.userId).toBe('user-123')
    expect(body.email).toBe('test@eco.network')
    expect(verifyCookie).toHaveBeenCalledWith('sess-abc-123')
  })

  it('reads the __Secure- prefixed cookie name', async () => {
    const verifyCookie = vi.fn().mockResolvedValue(validUser)
    const app = makeApp(verifyCookie)
    const res = await app.request('/protected/data', {
      headers: { Cookie: '__Secure-better-auth.session_token=secure-sess' },
    })
    expect(res.status).toBe(200)
    expect(verifyCookie).toHaveBeenCalledWith('secure-sess')
  })

  it('returns 401 when the session cookie is invalid', async () => {
    const verifyCookie = vi.fn().mockResolvedValue(null)
    const app = makeApp(verifyCookie)
    const res = await app.request('/protected/data', {
      headers: { Cookie: 'better-auth.session_token=expired-sess' },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
  })

  it('returns 401 when no session cookie is present', async () => {
    const verifyCookie = vi.fn().mockResolvedValue(null)
    const app = makeApp(verifyCookie)
    const res = await app.request('/protected/data')
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('unauthorized')
    // No cookie means the verifier is never consulted.
    expect(verifyCookie).not.toHaveBeenCalled()
  })

  it('ignores a Bearer token — the bearer auth path was removed', async () => {
    const verifyCookie = vi.fn().mockResolvedValue(validUser)
    const app = makeApp(verifyCookie)
    const res = await app.request('/protected/data', {
      headers: { Authorization: 'Bearer some-api-key' },
    })
    expect(res.status).toBe(401)
    // A bearer token must not authenticate: only the session cookie is honored.
    expect(verifyCookie).not.toHaveBeenCalled()
  })

  it('parses the session cookie from among multiple cookies', async () => {
    const verifyCookie = vi.fn().mockResolvedValue(validUser)
    const app = makeApp(verifyCookie)
    const res = await app.request('/protected/data', {
      headers: { Cookie: 'theme=dark; better-auth.session_token=sess-multi; locale=en' },
    })
    expect(res.status).toBe(200)
    expect(verifyCookie).toHaveBeenCalledWith('sess-multi')
  })
})
