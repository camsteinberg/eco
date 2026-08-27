// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { describe, it, expect, beforeEach } from "vitest";

// These will be implemented in the GREEN phase
import {
  openSettingsDB,
  encryptSetting,
  decryptSetting,
  getOrCreateKey,
  ensureSettingsKey,
  resetSettingsKeyCacheForTests,
} from "../settings-db";
import type { SettingsDB } from "../settings-db";

beforeEach(async () => {
  // Clean up IndexedDB between tests
  const { deleteDB } = await import("idb");
  await deleteDB("eco-settings");
  localStorage.clear();
  resetSettingsKeyCacheForTests();
});

describe("ensureSettingsKey", () => {
  it("recovers the key from IndexedDB after localStorage is cleared, so old records still decrypt", async () => {
    await ensureSettingsKey();
    const encrypted = encryptSetting("keep my instructions");

    // Someone clears localStorage (privacy tool, storage pressure) and the page reloads.
    localStorage.clear();
    resetSettingsKeyCacheForTests();

    await ensureSettingsKey();
    expect(decryptSetting(encrypted.ciphertext, encrypted.nonce)).toBe("keep my instructions");
    expect(localStorage.getItem("eco-settings-key")).not.toBeNull();
  });

  it("backs up a key that already exists only in localStorage", async () => {
    const before = localStorage.getItem("eco-settings-key") ?? (getOrCreateKey(), localStorage.getItem("eco-settings-key"));
    await ensureSettingsKey();
    const db = await openSettingsDB();
    try {
      expect((await db.get("meta", "encryption-key"))?.value).toBe(before);
    } finally {
      db.close();
    }
  });
});

describe("getOrCreateKey", () => {
  it("returns a Uint8Array key", () => {
    const key = getOrCreateKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32); // nacl.secretbox.keyLength
  });

  it("returns consistent key across calls", () => {
    const key1 = getOrCreateKey();
    const key2 = getOrCreateKey();
    expect(key1).toEqual(key2);
  });

  it("creates new key if none in localStorage", () => {
    localStorage.removeItem("eco-settings-key");
    const key = getOrCreateKey();
    expect(key).toBeInstanceOf(Uint8Array);
    expect(localStorage.getItem("eco-settings-key")).not.toBeNull();
  });
});

describe("encryptSetting / decryptSetting", () => {
  it("encryptSetting returns ciphertext and nonce", () => {
    const result = encryptSetting("hello");
    expect(result).toHaveProperty("ciphertext");
    expect(result).toHaveProperty("nonce");
    expect(typeof result.ciphertext).toBe("string");
    expect(typeof result.nonce).toBe("string");
  });

  it("ciphertext is not the same as plaintext", () => {
    const result = encryptSetting("hello");
    expect(result.ciphertext).not.toBe("hello");
  });

  it("decryptSetting recovers original plaintext", () => {
    const encrypted = encryptSetting("hello");
    const decrypted = decryptSetting(encrypted.ciphertext, encrypted.nonce);
    expect(decrypted).toBe("hello");
  });

  it("decryptSetting with wrong nonce throws Decryption failed", () => {
    const encrypted = encryptSetting("hello");
    // Corrupt the nonce by using a different encryption's nonce
    const other = encryptSetting("other");
    expect(() => decryptSetting(encrypted.ciphertext, other.nonce)).toThrow(
      "Decryption failed"
    );
  });

  it("handles empty string", () => {
    const encrypted = encryptSetting("");
    const decrypted = decryptSetting(encrypted.ciphertext, encrypted.nonce);
    expect(decrypted).toBe("");
  });

  it("handles unicode characters", () => {
    const text = "Hello, world! Preferences: TypeScript over JavaScript";
    const encrypted = encryptSetting(text);
    const decrypted = decryptSetting(encrypted.ciphertext, encrypted.nonce);
    expect(decrypted).toBe(text);
  });
});

describe("openSettingsDB", () => {
  it('creates database with "settings" and "memories" object stores', async () => {
    const db = await openSettingsDB();
    try {
      expect(db.objectStoreNames).toContain("settings");
      expect(db.objectStoreNames).toContain("memories");
    } finally {
      db.close();
    }
  });

  it("memories store has by-created index", async () => {
    const db = await openSettingsDB();
    try {
      const tx = db.transaction("memories", "readonly");
      const store = tx.objectStore("memories");
      expect(store.indexNames).toContain("by-created");
    } finally {
      db.close();
    }
  });

  it("can store and retrieve encrypted settings", async () => {
    const db = await openSettingsDB();
    try {
      const encrypted = encryptSetting("test instructions");
      await db.put("settings", {
        key: "custom-instructions",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
      });
      const retrieved = await db.get("settings", "custom-instructions");
      expect(retrieved).toBeDefined();
      expect(retrieved!.ciphertext).toBe(encrypted.ciphertext);
      const decrypted = decryptSetting(
        retrieved!.ciphertext,
        retrieved!.nonce
      );
      expect(decrypted).toBe("test instructions");
    } finally {
      db.close();
    }
  });

  it("can store and retrieve encrypted memories", async () => {
    const db = await openSettingsDB();
    try {
      const encrypted = encryptSetting("Prefers TypeScript");
      await db.put("memories", {
        id: "mem-1",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        createdAt: Date.now(),
      });
      const retrieved = await db.get("memories", "mem-1");
      expect(retrieved).toBeDefined();
      const decrypted = decryptSetting(
        retrieved!.ciphertext,
        retrieved!.nonce
      );
      expect(decrypted).toBe("Prefers TypeScript");
    } finally {
      db.close();
    }
  });
});

describe("openSettingsDB upgrade path", () => {
  it("a future version bump keeps existing records instead of aborting on ConstraintError", async () => {
    const { openDB } = await import("idb");
    const v1 = await openSettingsDB();
    await v1.put("settings", { key: "customInstructions", ciphertext: "keep", nonce: "me" });
    v1.close();

    // Run the app's own upgrade body at the next version, exactly as a bump would.
    const { SETTINGS_DB_NAME, SETTINGS_DB_VERSION, upgradeSettingsDB } = await import("../settings-db");
    const v2 = await openDB<SettingsDB>(SETTINGS_DB_NAME, SETTINGS_DB_VERSION + 1, {
      upgrade: upgradeSettingsDB,
    });
    expect(await v2.get("settings", "customInstructions")).toEqual({ key: "customInstructions", ciphertext: "keep", nonce: "me" });
    v2.close();
  });
});
