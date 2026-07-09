// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Db } from '../../db/index.js'

// The email feature set is coupled to RESEND_API_KEY: setting the key must
// flip verification (sign-up send + sign-in resend + sign-in gating) and the
// password-reset sender ON together, and leaving it unset must leave auth
// fully usable without email. The `resend` client is module-scoped, so each
// case re-imports the module after stubbing the environment.
describe('createAuth email coupling', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  async function buildAuth() {
    const { createAuth } = await import('../index.js')
    // The drizzle adapter does not touch the database at construction time.
    return createAuth({} as unknown as Db)
  }

  it('keeps every email feature off when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '')
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')

    const auth = await buildAuth()

    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false)
    expect(auth.options.emailAndPassword?.sendResetPassword).toBeUndefined()
    expect(auth.options.emailVerification).toBeUndefined()
  })

  it('turns verification sending and password reset on with the key — without gating sign-in', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test_dummy')
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret')

    const auth = await buildAuth()

    // Soft verification: in better-auth 1.6.23, requireEmailVerification also
    // suppresses the session at sign-up (token: null), stranding new users as
    // guests until they verify. Email is for recovery, not gating — this must
    // stay false even when the key is set.
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(false)
    // A password reset must revoke every existing session (account-takeover
    // recovery) — live-verified that without this the old session survives.
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true)
    expect(auth.options.emailAndPassword?.sendResetPassword).toBeTypeOf('function')
    expect(auth.options.emailVerification?.sendOnSignUp).toBe(true)
    // Dormant guard: only fires if strict gating is ever enabled — then a
    // blocked unverified sign-in re-sends the link.
    expect(auth.options.emailVerification?.sendOnSignIn).toBe(true)
    expect(auth.options.emailVerification?.sendVerificationEmail).toBeTypeOf('function')
  })
})
