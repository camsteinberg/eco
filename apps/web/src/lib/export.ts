// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { openEcoDB, getActiveBranch } from "./db";
import type { DbConversation, DbMessage } from "./db";

/**
 * The conversation record is not in this device's database.
 *
 * Every export path re-reads the conversation when the button is pressed, so a
 * chat deleted in the meantime (another tab, a sync, the user's own delete)
 * makes that read fail — before any clipboard or file work is attempted. A
 * typed error is what lets the UI say "this conversation is gone" instead of
 * blaming the clipboard or the browser for a failure they had no part in.
 */
export class ConversationNotFoundError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`Conversation ${conversationId} not found`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

export type ConversationExport = {
  version: 1;
  exportedAt: number;
  conversation: DbConversation;
  messages: DbMessage[];
};

/**
 * Export a conversation as JSON including full message tree (all branches).
 * Throws `ConversationNotFoundError` if the conversation is not found.
 */
export async function exportConversationAsJSON(
  conversationId: string
): Promise<string> {
  const db = await openEcoDB();
  const conversation = await db.get("conversations", conversationId);
  if (!conversation) {
    throw new ConversationNotFoundError(conversationId);
  }

  const messages = await db.getAllFromIndex(
    "messages",
    "by-conversation",
    conversationId
  );

  const exportData: ConversationExport = {
    version: 1,
    exportedAt: Date.now(),
    conversation,
    messages,
  };

  return JSON.stringify(exportData, null, 2);
}

/**
 * Export a conversation as Markdown using the active branch (flattened).
 * System messages are skipped. Throws `ConversationNotFoundError` if the
 * conversation is not found.
 */
export async function exportConversationAsMarkdown(
  conversationId: string
): Promise<string> {
  const db = await openEcoDB();
  const conversation = await db.get("conversations", conversationId);
  if (!conversation) {
    throw new ConversationNotFoundError(conversationId);
  }

  const branch = await getActiveBranch(
    db,
    conversationId,
    conversation.activeLeafId
  );

  const lines: string[] = [];
  lines.push(`# ${conversation.title}`);
  lines.push("");
  lines.push(
    `*Exported from Eco on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}*`
  );
  lines.push("");

  for (const msg of branch) {
    if (msg.role === "system") continue;

    const roleLabel = msg.role === "user" ? "You" : "Eco";
    const timestamp = new Date(msg.createdAt).toLocaleString();
    lines.push(`**${roleLabel}** *(${timestamp})*`);
    lines.push("");
    lines.push(msg.content);
    if (msg.reactions && msg.reactions.length > 0) {
      const emojiLabels = msg.reactions.map((r) => `[${r.emoji}]`).join(" ");
      lines.push("");
      lines.push(`> Reactions: ${emojiLabels}`);
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Trigger a file download in the browser by creating a temporary anchor element.
 */
export function downloadFile(
  content: string,
  filename: string,
  mimeType: string
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
