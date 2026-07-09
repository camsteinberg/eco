// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { openEcoDB } from "./db";
import type { DbConversation } from "./db";

export type SearchResult = {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  snippet: string;
  matchIndex: number;
  highlightStart: number;
  highlightEnd: number;
};

/**
 * Full-text search across all messages in IndexedDB.
 * Returns up to `limit` results, deduplicated by conversation (one per conversation).
 * Skips system messages. Case-insensitive substring matching.
 */
export async function searchMessages(
  query: string,
  limit = 20
): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const db = await openEcoDB();
  const lowerQuery = query.toLowerCase();

  // Build conversation title lookup
  const allConversations = await db.getAll("conversations");
  const convMap = new Map<string, DbConversation>();
  for (const conv of allConversations) {
    convMap.set(conv.id, conv);
  }

  // Scan all messages
  const results: SearchResult[] = [];
  const seenConversations = new Set<string>();

  const tx = db.transaction("messages", "readonly");
  let cursor = await tx.store.openCursor();

  while (cursor) {
    const msg = cursor.value;

    // Skip system messages
    if (msg.role !== "system") {
      const lowerContent = msg.content.toLowerCase();
      const matchIdx = lowerContent.indexOf(lowerQuery);

      if (matchIdx !== -1 && !seenConversations.has(msg.conversationId)) {
        seenConversations.add(msg.conversationId);

        const conv = convMap.get(msg.conversationId);

        // Generate snippet (~80 chars around match)
        const snippetStart = Math.max(0, matchIdx - 40);
        const snippetEnd = Math.min(
          msg.content.length,
          matchIdx + query.length + 40
        );
        let snippet = msg.content.slice(snippetStart, snippetEnd);
        const prefix = snippetStart > 0 ? "..." : "";
        const suffix = snippetEnd < msg.content.length ? "..." : "";
        snippet = prefix + snippet + suffix;

        // Calculate highlight positions relative to the snippet
        const highlightStart = prefix.length + (matchIdx - snippetStart);
        const highlightEnd = highlightStart + query.length;

        results.push({
          conversationId: msg.conversationId,
          conversationTitle: conv?.title ?? "Untitled",
          messageId: msg.id,
          snippet,
          matchIndex: matchIdx,
          highlightStart,
          highlightEnd,
        });

        if (results.length >= limit) break;
      }
    }

    cursor = await cursor.continue();
  }

  // Sort by most recent conversation first
  results.sort((a, b) => {
    const aUpdated = convMap.get(a.conversationId)?.updatedAt ?? 0;
    const bUpdated = convMap.get(b.conversationId)?.updatedAt ?? 0;
    return bUpdated - aUpdated;
  });

  return results;
}
