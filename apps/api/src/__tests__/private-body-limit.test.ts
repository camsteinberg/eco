// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

/**
 * Tests that the 10 MB body limit on /v1/private/* routes works correctly.
 * We build a minimal Hono app with the same bodyLimit middleware used in index.ts
 * to avoid importing the full app (which has side effects and conditional imports).
 */
function createAppWithBodyLimit() {
  const app = new Hono()

  // Mirror the body limit from index.ts (lines 79-89)
  app.use(
    '/v1/private/*',
    bodyLimit({
      maxSize: 10 * 1024 * 1024, // 10 MB
      onError: (c) =>
        c.json(
          { error: { message: 'Request body too large', type: 'payload_too_large' } },
          413,
        ),
    }),
  )

  // Stub routes to handle requests that pass the body limit
  app.post('/v1/private/activations', async (c) => {
    // Consume body to trigger the limit check
    await c.req.json()
    return c.json({ ok: true })
  })

  app.post('/v1/private/session', async (c) => {
    await c.req.json()
    return c.json({ ok: true })
  })

  return app
}

function createAppWithAuthBodyLimit() {
  const app = new Hono()

  app.use(
    '/api/auth/*',
    bodyLimit({
      maxSize: 64 * 1024, // 64 KB
      onError: (c) =>
        c.json(
          { error: { message: 'Request body too large', type: 'payload_too_large' } },
          413,
        ),
    }),
  )

  app.post('/api/auth/sign-up/email', async (c) => {
    await c.req.json()
    return c.json({ ok: true })
  })

  return app
}

function createAppWithChatBodyLimit() {
  const app = new Hono()

  app.use(
    '/v1/chat/*',
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { message: 'Request body too large', type: 'payload_too_large' } },
          413,
        ),
    }),
  )

  app.post('/v1/chat/completions', async (c) => {
    await c.req.json()
    return c.json({ ok: true })
  })

  return app
}

describe('Private activations body limit', () => {
  it('rejects payloads larger than 10MB on /v1/private/activations', async () => {
    const app = createAppWithBodyLimit()

    const oversizedPayload = JSON.stringify({
      session_id: 'test-session',
      encrypted_activations: {
        ciphertext: 'x'.repeat(11 * 1024 * 1024), // >10MB
        nonce: 'test-nonce',
        ephemeral_public_key: 'test-key',
      },
      encoding: 'full',
      shape: [1, 1, 4096],
      token_index: 0,
    })

    const res = await app.request('/v1/private/activations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    })

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('payload_too_large')
  })

  it('accepts payloads under 10MB on /v1/private/activations', async () => {
    const app = createAppWithBodyLimit()

    const smallPayload = JSON.stringify({
      session_id: 'test-session',
      encrypted_activations: {
        ciphertext: 'small-data',
        nonce: 'test-nonce',
        ephemeral_public_key: 'test-key',
      },
      encoding: 'full',
      shape: [1, 1, 4096],
      token_index: 0,
    })

    const res = await app.request('/v1/private/activations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: smallPayload,
    })

    // Should NOT be 413 — passes body limit, hits the stub route
    expect(res.status).not.toBe(413)
  })

  it('rejects oversized payloads on /v1/private/session', async () => {
    const app = createAppWithBodyLimit()

    const oversizedPayload = JSON.stringify({
      model: 'x'.repeat(11 * 1024 * 1024),
    })

    const res = await app.request('/v1/private/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    })

    expect(res.status).toBe(413)
  })
})

describe('Better Auth body limit', () => {
  it('rejects payloads larger than 64KB on /api/auth/*', async () => {
    const app = createAppWithAuthBodyLimit()

    const oversizedPayload = JSON.stringify({
      email: 'x'.repeat(65 * 1024),
      password: 'test',
    })

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    })

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('payload_too_large')
  })

  it('accepts payloads under 64KB on /api/auth/*', async () => {
    const app = createAppWithAuthBodyLimit()

    const smallPayload = JSON.stringify({
      email: 'test@example.com',
      password: 'password123',
    })

    const res = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: smallPayload,
    })

    expect(res.status).not.toBe(413)
  })
})

describe('Chat body limit', () => {
  it('rejects chat payloads larger than 1MB before route handling', async () => {
    const app = createAppWithChatBodyLimit()

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'tinyllama-1.1b-q4_k_m',
        messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024 + 1) }],
      }),
    })

    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: { type: string } }
    expect(body.error.type).toBe('payload_too_large')
  })
})
