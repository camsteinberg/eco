// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

/**
 * Base64 Payload Fuzz Tests (R32.10 — TS side)
 *
 * Property-based tests using fast-check for Base64 encoding/decoding boundary.
 * Verifies that truncated, padded, and invalid Base64 inputs are handled
 * gracefully — no crashes, no uncaught exceptions.
 */

import fc from 'fast-check'
import nacl from 'tweetnacl'
import { describe, it, expect } from 'vitest'

describe('Base64 Payload Fuzz Tests', () => {
  it('base64 encode -> decode roundtrip preserves data for 1000 random byte arrays', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 1024 }),
        (bytes) => {
          const encoded = Buffer.from(bytes).toString('base64')
          const decoded = Buffer.from(encoded, 'base64')
          expect(Buffer.compare(Buffer.from(bytes), decoded)).toBe(0)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('truncated base64 never crashes decoder', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 256 }),
        fc.float({ min: 0, max: 1, noNaN: true }),
        (bytes, ratio) => {
          const encoded = Buffer.from(bytes).toString('base64')
          const truncateAt = Math.floor(ratio * encoded.length)
          const truncated = encoded.slice(0, truncateAt)
          // Node's Buffer.from is lenient -- should never throw
          const result = Buffer.from(truncated, 'base64')
          expect(result).toBeInstanceOf(Buffer)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('invalid characters in base64 never crash decoder', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        (s) => {
          // Completely random strings (may contain non-base64 chars)
          const result = Buffer.from(s, 'base64')
          expect(result).toBeInstanceOf(Buffer)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('NaCl box.open returns null (not crash) on corrupted ciphertext', { timeout: 15000 }, () => {
    const sender = nacl.box.keyPair()
    const receiver = nacl.box.keyPair()
    const nonce = new Uint8Array(24)

    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 512 }),
        (corruptedBytes) => {
          const result = nacl.box.open(
            corruptedBytes,
            nonce,
            sender.publicKey,
            receiver.secretKey,
          )

          // box.open should return null on bad ciphertext, never throw
          expect(result).toBeNull()
        },
      ),
      { numRuns: 1000 },
    )
  })
})
