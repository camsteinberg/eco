// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { createHash, timingSafeEqual } from 'crypto'

/**
 * Timing-safe string comparison for shared secrets.
 *
 * Both inputs are hashed to a fixed-length SHA-256 digest before the
 * constant-time compare. This avoids the early `length !== length` return a
 * naive implementation needs, which is itself a side channel that leaks the
 * secret's length to an attacker probing with candidate tokens. SHA-256 is
 * collision-resistant, so equal digests still mean equal inputs.
 */
export function safeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest()
  const digestB = createHash('sha256').update(b).digest()
  return timingSafeEqual(digestA, digestB)
}
