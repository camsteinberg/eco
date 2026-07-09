// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Db } from '../../db/index.js'

// Wiring test for the signup email policy hook (finding #1). The disposable
// rejection happens in `hooks.before` — BEFORE better-auth touches the database
// — so we can drive a real sign-up request through `auth.handler` with a
// throwaway Db (the drizzle adapter is never reached on the rejection path) and
// assert the request is refused end-to-end, not just that the pure predicate
// works. The happy path (which DOES hit the adapter) is covered by the
// exhaustive unit tests in signup-email-policy.test.ts.
describe('signup email policy hook wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function buildAuth() {
    const { createAuth } = await import('../index.js')
    // The drizzle adapter does not touch the database at construction time, and
    // a disposable signup is rejected before any adapter call.
    return createAuth({} as unknown as Db)
  }

  it('registers a before hook', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const auth = await buildAuth()
    expect(auth.options.hooks?.before).toBeTypeOf('function')
  })

  it('rejects a disposable-domain email sign-up before any DB access', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    vi.stubEnv('RESEND_API_KEY', '')

    const auth = await buildAuth()

    const res = await auth.handler(
      new Request('http://localhost:3001/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:3000',
        },
        body: JSON.stringify({
          name: 'Bot',
          email: 'bot@mailinator.com',
          password: 'supersecret123',
        }),
      }),
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as unknown
    // The APIError message surfaces in the response body regardless of the exact
    // envelope shape better-auth uses.
    expect(JSON.stringify(body).toLowerCase()).toContain('disposable')
  })
})
