// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { DONATION_URL } from '../donation'

describe('DONATION_URL', () => {
  it('is null by default so no donation surface renders until a URL is configured', () => {
    expect(DONATION_URL).toBeNull()
  })
})
