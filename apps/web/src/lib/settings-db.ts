// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import nacl from "tweetnacl";
import { encodeBase64, decodeBase64, decodeUTF8, encodeUTF8 } from "tweetnacl-util";
import { safeStorage } from "./local-storage";

export interface SettingsDB extends DBSchema {
  settings: {
    key: string;
    value: {
      key: string;
      ciphertext: string;
      nonce: string;
    };
  };
  memories: {
    key: string;
    value: {
      id: string;
      ciphertext: string;
      nonce: string;
      createdAt: number;
    };
    indexes: {
      "by-created": number;
    };
  };
}

const KEY_STORAGE_KEY = "eco-settings-key";

/**
 * Get or create the symmetric encryption key for settings/memories.
 * Stored in localStorage as base64. If missing, generates a new random key.
 */
export function getOrCreateKey(): Uint8Array {
  const stored = safeStorage.get(KEY_STORAGE_KEY);
  if (stored) return decodeBase64(stored);
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  safeStorage.set(KEY_STORAGE_KEY, encodeBase64(key));
  return key;
}

/**
 * Encrypt a plaintext string with nacl.secretbox.
 * Returns base64-encoded ciphertext and nonce.
 */
export function encryptSetting(plaintext: string): { ciphertext: string; nonce: string } {
  const key = getOrCreateKey();
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const message = decodeUTF8(plaintext);
  const box = nacl.secretbox(message, nonce, key);
  return { ciphertext: encodeBase64(box), nonce: encodeBase64(nonce) };
}

/**
 * Decrypt a ciphertext string with nacl.secretbox.
 * Throws "Decryption failed" if the box cannot be opened (wrong key or nonce).
 */
export function decryptSetting(ciphertext: string, nonce: string): string {
  const key = getOrCreateKey();
  const opened = nacl.secretbox.open(decodeBase64(ciphertext), decodeBase64(nonce), key);
  if (!opened) throw new Error("Decryption failed");
  return encodeUTF8(opened);
}

/**
 * Open the "eco-settings" IndexedDB database with settings and memories stores.
 * Separate from the "eco-chat" database to avoid migration conflicts.
 */
export const SETTINGS_DB_NAME = "eco-settings";
export const SETTINGS_DB_VERSION = 1;

/**
 * Upgrade body, exported so a test can run it at a future version. Guarded so
 * a version bump doesn't re-create existing stores — that throws
 * ConstraintError, aborts the upgrade, and every later open rejects, leaving
 * settings on defaults with no way back.
 */
export function upgradeSettingsDB(db: IDBPDatabase<SettingsDB>): void {
  if (!db.objectStoreNames.contains("settings")) {
    db.createObjectStore("settings", { keyPath: "key" });
  }
  if (!db.objectStoreNames.contains("memories")) {
    const memStore = db.createObjectStore("memories", { keyPath: "id" });
    memStore.createIndex("by-created", "createdAt");
  }
}

export function openSettingsDB(): Promise<IDBPDatabase<SettingsDB>> {
  return openDB<SettingsDB>(SETTINGS_DB_NAME, SETTINGS_DB_VERSION, {
    upgrade: upgradeSettingsDB,
  });
}
