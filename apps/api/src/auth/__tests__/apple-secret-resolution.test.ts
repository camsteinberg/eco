// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the apple-secret module before importing the module under test
vi.mock('../apple-secret.js', () => ({
  generateAppleClientSecret: vi.fn(),
}))

// Mock better-auth and its dependencies to avoid side effects
vi.mock('better-auth', () => ({
  betterAuth: vi.fn().mockReturnValue({
    handler: vi.fn(),
    api: {},
  }),
}))
vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: vi.fn().mockReturnValue({}),
}))
vi.mock('better-auth/api', () => ({
  createAuthMiddleware: vi.fn().mockReturnValue(vi.fn()),
  APIError: class APIError extends Error {
    constructor(code: string, opts: { message: string }) {
      super(opts.message)
    }
  },
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
vi.mock('../finalize-new-user.js', () => ({
  finalizeNewUser: vi.fn(),
}))
vi.mock('../../lib/auth-origins.js', () => ({
  getAllowedWebOrigins: vi.fn().mockReturnValue(['http://localhost:3000']),
}))
vi.mock('../../lib/escape-html.js', () => ({
  escapeHtml: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../signup-email-policy.js', () => ({
  getSignupEmailRejectionReason: vi.fn().mockReturnValue(null),
}))

import { createAuth } from '../index.js'
import { generateAppleClientSecret } from '../apple-secret.js'
import { betterAuth } from 'better-auth'

const mockGenerate = generateAppleClientSecret as ReturnType<typeof vi.fn>
const mockBetterAuth = betterAuth as ReturnType<typeof vi.fn>

describe('Apple client secret resolution', () => {
  const envBackup: Record<string, string | undefined> = {}
  const appleEnvKeys = [
    'APPLE_CLIENT_ID',
    'APPLE_CLIENT_SECRET',
    'APPLE_PRIVATE_KEY',
    'APPLE_KEY_ID',
    'APPLE_TEAM_ID',
    'APPLE_BUNDLE_ID',
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of appleEnvKeys) {
      envBackup[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const key of appleEnvKeys) {
      if (envBackup[key] === undefined) delete process.env[key]
      else process.env[key] = envBackup[key]
    }
  })

  const mockDb = {} as Parameters<typeof createAuth>[0]

  it('uses the generator when all signing inputs are present', async () => {
    process.env.APPLE_CLIENT_ID = 'com.eco.web'
    process.env.APPLE_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----'
    process.env.APPLE_KEY_ID = 'KEYID12345'
    process.env.APPLE_TEAM_ID = 'TEAMID1234'
    delete process.env.APPLE_CLIENT_SECRET

    mockGenerate.mockResolvedValueOnce('generated-jwt-secret')

    await createAuth(mockDb)

    expect(mockGenerate).toHaveBeenCalledOnce()
    const authCall = mockBetterAuth.mock.calls[0][0]
    expect(authCall.socialProviders.apple.clientSecret).toBe('generated-jwt-secret')
  })

  it('falls back to APPLE_CLIENT_SECRET env var when signing inputs are missing', async () => {
    process.env.APPLE_CLIENT_ID = 'com.eco.web'
    process.env.APPLE_CLIENT_SECRET = 'static-secret'
    delete process.env.APPLE_PRIVATE_KEY
    delete process.env.APPLE_KEY_ID
    delete process.env.APPLE_TEAM_ID

    await createAuth(mockDb)

    expect(mockGenerate).not.toHaveBeenCalled()
    const authCall = mockBetterAuth.mock.calls[0][0]
    expect(authCall.socialProviders.apple.clientSecret).toBe('static-secret')
  })

  it('falls back to APPLE_CLIENT_SECRET on generation error', async () => {
    process.env.APPLE_CLIENT_ID = 'com.eco.web'
    process.env.APPLE_CLIENT_SECRET = 'fallback-secret'
    process.env.APPLE_PRIVATE_KEY = 'bad-key'
    process.env.APPLE_KEY_ID = 'KEYID12345'
    process.env.APPLE_TEAM_ID = 'TEAMID1234'

    mockGenerate.mockRejectedValueOnce(new Error('Invalid key format'))

    await createAuth(mockDb)

    expect(mockGenerate).toHaveBeenCalledOnce()
    const authCall = mockBetterAuth.mock.calls[0][0]
    expect(authCall.socialProviders.apple.clientSecret).toBe('fallback-secret')
  })

  it('does not crash boot when Apple is completely unconfigured', async () => {
    delete process.env.APPLE_CLIENT_ID
    delete process.env.APPLE_CLIENT_SECRET
    delete process.env.APPLE_PRIVATE_KEY
    delete process.env.APPLE_KEY_ID
    delete process.env.APPLE_TEAM_ID

    await createAuth(mockDb)

    expect(mockGenerate).not.toHaveBeenCalled()
    const authCall = mockBetterAuth.mock.calls[0][0]
    expect(authCall.socialProviders.apple.clientSecret).toBe('')
    expect(authCall.socialProviders.apple.enabled).toBe(false)
  })
})
