// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Unit tests for the per-email lockout counter (finding F2). The wiring into
// the sign-in endpoint is covered separately in signin-lockout-hook.test.ts.

import { describe, it, expect, vi } from 'vitest'
import {
  clearSignInFailures,
  isLockedOut,
  normalizeEmail,
  recordSignInFailure,
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  MAX_FAILED_SIGNIN_ATTEMPTS,
  type LockoutRedis,
} from '../signin-lockout.js'

const EMAIL = 'person@example.com'

/**
 * A fake Redis that actually runs the lockout's semantics: INCR with a window,
 * and a lock key set once the threshold is reached. Enough to drive the counter
 * from one failure to a lock without a live server.
 */
function createFakeRedis() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number>()

  const redis: LockoutRedis & { store: Map<string, string>; ttls: Map<string, number> } = {
    store,
    ttls,
    eval: vi.fn(async (_script: string, numKeys: number, ...args: (string | number)[]) => {
      const [failKey, lockKey] = args.slice(0, numKeys).map(String)
      const [windowMs, threshold, lockMs] = args.slice(numKeys).map(Number)
      const next = Number(store.get(failKey!) ?? 0) + 1
      store.set(failKey!, String(next))
      if (next === 1) ttls.set(failKey!, windowMs!)
      if (next >= threshold!) {
        store.set(lockKey!, '1')
        ttls.set(lockKey!, lockMs!)
      }
      return next
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) {
        store.delete(key)
        ttls.delete(key)
      }
      return keys.length
    }),
  }

  return redis
}

describe('normalizeEmail', () => {
  it('lowercases and trims so one account has one counter', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com')
  })

  it('returns null for anything that is not a usable string', () => {
    expect(normalizeEmail(undefined)).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
    expect(normalizeEmail('   ')).toBeNull()
  })
})

describe('sign-in lockout counter', () => {
  it('does not lock below the threshold', async () => {
    const redis = createFakeRedis()

    for (let attempt = 1; attempt < MAX_FAILED_SIGNIN_ATTEMPTS; attempt += 1) {
      const result = await recordSignInFailure(redis, EMAIL)
      expect(result.failures).toBe(attempt)
      expect(result.locked).toBe(false)
    }

    expect(await isLockedOut(redis, EMAIL)).toBe(false)
  })

  it('locks on the tenth failure', async () => {
    const redis = createFakeRedis()

    let last = { failures: 0, locked: false }
    for (let attempt = 0; attempt < MAX_FAILED_SIGNIN_ATTEMPTS; attempt += 1) {
      last = await recordSignInFailure(redis, EMAIL)
    }

    expect(last).toEqual({ failures: MAX_FAILED_SIGNIN_ATTEMPTS, locked: true })
    expect(await isLockedOut(redis, EMAIL)).toBe(true)
  })

  it('arms a TTL on both keys, so a lock can never be permanent', async () => {
    const redis = createFakeRedis()

    for (let attempt = 0; attempt < MAX_FAILED_SIGNIN_ATTEMPTS; attempt += 1) {
      await recordSignInFailure(redis, EMAIL)
    }

    const ttlValues = [...redis.ttls.values()]
    expect(ttlValues).toContain(FAILURE_WINDOW_MS)
    expect(ttlValues).toContain(LOCKOUT_MS)
    expect(ttlValues.every((ttl) => ttl > 0)).toBe(true)
  })

  it('a successful sign-in clears both the counter and the lock', async () => {
    const redis = createFakeRedis()

    for (let attempt = 0; attempt < MAX_FAILED_SIGNIN_ATTEMPTS; attempt += 1) {
      await recordSignInFailure(redis, EMAIL)
    }
    expect(await isLockedOut(redis, EMAIL)).toBe(true)

    await clearSignInFailures(redis, EMAIL)

    expect(await isLockedOut(redis, EMAIL)).toBe(false)
    expect(redis.store.size).toBe(0)
  })

  it('counts case and whitespace variants of one address together', async () => {
    const redis = createFakeRedis()

    await recordSignInFailure(redis, normalizeEmail(' Person@Example.com ')!)
    const second = await recordSignInFailure(redis, normalizeEmail('PERSON@example.com')!)

    expect(second.failures).toBe(2)
  })

  it('keeps the address out of the Redis key', async () => {
    const redis = createFakeRedis()

    await recordSignInFailure(redis, EMAIL)

    const keys = [...redis.store.keys()]
    expect(keys.some((key) => key.includes(EMAIL))).toBe(false)
    expect(keys.some((key) => key.startsWith('auth:fail:'))).toBe(true)
  })

  it('separates two different addresses', async () => {
    const redis = createFakeRedis()

    await recordSignInFailure(redis, EMAIL)
    const other = await recordSignInFailure(redis, 'someone.else@example.com')

    expect(other.failures).toBe(1)
  })

  it('propagates a Redis failure so the caller can fail closed', async () => {
    const redis = createFakeRedis()
    redis.get.mockRejectedValueOnce(new Error('ECONNREFUSED'))

    await expect(isLockedOut(redis, EMAIL)).rejects.toThrow('ECONNREFUSED')
  })

  it('rejects an unrecognisable EVAL reply rather than counting garbage', async () => {
    const redis = createFakeRedis()
    redis.eval.mockResolvedValueOnce('not-a-number')

    await expect(recordSignInFailure(redis, EMAIL)).rejects.toThrow(/reply shape/)
  })
})
