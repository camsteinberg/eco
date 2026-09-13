// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Wiring test for the per-email sign-in lockout (finding F2). The lock CHECK
// happens in `hooks.before`, ahead of any database access, so a real sign-in
// request can be driven through `auth.handler` with a throwaway Db and the
// refusal asserted end-to-end. The counting itself is unit-tested in
// signin-lockout.test.ts.

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Db } from '../../db/index.js'
import type { LockoutRedis } from '../signin-lockout.js'

const EMAIL = 'person@example.com'
const PASSWORD = 'correct horse battery staple'

function createRedis(overrides: Partial<LockoutRedis> = {}): LockoutRedis {
  return {
    eval: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
    ...overrides,
  }
}

async function buildAuth(lockoutRedis?: LockoutRedis, db: unknown = {}) {
  const { createAuth } = await import('../index.js')
  // The drizzle adapter touches no database at construction time, and a locked
  // sign-in is refused before any adapter call.
  return createAuth(db as Db, { lockoutRedis })
}

/**
 * The smallest Db the drizzle adapter accepts for "no such user". Without
 * `experimental.joins` the adapter's `findOne` is
 * `db.select(...).from(...).where(...)` (@better-auth/drizzle-adapter 1.6.23,
 * dist/index.mjs:377-387), so an empty result array is enough to drive a real
 * failed sign-in all the way to its APIError.
 */
function emptyDb() {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  }
}

function signInRequest() {
  return new Request('http://localhost:3001/api/auth/sign-in/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
    },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
}

describe('sign-in lockout hook wiring', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('registers both hooks', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const auth = await buildAuth(createRedis())

    expect(auth.options.hooks?.before).toBeTypeOf('function')
    expect(auth.options.hooks?.after).toBeTypeOf('function')
  })

  it('refuses a locked email with 429 even when the password is right', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const redis = createRedis({ get: vi.fn(async () => '1') })
    const auth = await buildAuth(redis)

    const res = await auth.handler(signInRequest())

    expect(res.status).toBe(429)
    const body = (await res.json()) as unknown
    expect(JSON.stringify(body)).toContain('Too many sign-in attempts')
    // The refusal happened before the password was ever checked.
    expect(redis.get).toHaveBeenCalledOnce()
  })

  it('consults the lock on the normalised address, and lets an unlocked email through', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const redis = createRedis()
    const auth = await buildAuth(redis)

    const res = await auth.handler(signInRequest())

    expect(redis.get).toHaveBeenCalledOnce()
    // Whatever the throwaway Db does next, the lockout did not block it.
    expect(res.status).not.toBe(429)
    expect(res.status).not.toBe(503)
  })

  it('fails closed with 503 when the lock lookup cannot reach Redis', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const redis = createRedis({
      get: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    })
    const auth = await buildAuth(redis)

    const res = await auth.handler(signInRequest())

    expect(res.status).toBe(503)
    const body = (await res.json()) as unknown
    expect(JSON.stringify(body)).toContain('temporarily unavailable')
  })

  it('skips the lockout entirely when no Redis client is configured', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const auth = await buildAuth(undefined)

    const res = await auth.handler(signInRequest())

    expect(res.status).not.toBe(429)
    expect(res.status).not.toBe(503)
  })

  it('counts a genuinely failed sign-in through the after hook', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const redis = createRedis()
    const auth = await buildAuth(redis, emptyDb())

    const res = await auth.handler(signInRequest())

    // No such user: better-auth answers 401 INVALID_EMAIL_OR_PASSWORD, and the
    // after hook sees that APIError on `ctx.context.returned`.
    expect(res.status).toBe(401)
    expect(redis.eval).toHaveBeenCalledOnce()
    expect(redis.del).not.toHaveBeenCalled()
  })

  it('does not count a failure when no Redis client is configured', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const auth = await buildAuth(undefined, emptyDb())

    const res = await auth.handler(signInRequest())

    expect(res.status).toBe(401)
  })

  it('never puts the submitted address in a Redis key', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')
    const redis = createRedis()
    const auth = await buildAuth(redis)

    await auth.handler(signInRequest())

    const getMock = redis.get as ReturnType<typeof vi.fn>
    const key = String(getMock.mock.calls[0]?.[0])
    expect(key).toContain('auth:lock:')
    expect(key).not.toContain(EMAIL)
  })
})
