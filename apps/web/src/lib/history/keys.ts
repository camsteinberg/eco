// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const SALT = new TextEncoder().encode('eco-conversation-history-v1')
const INFO = new TextEncoder().encode('aes-256-key')

export function deriveKey(sessionToken: string): Uint8Array {
  const ikm = new TextEncoder().encode(sessionToken)
  return hkdf(sha256, ikm, SALT, INFO, 32)
}
