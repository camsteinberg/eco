// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// Per-email sign-in lockout.
//
// The only brake on password guessing was the per-IP `auth` rate-limit tier
// (10 requests a minute). That bounds one source, not one account: an attacker
// with a pool of addresses — or simply patience — can grind a single password
// indefinitely, a few tries per address per minute, and never trip it. This
// counts failures against the ACCOUNT instead, so the defence scales with the
// thing being attacked rather than with the attacker's address count.
//
// The counter is keyed on a hash of the email, never the address itself: Redis
// keys show up in `MONITOR`, `SLOWLOG` and keyspace dumps, and the set of email
// addresses that have recently failed to sign in is exactly the kind of list we
// should not be leaving lying around. A hash keeps the key deterministic for an
// operator who needs to check one account while keeping the table useless as a
// user list.
//
// Deliberately NOT a defence against a distributed attack on many accounts at
// once (that needs a global signal), and deliberately willing to lock a real
// user out for fifteen minutes: password reset is the escape hatch, and it does
// not go through this counter.

import { createHash } from 'node:crypto'

/**
 * Failures inside {@link FAILURE_WINDOW_MS} before an email is locked.
 * CHOSEN 2026-09-13 (auth security review), not measured.
 */
export const MAX_FAILED_SIGNIN_ATTEMPTS = 10

/**
 * How long failures accumulate. A slow grinder that stays under the threshold
 * across windows is bounded by the per-IP tier, not by this.
 * CHOSEN 2026-09-13 (auth security review), not measured.
 */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000

/**
 * How long a locked email stays locked.
 * CHOSEN 2026-09-13 (auth security review), not measured.
 */
export const LOCKOUT_MS = 15 * 60 * 1000

/**
 * The Redis surface the lockout needs. ioredis satisfies it; a test fake is a
 * few lines. `eval` is the atomic increment-and-arm (see the rate limiter for
 * why a separate INCR/PEXPIRE pair is not good enough).
 */
export type LockoutRedis = {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<unknown>
}

// INCR the failure counter, arm its window on the first failure, and set the
// lock once the threshold is reached — one atomic call, so a failure can never
// be counted without its expiry (which would lock the account forever) and the
// threshold can never be crossed by two racing requests without locking.
const RECORD_FAILURE_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if c >= tonumber(ARGV[2]) then redis.call('SET', KEYS[2], '1', 'PX', ARGV[3]) end
return c
`

/**
 * Normalise a submitted email for counting: lowercased and trimmed, so
 * `A@B.com ` and `a@b.com` share one counter. Returns null for anything that is
 * not a usable string — there is nothing to count, and the endpoint will reject
 * it anyway.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  return normalized === '' ? null : normalized
}

/** Key suffix for an email: a hash, never the address. See the module note. */
function emailKeyPart(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail).digest('hex')
}

function failureKey(normalizedEmail: string): string {
  return `auth:fail:${emailKeyPart(normalizedEmail)}`
}

function lockKey(normalizedEmail: string): string {
  return `auth:lock:${emailKeyPart(normalizedEmail)}`
}

/**
 * Whether this email is currently locked out. Throws on a Redis failure — the
 * caller decides what an unusable counter means (we fail closed).
 */
export async function isLockedOut(
  redis: LockoutRedis,
  normalizedEmail: string,
): Promise<boolean> {
  return (await redis.get(lockKey(normalizedEmail))) !== null
}

/**
 * Count one failed sign-in. Returns the running failure count and whether that
 * failure locked the email.
 */
export async function recordSignInFailure(
  redis: LockoutRedis,
  normalizedEmail: string,
): Promise<{ failures: number; locked: boolean }> {
  const reply = await redis.eval(
    RECORD_FAILURE_SCRIPT,
    2,
    failureKey(normalizedEmail),
    lockKey(normalizedEmail),
    String(FAILURE_WINDOW_MS),
    String(MAX_FAILED_SIGNIN_ATTEMPTS),
    String(LOCKOUT_MS),
  )

  const failures = Number(reply)
  if (!Number.isFinite(failures)) {
    throw new Error('Unexpected sign-in lockout EVAL reply shape')
  }

  return { failures, locked: failures >= MAX_FAILED_SIGNIN_ATTEMPTS }
}

/** Clear both keys after a successful sign-in. */
export async function clearSignInFailures(
  redis: LockoutRedis,
  normalizedEmail: string,
): Promise<void> {
  await redis.del(failureKey(normalizedEmail), lockKey(normalizedEmail))
}
