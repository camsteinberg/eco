// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { zipSync, strToU8 } from "fflate";
import { openEcoDB } from "./db";
import { openSettingsDB, decryptSetting } from "./settings-db";

/**
 * Export all user data as a ZIP file for GDPR compliance.
 * Reads conversations and messages from eco-chat IDB,
 * decrypts settings and memories from eco-settings IDB,
 * packages everything into a ZIP, and triggers a browser download.
 */
export type UserDataExportResult = {
  filename: string
  exportedAt: string
}

export async function exportUserData(
  profile: { name?: string; email?: string } | null
): Promise<UserDataExportResult> {
  const files: Record<string, Uint8Array> = {};
  const exportedAt = new Date().toISOString()

  // README
  files["README.txt"] = strToU8(
    "Eco Data Export\n\n" +
      "This archive contains all your personal data from Eco.\n\n" +
      "Contents:\n" +
      "- profile.json: Your account information\n" +
      "- conversations/: Your chat conversations and messages\n" +
      "- settings.json: Your decrypted settings\n" +
      "- memories.json: Your decrypted memories\n"
  );

  // Profile
  files["profile.json"] = strToU8(
    JSON.stringify(
      {
        name: profile?.name ?? null,
        email: profile?.email ?? null,
        exportedAt,
      },
      null,
      2
    )
  );

  // Conversations and messages from eco-chat IDB
  try {
    const chatDb = await openEcoDB();
    try {
      const conversations = await chatDb.getAll("conversations");

      for (const conv of conversations) {
        const messages = await chatDb.getAllFromIndex(
          "messages",
          "by-conversation",
          conv.id
        );
        files[`conversations/${conv.id}.json`] = strToU8(
          JSON.stringify({ conversation: conv, messages }, null, 2)
        );
      }
    } finally {
      chatDb.close();
    }
  } catch {
    // If eco-chat DB doesn't exist or is inaccessible, skip conversations
  }

  // Settings and memories from eco-settings IDB
  const decryptedSettings: Array<{ key: string; value: string } | { key: string; error: string; raw: true }> = [];
  const decryptedMemories: Array<{ id: string; text: string; createdAt: number } | { id: string; error: string; raw: true }> = [];

  try {
    const settingsDb = await openSettingsDB();
    try {
      // Decrypt settings
      const rawSettings = await settingsDb.getAll("settings");
      for (const setting of rawSettings) {
        try {
          const value = decryptSetting(setting.ciphertext, setting.nonce);
          decryptedSettings.push({ key: setting.key, value });
        } catch {
          decryptedSettings.push({ key: setting.key, error: "Could not decrypt", raw: true });
        }
      }

      // Decrypt memories
      const rawMemories = await settingsDb.getAll("memories");
      for (const memory of rawMemories) {
        try {
          const text = decryptSetting(memory.ciphertext, memory.nonce);
          decryptedMemories.push({ id: memory.id, text, createdAt: memory.createdAt });
        } catch {
          decryptedMemories.push({ id: memory.id, error: "Could not decrypt", raw: true });
        }
      }
    } finally {
      settingsDb.close();
    }
  } catch {
    // If eco-settings DB doesn't exist or is inaccessible, skip settings/memories
  }

  files["settings.json"] = strToU8(JSON.stringify(decryptedSettings, null, 2));
  files["memories.json"] = strToU8(JSON.stringify(decryptedMemories, null, 2));

  // Create ZIP and trigger download
  const zipped = zipSync(files);
  const blob = new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
  const today = new Date().toISOString().split("T")[0];
  const filename = `eco-data-export-${today}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  a.click();
  URL.revokeObjectURL(url);

  return {
    filename,
    exportedAt,
  }
}
