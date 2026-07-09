// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from 'vitest'
import { encryptData, decryptData } from '../storage'
import { deriveKey } from '../keys'

describe('storage encryption', () => {
  let key: Uint8Array

  beforeEach(() => {
    key = deriveKey('test-session-token')
  })

  it('round-trips a string through encrypt/decrypt', () => {
    const data = JSON.stringify({ messages: ['hello', 'world'] })
    const encrypted = encryptData(data, key)
    expect(typeof encrypted).toBe('string')
    expect(encrypted).not.toBe(data)

    const decrypted = decryptData(encrypted, key)
    expect(decrypted).toBe(data)
  })

  it('produces different ciphertext each time (random nonce)', () => {
    const data = 'same data'
    const enc1 = encryptData(data, key)
    const enc2 = encryptData(data, key)
    expect(enc1).not.toBe(enc2)
  })

  it('decrypt fails with a wrong key', () => {
    const data = 'secret'
    const encrypted = encryptData(data, key)
    const wrongKey = deriveKey('wrong-token')
    expect(() => decryptData(encrypted, wrongKey)).toThrow()
  })

  it('handles empty string', () => {
    const encrypted = encryptData('', key)
    const decrypted = decryptData(encrypted, key)
    expect(decrypted).toBe('')
  })

  it('handles large payloads', () => {
    const data = 'x'.repeat(100_000)
    const encrypted = encryptData(data, key)
    const decrypted = decryptData(encrypted, key)
    expect(decrypted).toBe(data)
  })
})
