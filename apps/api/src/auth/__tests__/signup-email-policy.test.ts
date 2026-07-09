// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import {
  extractEmailDomain,
  isDisposableEmailDomain,
  getSignupEmailRejectionReason,
  DISPOSABLE_EMAIL_REJECTION_MESSAGE,
} from '../signup-email-policy.js'

describe('extractEmailDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(extractEmailDomain('user@Example.COM')).toBe('example.com')
  })

  it('trims surrounding whitespace', () => {
    expect(extractEmailDomain('  user@example.com  ')).toBe('example.com')
  })

  it('uses the last @ for addresses that (invalidly) contain more than one', () => {
    expect(extractEmailDomain('weird@part@example.com')).toBe('example.com')
  })

  it('returns null for non-string input', () => {
    expect(extractEmailDomain(undefined)).toBeNull()
    expect(extractEmailDomain(null)).toBeNull()
    expect(extractEmailDomain(42)).toBeNull()
    expect(extractEmailDomain({})).toBeNull()
  })

  it('returns null when there is no local part or no domain', () => {
    expect(extractEmailDomain('@example.com')).toBeNull()
    expect(extractEmailDomain('user@')).toBeNull()
    expect(extractEmailDomain('noatsign')).toBeNull()
  })

  it('returns null for a domain with no dot or embedded whitespace (defer to format validation)', () => {
    expect(extractEmailDomain('user@localhost')).toBeNull()
    expect(extractEmailDomain('user@exa mple.com')).toBeNull()
  })
})

describe('isDisposableEmailDomain', () => {
  it('blocks a known disposable provider', () => {
    expect(isDisposableEmailDomain('spammer@mailinator.com')).toBe(true)
    expect(isDisposableEmailDomain('x@guerrillamail.com')).toBe(true)
    expect(isDisposableEmailDomain('x@yopmail.com')).toBe(true)
  })

  it('blocks a subdomain of a known disposable provider', () => {
    expect(isDisposableEmailDomain('bot@inbox.mailinator.com')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isDisposableEmailDomain('Bot@MAILINATOR.com')).toBe(true)
  })

  it('does NOT block a lookalike that merely contains a blocked domain as a substring', () => {
    // `notmailinator.com` must not match `mailinator.com` (substring, not subdomain).
    expect(isDisposableEmailDomain('user@notmailinator.com')).toBe(false)
  })

  it('allows normal / mainstream providers', () => {
    expect(isDisposableEmailDomain('real.person@gmail.com')).toBe(false)
    expect(isDisposableEmailDomain('person@company.co.uk')).toBe(false)
    expect(isDisposableEmailDomain('founder@econetwork.ai')).toBe(false)
  })

  it('does not block malformed or non-string input (lets format validation decide)', () => {
    expect(isDisposableEmailDomain('noatsign')).toBe(false)
    expect(isDisposableEmailDomain(undefined)).toBe(false)
    expect(isDisposableEmailDomain(null)).toBe(false)
  })
})

describe('getSignupEmailRejectionReason', () => {
  it('returns the rejection message for a disposable domain', () => {
    expect(getSignupEmailRejectionReason('x@mailinator.com')).toBe(
      DISPOSABLE_EMAIL_REJECTION_MESSAGE,
    )
  })

  it('returns null for an acceptable email', () => {
    expect(getSignupEmailRejectionReason('real@gmail.com')).toBeNull()
  })

  it('returns null for malformed input (defers to better-auth format validation)', () => {
    expect(getSignupEmailRejectionReason('not-an-email')).toBeNull()
    expect(getSignupEmailRejectionReason(undefined)).toBeNull()
  })
})
