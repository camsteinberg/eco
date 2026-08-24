// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, afterEach } from 'vitest'
import {
  getAuthBaseURL,
  assertSelfOriginEmailLink,
} from '../email-link-guard.js'

const ENV_KEYS = ['BETTER_AUTH_BASE_URL', 'API_INTERNAL_URL'] as const

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
}

describe('email-link-guard', () => {
  const original = snapshotEnv()

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = original[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  describe('getAuthBaseURL', () => {
    it('prefers BETTER_AUTH_BASE_URL, then API_INTERNAL_URL, then the localhost default', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      process.env.API_INTERNAL_URL = 'https://internal.example.com'
      expect(getAuthBaseURL()).toBe('https://auth.example.com')

      delete process.env.BETTER_AUTH_BASE_URL
      expect(getAuthBaseURL()).toBe('https://internal.example.com')

      delete process.env.API_INTERNAL_URL
      expect(getAuthBaseURL()).toBe('http://localhost:3001')
    })
  })

  describe('assertSelfOriginEmailLink', () => {
    it('returns the URL unchanged when it is on the auth origin', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      const link =
        'https://auth.example.com/api/auth/reset-password/tok_123?callbackURL=%2Fchat'
      expect(assertSelfOriginEmailLink(link)).toBe(link)
    })

    it('matches on origin only — a different path on the same origin is trusted', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      const link = 'https://auth.example.com/anything/at/all'
      expect(assertSelfOriginEmailLink(link)).toBe(link)
    })

    it('throws for a link on a foreign origin (phishing/open-redirect defense)', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      expect(() =>
        assertSelfOriginEmailLink('https://evil.example.net/api/auth/reset-password/tok'),
      ).toThrow(/not the auth origin/)
    })

    it('throws when only the host looks similar (no substring match)', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      expect(() =>
        assertSelfOriginEmailLink('https://auth.example.com.evil.net/x'),
      ).toThrow(/not the auth origin/)
    })

    it('throws for an unparseable URL', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      expect(() => assertSelfOriginEmailLink('not a url')).toThrow(/not parseable/)
    })

    it('distinguishes scheme — an http link is rejected when the base is https', () => {
      process.env.BETTER_AUTH_BASE_URL = 'https://auth.example.com'
      expect(() =>
        assertSelfOriginEmailLink('http://auth.example.com/api/auth/reset'),
      ).toThrow(/not the auth origin/)
    })
  })
})
