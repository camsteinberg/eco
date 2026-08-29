// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { zipSync, strToU8 } from "fflate";
import { openEcoDB } from "./db";
import { openSettingsDB, decryptSetting } from "./settings-db";
import { logger } from "./logger";

/**
 * Export all user data as a ZIP file for GDPR compliance.
 * Reads conversations and messages from eco-chat IDB,
 * decrypts settings and memories from eco-settings IDB,
 * packages everything into a ZIP, and triggers a browser download.
 */

/**
 * The two browser stores this export reads. Each can fail independently — a
 * database that will not open, a read that throws — and a failure must be
 * NAMED rather than quietly leaving the archive short. An archive missing every
 * conversation looks identical to an archive from someone who never chatted.
 */
export type UserDataExportPart = "conversations" | "settings";

const PART_LABELS: Record<UserDataExportPart, string> = {
  conversations: "your conversations",
  settings: "your settings and memories",
};

export type UserDataExportResult = {
  filename: string
  exportedAt: string
  /** Stores that were read and are present in the archive. */
  included: UserDataExportPart[]
  /** Stores that could not be read; their files are absent from the archive. */
  failed: UserDataExportPart[]
}

/**
 * Neither store could be read, so there is nothing to hand over but the account
 * profile. Downloading that and calling it "your data" would be a lie, so the
 * export fails outright and the UI shows an error instead of a receipt.
 */
export class UserDataExportUnreadableError extends Error {
  constructor() {
    super(
      "Eco could not read your conversations or your settings from this browser's storage, so there was nothing to export. Try again, or reload this tab."
    );
    this.name = "UserDataExportUnreadableError";
  }
}

function buildReadme(
  included: UserDataExportPart[],
  failed: UserDataExportPart[]
): string {
  const lines = [
    "Eco Data Export",
    "",
    "This archive contains the personal data Eco could read from this browser.",
    "",
    "Contents:",
    "- profile.json: Your account information",
  ];

  if (included.includes("conversations")) {
    lines.push("- conversations/: Your chat conversations and messages");
  }
  if (included.includes("settings")) {
    lines.push("- settings.json: Your decrypted settings");
    lines.push("- memories.json: Your decrypted memories");
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push("Not included:");
    for (const part of failed) {
      lines.push(
        `- ${PART_LABELS[part]}: Eco could not read this from the browser's storage, so it is missing from this archive. Nothing already saved is lost — try exporting again.`
      );
    }
  }

  return lines.join("\n") + "\n";
}

export async function exportUserData(
  profile: { name?: string; email?: string } | null
): Promise<UserDataExportResult> {
  const files: Record<string, Uint8Array> = {};
  const exportedAt = new Date().toISOString()
  const included: UserDataExportPart[] = [];
  const failed: UserDataExportPart[] = [];

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
  const conversationFiles: Record<string, Uint8Array> = {};
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
        conversationFiles[`conversations/${conv.id}.json`] = strToU8(
          JSON.stringify({ conversation: conv, messages }, null, 2)
        );
      }
    } finally {
      chatDb.close();
    }
    included.push("conversations");
    Object.assign(files, conversationFiles);
  } catch (error) {
    // A partly-read store is worse than an absent one: it looks complete. Drop
    // whatever was collected and report the whole part as unreadable.
    logger.warn("Data export could not read conversations from storage.", error);
    failed.push("conversations");
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
    included.push("settings");
    files["settings.json"] = strToU8(JSON.stringify(decryptedSettings, null, 2));
    files["memories.json"] = strToU8(JSON.stringify(decryptedMemories, null, 2));
  } catch (error) {
    // Same rule as conversations: an empty settings.json would read as "you had
    // no settings", so the file is omitted and the README says why.
    logger.warn("Data export could not read settings and memories from storage.", error);
    failed.push("settings");
  }

  if (included.length === 0) {
    throw new UserDataExportUnreadableError();
  }

  files["README.txt"] = strToU8(buildReadme(included, failed));

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
    included,
    failed,
  }
}
