// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { IDBPDatabase } from "idb";
import type { EcoDB, DbConversation, DbMessage } from "./db";
import { ACTIVE_CONVERSATION_STORAGE_KEY } from "./chat-workspace-storage";
import { safeStorage } from "./local-storage";
import { logger } from "./logger";

const LOCALSTORAGE_KEY = "eco-conversations";

type LegacyMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
};

type LegacyConversation = {
  id: string;
  title: string;
  messages: LegacyMessage[];
  createdAt: number;
  updatedAt: number;
};

type ZustandEnvelope = {
  state: {
    conversations: LegacyConversation[];
    activeConversationId: string | null;
  };
  version: number;
};

/**
 * One-time migration from the old Zustand persist localStorage format
 * to IndexedDB. Idempotent: if localStorage key is absent, this is a no-op.
 */
export async function migrateFromLocalStorage(
  db: IDBPDatabase<EcoDB>
): Promise<void> {
  try {
    const raw = safeStorage.get(LOCALSTORAGE_KEY);
    if (!raw) return;

    let envelope: ZustandEnvelope;
    try {
      envelope = JSON.parse(raw) as ZustandEnvelope;
    } catch {
      logger.warn(
        "[eco] Failed to parse localStorage eco-conversations. Skipping migration."
      );
      return;
    }

    if (
      !envelope?.state?.conversations ||
      !Array.isArray(envelope.state.conversations)
    ) {
      logger.warn(
        "[eco] Invalid Zustand persist envelope format. Skipping migration."
      );
      return;
    }

    const { conversations, activeConversationId } = envelope.state;

    for (const conv of conversations) {
      // Write conversation metadata
      const activeLeafId =
        conv.messages.length > 0
          ? conv.messages[conv.messages.length - 1]!.id
          : null;

      const dbConv: DbConversation = {
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        activeLeafId,
        preview: conv.messages[0]?.content.slice(0, 60),
      };
      await db.put("conversations", dbConv);

      // Convert flat messages to tree: sequential parent chain
      const tx = db.transaction("messages", "readwrite");
      for (let i = 0; i < conv.messages.length; i++) {
        const msg = conv.messages[i]!;
        const parentId = i === 0 ? null : conv.messages[i - 1]!.id;
        const dbMsg: DbMessage = {
          id: msg.id,
          conversationId: conv.id,
          parentId,
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt,
        };
        tx.store.put(dbMsg);
      }
      await tx.done;
    }

    // Verify at least one conversation was written successfully
    if (conversations.length > 0) {
      const check = await db.get("conversations", conversations[0]!.id);
      if (!check) {
        logger.warn(
          "[eco] Migration verification failed: could not read back conversation from IndexedDB."
        );
        return;
      }
    }

    if (
      typeof activeConversationId === "string"
      && conversations.some((conversation) => conversation.id === activeConversationId)
    ) {
      safeStorage.set(ACTIVE_CONVERSATION_STORAGE_KEY, activeConversationId)
    }

    // Migration succeeded -- remove the old localStorage key
    safeStorage.remove(LOCALSTORAGE_KEY);
  } catch (err) {
    logger.warn("[eco] localStorage migration failed:", err);
  }
}
