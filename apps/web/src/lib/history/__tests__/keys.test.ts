// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect } from 'vitest'
import { deriveKey } from '../keys'

describe('deriveKey', () => {
  it('returns a 32-byte Uint8Array', () => {
    const key = deriveKey('session-token-abc-123')
    expect(key).toBeInstanceOf(Uint8Array)
    expect(key.length).toBe(32)
  })

  it('is deterministic -- same token produces same key', () => {
    const key1 = deriveKey('my-session-token')
    const key2 = deriveKey('my-session-token')
    expect(key1).toEqual(key2)
  })

  it('produces different keys for different tokens', () => {
    const key1 = deriveKey('token-aaa')
    const key2 = deriveKey('token-bbb')
    expect(key1).not.toEqual(key2)
  })
})
