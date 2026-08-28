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
  /** Small non-secret-derived records; today only the encryption-key backup. */
  meta: {
    key: string;
    value: { key: string; value: string };
  };
}

const KEY_STORAGE_KEY = "eco-settings-key";
const KEY_META_RECORD = "encryption-key";

let cachedKey: Uint8Array | null = null;

/**
 * Get or create the symmetric encryption key for settings/memories.
 *
 * Synchronous. Prefers the in-memory key established by `ensureSettingsKey`;
 * otherwise reads localStorage and, if that is empty too, mints a new key.
 * Callers that run before hydration and find no key will mint one that
 * `ensureSettingsKey` later replaces with the IndexedDB backup if one exists.
 */
export function getOrCreateKey(): Uint8Array {
  if (cachedKey) return cachedKey;
  const stored = safeStorage.get(KEY_STORAGE_KEY);
  if (stored) {
    cachedKey = decodeBase64(stored);
    return cachedKey;
  }
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  safeStorage.set(KEY_STORAGE_KEY, encodeBase64(key));
  cachedKey = key;
  return key;
}

/**
 * Make the encryption key durable in both places before settings are read.
 *
 * The key used to live only in localStorage. Clearing site data for
 * localStorage alone (privacy tools, "clear cookies and site data" scoped
 * views, some browsers' storage pressure handling) left the encrypted records
 * in IndexedDB unreadable, and the store then deleted them as corrupt. The
 * IndexedDB copy is authoritative: if it exists it wins, and localStorage is
 * re-seeded from it. If only localStorage has a key, it is backed up. If
 * neither has one, a fresh key is written to both.
 */
export async function ensureSettingsKey(): Promise<Uint8Array> {
  let db: IDBPDatabase<SettingsDB> | undefined;
  try {
    db = await openSettingsDB();
    const backup = await db.get("meta", KEY_META_RECORD);
    if (backup) {
      cachedKey = decodeBase64(backup.value);
      safeStorage.set(KEY_STORAGE_KEY, backup.value);
      return cachedKey;
    }
    const key = getOrCreateKey();
    await db.put("meta", { key: KEY_META_RECORD, value: encodeBase64(key) });
    return key;
  } catch {
    // IndexedDB unavailable: fall back to the localStorage-only behaviour.
    return getOrCreateKey();
  } finally {
    db?.close();
  }
}

/** Test-only: forget the in-memory key so the next call re-reads storage. */
export function resetSettingsKeyCacheForTests(): void {
  cachedKey = null;
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
  const decodedNonce = decodeBase64(nonce);
  // A truncated stored record or key must surface as the same "Decryption
  // failed" callers already treat as a corrupt record — not as a tweetnacl
  // internal ("bad nonce size" / "bad key size") nothing catches by name.
  if (
    key.length !== nacl.secretbox.keyLength ||
    decodedNonce.length !== nacl.secretbox.nonceLength
  ) {
    throw new Error("Decryption failed");
  }
  const opened = nacl.secretbox.open(decodeBase64(ciphertext), decodedNonce, key);
  if (!opened) throw new Error("Decryption failed");
  return encodeUTF8(opened);
}

/**
 * Open the "eco-settings" IndexedDB database with settings and memories stores.
 * Separate from the "eco-chat" database to avoid migration conflicts.
 */
export const SETTINGS_DB_NAME = "eco-settings";
export const SETTINGS_DB_VERSION = 2;

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
  if (!db.objectStoreNames.contains("meta")) {
    db.createObjectStore("meta", { keyPath: "key" });
  }
}

export function openSettingsDB(): Promise<IDBPDatabase<SettingsDB>> {
  return openDB<SettingsDB>(SETTINGS_DB_NAME, SETTINGS_DB_VERSION, {
    upgrade: upgradeSettingsDB,
  });
}
