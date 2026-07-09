// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import type { Conversation } from "./types/conversation";
import type { DbMessage } from "./db";
import { openEcoDB } from "./db";
import type { ValidationConversationHistoryFixture } from "./validation-harness";

export const VALIDATION_CONVERSATION_FIXTURE_ID =
  "eco-validation-conversation-history";
export const VALIDATION_CONVERSATION_ASSISTANT_ID =
  "eco-validation-assistant-message";

const FIXTURE_CREATED_AT = 1_776_000_000_000;

type InstallableConversationHistoryFixture = Exclude<
  ValidationConversationHistoryFixture,
  "none" | "clear"
>;

export function buildValidationConversationHistoryFixture(
  mode: InstallableConversationHistoryFixture = "assistant-dom",
): {
  conversation: Conversation;
  messages: DbMessage[];
} {
  const isHybridContinuation = mode === "hybrid-continuation";
  const conversation: Conversation = {
    id: VALIDATION_CONVERSATION_FIXTURE_ID,
    title: isHybridContinuation
      ? "Validation hybrid continuation"
      : "Validation conversation history",
    createdAt: FIXTURE_CREATED_AT,
    updatedAt: FIXTURE_CREATED_AT + 2,
    activeLeafId: VALIDATION_CONVERSATION_ASSISTANT_ID,
    preview: isHybridContinuation
      ? "Hybrid/offline continuation fixture for browser validation."
      : "Deterministic assistant message for browser validation.",
    pinnedAt: null,
  };

  return {
    conversation,
    messages: [
      {
        id: "eco-validation-user-message",
        conversationId: conversation.id,
        parentId: null,
        role: "user",
        content: isHybridContinuation
          ? "Keep this remote answer available offline."
          : "Load deterministic browser-test history.",
        createdAt: FIXTURE_CREATED_AT + 1,
        status: "complete",
      },
      {
        id: VALIDATION_CONVERSATION_ASSISTANT_ID,
        conversationId: conversation.id,
        parentId: "eco-validation-user-message",
        role: "assistant",
        content:
          isHybridContinuation
            ? "The Eco Network response dropped, then this same answer finished locally without claiming a pure on-device turn."
            : "Deterministic assistant history fixture rendered from IndexedDB for DOM assertions.",
        createdAt: FIXTURE_CREATED_AT + 2,
        status: "complete",
        inferenceMethod: "local",
        ...(isHybridContinuation && { offlineDivider: true }),
      },
    ],
  };
}

export async function installValidationConversationHistoryFixture(
  mode: InstallableConversationHistoryFixture = "assistant-dom",
): Promise<Conversation> {
  const db = await openEcoDB();
  try {
    const { conversation, messages } = buildValidationConversationHistoryFixture(mode);
    await db.put("conversations", {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      activeLeafId: conversation.activeLeafId,
      preview: conversation.preview,
      pinnedAt: conversation.pinnedAt ?? null,
    });

    const tx = db.transaction("messages", "readwrite");
    for (const message of messages) {
      await tx.store.put(message);
    }
    await tx.done;

    return conversation;
  } finally {
    db.close();
  }
}

export async function clearValidationConversationHistoryFixture(): Promise<void> {
  const db = await openEcoDB();
  try {
    await db.delete("conversations", VALIDATION_CONVERSATION_FIXTURE_ID);
    const messages = await db.getAllFromIndex(
      "messages",
      "by-conversation",
      VALIDATION_CONVERSATION_FIXTURE_ID,
    );
    const tx = db.transaction("messages", "readwrite");
    for (const message of messages) {
      await tx.store.delete(message.id);
    }
    await tx.done;
  } finally {
    db.close();
  }
}
