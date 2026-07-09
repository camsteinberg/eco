// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, afterEach } from 'vitest'
import { getEmailFrom } from '../index.js'

describe('getEmailFrom', () => {
  const original = process.env.EMAIL_FROM

  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_FROM
    else process.env.EMAIL_FROM = original
  })

  it('defaults to the product-domain sender when EMAIL_FROM is unset', () => {
    delete process.env.EMAIL_FROM
    expect(getEmailFrom()).toBe('Eco <noreply@econetwork.ai>')
  })

  it('uses EMAIL_FROM when set', () => {
    process.env.EMAIL_FROM = 'Eco <hello@econetwork.ai>'
    expect(getEmailFrom()).toBe('Eco <hello@econetwork.ai>')
  })

  it('falls back to the default for a blank/whitespace EMAIL_FROM', () => {
    process.env.EMAIL_FROM = '   '
    expect(getEmailFrom()).toBe('Eco <noreply@econetwork.ai>')
  })

  it('does not default to the unconfigured eco.network domain', () => {
    delete process.env.EMAIL_FROM
    // eco.network has no email DNS (no SPF/DKIM/DMARC); the default must not use it.
    expect(getEmailFrom()).not.toMatch(/@eco\.network/)
  })
})
