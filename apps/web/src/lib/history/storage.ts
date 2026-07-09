// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import nacl from 'tweetnacl'
import tweetnaclUtil from 'tweetnacl-util'
const { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } = tweetnaclUtil
import type { Conversation } from '../types/conversation'
import { safeStorage } from '../local-storage'

const STORAGE_PREFIX = 'eco-history-'

export function encryptData(plaintext: string, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const messageBytes = decodeUTF8(plaintext)
  const encrypted = nacl.secretbox(messageBytes, nonce, key)
  return encodeBase64(nonce) + '.' + encodeBase64(encrypted)
}

export function decryptData(ciphertext: string, key: Uint8Array): string {
  const parts = ciphertext.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Invalid ciphertext format')
  }
  const nonce = decodeBase64(parts[0])
  const encrypted = decodeBase64(parts[1])
  const decrypted = nacl.secretbox.open(encrypted, nonce, key)
  if (!decrypted) {
    throw new Error('Decryption failed -- wrong key or corrupted data')
  }
  return encodeUTF8(decrypted)
}

export function saveConversation(conversation: Conversation, key: Uint8Array): void {
  const data = JSON.stringify(conversation)
  const encrypted = encryptData(data, key)
  safeStorage.set(STORAGE_PREFIX + conversation.id, encrypted)
}

export function loadConversation(id: string, key: Uint8Array): Conversation | null {
  const encrypted = safeStorage.get(STORAGE_PREFIX + id)
  if (!encrypted) return null
  try {
    const data = decryptData(encrypted, key)
    return JSON.parse(data) as Conversation
  } catch {
    return null
  }
}

export function loadAllConversations(key: Uint8Array): Conversation[] {
  const conversations: Conversation[] = []
  for (const storageKey of safeStorage.keys()) {
    if (!storageKey.startsWith(STORAGE_PREFIX)) continue
    const id = storageKey.slice(STORAGE_PREFIX.length)
    const conversation = loadConversation(id, key)
    if (conversation) {
      conversations.push(conversation)
    }
  }
  return conversations.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteConversation(id: string): void {
  safeStorage.remove(STORAGE_PREFIX + id)
}

export function deleteAllConversations(): void {
  const keysToDelete: string[] = []
  for (const storageKey of safeStorage.keys()) {
    if (storageKey.startsWith(STORAGE_PREFIX)) {
      keysToDelete.push(storageKey)
    }
  }
  for (const k of keysToDelete) {
    safeStorage.remove(k)
  }
}
