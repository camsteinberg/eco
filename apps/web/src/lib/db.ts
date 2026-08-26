// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import type { ChatMessage } from "../stores/chatStore";
import type { Citation } from "./citation-parser";
import type { GroundingVerification } from "./tools";

export type DbConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  activeLeafId: string | null;
  preview?: string;
  pinnedAt?: number | null;
};

export type MessageReaction = {
  emoji: string;
  timestamp: number;
};

export type DbMessage = {
  id: string;
  conversationId: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  status?: "sending" | "streaming" | "complete" | "error";
  errorMessage?: string;
  tokenCount?: number;
  streamStartTime?: number | null;
  streamInterrupted?: boolean;
  /**
   * Why the stream was interrupted, when known. Persisted so a reloaded
   * interrupted reply keeps its honest per-cause copy — see
   * `ChatMessage.interruptedReason`. Optional and backward-compatible: records
   * written before this field simply omit it.
   */
  interruptedReason?: "user-stop" | "fault" | "restore-detected";
  resolvedModel?: string;
  inferenceMethod?: "remote" | "local";
  confidence?: number | null;
  offlineDivider?: boolean;
  reactions?: MessageReaction[];
  /**
   * Grounding source attributions. Persisted so a reloaded answer keeps its
   * source chip — without this a verified answer would silently look
   * unattributed on reload. Mutually exclusive with `verification`.
   */
  citations?: Citation[];
  /**
   * Grounding uncertainty marker, set by a grounding tool's no-source
   * outcomes. Persisted so a reloaded answer stays honestly flagged as
   * "couldn't confirm this" — otherwise an unverified answer would look
   * trustworthy again after reload. Mutually exclusive with `citations`.
   */
  verification?: GroundingVerification;
  /**
   * True when this assistant message is a canonical exact-answer tool result
   * (calculator/datetime/unit). Persisted so a reloaded answer renders the exact
   * host-computed value as plain text (not mangled by Markdown) and copy/export
   * yield the exact value — see `ChatMessage.canonicalToolAnswer`.
   */
  canonicalToolAnswer?: boolean;
  /**
   * Local generation receipt: whether this reply ended near its token limit,
   * and the counts behind that judgement. Persisted so a reloaded truncated
   * reply keeps its notice and Continue action. Records written before these
   * fields omit them — absence must restore as `undefined`, never `false`/`0`,
   * which downstream guards would read as a claim the record never made.
   */
  possiblyTruncated?: boolean;
  localCompletionTokens?: number;
  localMaxTokens?: number;
};

export interface EcoDB extends DBSchema {
  conversations: {
    key: string;
    value: DbConversation;
    indexes: {
      "by-updated": number;
    };
  };
  messages: {
    key: string;
    value: DbMessage;
    indexes: {
      "by-conversation": string;
      "by-parent": string;
    };
  };
}

/** Convert a ChatMessage to a DbMessage for IndexedDB persistence. */
export function toDbMessage(m: ChatMessage, conversationId: string): DbMessage {
  return {
    id: m.id,
    conversationId,
    parentId: m.parentId ?? null,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    status: m.status,
    errorMessage: m.errorMessage,
    tokenCount: m.tokenCount,
    streamStartTime: m.streamStartTime,
    ...(m.streamInterrupted !== undefined && { streamInterrupted: m.streamInterrupted }),
    ...(m.interruptedReason !== undefined && { interruptedReason: m.interruptedReason }),
    ...(m.resolvedModel !== undefined && { resolvedModel: m.resolvedModel }),
    ...(m.inferenceMethod !== undefined && { inferenceMethod: m.inferenceMethod }),
    ...(m.confidence !== undefined && { confidence: m.confidence }),
    ...(m.offlineDivider !== undefined && { offlineDivider: m.offlineDivider }),
    ...(m.citations !== undefined && { citations: m.citations }),
    ...(m.verification !== undefined && { verification: m.verification }),
    ...(m.canonicalToolAnswer !== undefined && { canonicalToolAnswer: m.canonicalToolAnswer }),
    ...(m.possiblyTruncated !== undefined && { possiblyTruncated: m.possiblyTruncated }),
    ...(m.localCompletionTokens !== undefined && { localCompletionTokens: m.localCompletionTokens }),
    ...(m.localMaxTokens !== undefined && { localMaxTokens: m.localMaxTokens }),
  };
}

export const ECO_DB_NAME = "eco-chat";
export const ECO_DB_VERSION = 3;

export type OpenEcoDBOptions = {
  /**
   * Called after this connection closes itself because ANOTHER connection
   * (typically a tab running a newer Eco build) needs to upgrade or delete the
   * database. The caller's cached handle is dead at that point and must be
   * dropped; its next open will either succeed on the new schema or fail
   * with a VersionError (this tab's code is older than the database).
   */
  onBlocking?: () => void;
};

/**
 * `true` when an open failed because the database on disk is NEWER than the
 * schema this build knows — i.e. this tab is running an older Eco than the
 * one that last touched storage. Nothing here can be repaired by retrying;
 * the fix is reloading to get the current build.
 */
export function isVersionError(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "VersionError"
  );
}

export function openEcoDB(options?: OpenEcoDBOptions): Promise<IDBPDatabase<EcoDB>> {
  return openDB<EcoDB>(ECO_DB_NAME, ECO_DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const convStore = db.createObjectStore("conversations", { keyPath: "id" });
        convStore.createIndex("by-updated", "updatedAt");

        const msgStore = db.createObjectStore("messages", { keyPath: "id" });
        msgStore.createIndex("by-conversation", "conversationId");
        msgStore.createIndex("by-parent", "parentId");
      }
      if (oldVersion < 2) {
        // No structural changes -- pinnedAt is a nullable field on existing records.
        // idb handles missing fields gracefully (returns undefined).
      }
      if (oldVersion < 3) {
        // No structural changes -- reactions is a nullable field on existing records.
        // idb handles missing fields gracefully (returns undefined).
      }
    },
    blocked() {
      // A pending deleteDatabase or older connection is blocking this open request.
      // Close stale connections if possible; the 3s hydration timeout in
      // initConversationStore will ensure the UI never stays stuck.
    },
    blocking(_currentVersion, _blockedVersion, event) {
      // Another connection (a tab on a newer build, or a logout's
      // deleteDatabase) is waiting on this one. Holding on would block that
      // tab's upgrade until this tab closes — and its hydration would time
      // out to an empty chat list. Close now; the owner drops its cached
      // handle via onBlocking.
      (event.target as IDBDatabase | null)?.close();
      options?.onBlocking?.();
    },
  });
}

/**
 * Walk the parentId chain from the given leaf message back to the root,
 * then return the path in display order (root first, leaf last).
 *
 * The leaf pointer is a hint, not a precondition: a conversation record can
 * carry a null or dangling `activeLeafId` (message save dropped under storage
 * pressure while the conversation record still updated, interrupted write,
 * external cleanup). Messages that exist must still restore — when the
 * pointer doesn't resolve, fall back to the newest message in the
 * conversation as the leaf instead of rendering an empty pane.
 */
export async function getActiveBranch(
  db: IDBPDatabase<EcoDB>,
  conversationId: string,
  activeLeafId: string | null
): Promise<DbMessage[]> {
  const allMessages = await db.getAllFromIndex(
    "messages",
    "by-conversation",
    conversationId
  );
  if (allMessages.length === 0) return [];

  const byId = new Map(allMessages.map((m) => [m.id, m]));
  const leaf =
    (activeLeafId ? byId.get(activeLeafId) : undefined) ??
    allMessages.reduce((newest, m) => (m.createdAt > newest.createdAt ? m : newest));

  // Walk from leaf to root. The visited set turns a corrupt parentId cycle
  // into a truncated branch instead of a hang.
  const path: DbMessage[] = [];
  const visited = new Set<string>();
  let current: DbMessage | undefined = leaf;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // Reverse to get root-first order
  path.reverse();
  return path;
}

/** Add a reaction to a message, persisting it to IndexedDB. */
export async function addReactionToMessage(
  messageId: string,
  emoji: string
): Promise<void> {
  const db = await openEcoDB();
  try {
    const msg = await db.get("messages", messageId);
    if (!msg) return;
    const reactions = msg.reactions ?? [];
    // Don't add duplicate emoji
    if (reactions.some((r) => r.emoji === emoji)) return;
    msg.reactions = [...reactions, { emoji, timestamp: Date.now() }];
    await db.put("messages", msg);
  } finally {
    db.close();
  }
}

/** Remove a reaction from a message, persisting the change to IndexedDB. */
export async function removeReactionFromMessage(
  messageId: string,
  emoji: string
): Promise<void> {
  const db = await openEcoDB();
  try {
    const msg = await db.get("messages", messageId);
    if (!msg) return;
    msg.reactions = (msg.reactions ?? []).filter((r) => r.emoji !== emoji);
    await db.put("messages", msg);
  } finally {
    db.close();
  }
}

/**
 * Find sibling messages (messages sharing the same parentId) and the
 * current message's index among them, sorted by createdAt.
 */
export function getSiblings(
  allMessages: DbMessage[],
  messageId: string,
  parentId: string | null
): { siblings: DbMessage[]; currentIndex: number } {
  const siblings = allMessages
    .filter((m) => m.parentId === parentId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const currentIndex = siblings.findIndex((m) => m.id === messageId);
  return { siblings, currentIndex };
}
