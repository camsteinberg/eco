// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

// The session cookie is the whole of our authentication: if it is readable from
// JavaScript, or sent over plaintext, or attached to cross-site requests, the
// session is takeable. Those three flags came from a mix of our config block and
// better-auth's defaults, and nothing asserted the result. This test resolves the
// attributes the way better-auth itself does (`getCookies`, the same function the
// request path uses) from the config `createAuth` actually builds, so a library
// default that changes on a bump fails here rather than in production.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getCookies } from 'better-auth/cookies'

vi.mock('../apple-secret.js', () => ({
  generateAppleClientSecret: vi.fn(),
}))
vi.mock('better-auth', () => ({
  betterAuth: vi.fn().mockReturnValue({ handler: vi.fn(), api: {} }),
}))
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: vi.fn().mockReturnValue({}),
}))
vi.mock('better-auth/api', () => ({
  createAuthMiddleware: vi.fn().mockReturnValue(vi.fn()),
  APIError: class APIError extends Error {},
}))
vi.mock('better-auth/plugins', () => ({
  magicLink: vi.fn().mockReturnValue({}),
}))
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({ emails: { send: vi.fn() } })),
}))
vi.mock('../../db/schema/auth.js', () => ({
  user: {},
  session: {},
  account: {},
  verification: {},
}))
vi.mock('../finalize-new-user.js', () => ({ finalizeNewUser: vi.fn() }))
vi.mock('../../lib/auth-origins.js', () => ({
  getAllowedWebOrigins: vi.fn().mockReturnValue(['https://econetwork.ai']),
}))
vi.mock('../../lib/escape-html.js', () => ({
  escapeHtml: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../signup-email-policy.js', () => ({
  getSignupEmailRejectionReason: vi.fn().mockReturnValue(null),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { createAuth } from '../index.js'
import { betterAuth } from 'better-auth'

const mockBetterAuth = betterAuth as ReturnType<typeof vi.fn>

async function resolveSessionCookie() {
  process.env.BETTER_AUTH_BASE_URL = 'https://api.econetwork.ai'
  await createAuth({} as Parameters<typeof createAuth>[0])
  const options = mockBetterAuth.mock.calls[0]![0]
  return getCookies(options).sessionToken
}

describe('session cookie attributes', () => {
  const originalBaseURL = process.env.BETTER_AUTH_BASE_URL

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalBaseURL === undefined) delete process.env.BETTER_AUTH_BASE_URL
    else process.env.BETTER_AUTH_BASE_URL = originalBaseURL
  })

  it('is httpOnly, so a cross-site script cannot read the session token', async () => {
    const cookie = await resolveSessionCookie()
    expect(cookie.attributes.httpOnly).toBe(true)
  })

  it('is secure, so it never travels over plaintext', async () => {
    const cookie = await resolveSessionCookie()
    expect(cookie.attributes.secure).toBe(true)
  })

  it('is SameSite=Lax, so it is not attached to cross-site POSTs', async () => {
    const cookie = await resolveSessionCookie()
    expect(cookie.attributes.sameSite).toBe('lax')
  })

  it('is scoped to the whole origin and carries no domain by default', async () => {
    const cookie = await resolveSessionCookie()
    expect(cookie.attributes.path).toBe('/')
    expect(cookie.attributes.domain).toBeUndefined()
  })
})
