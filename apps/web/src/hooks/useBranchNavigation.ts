// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useMemo, useCallback } from "react";
import { getSiblings } from "../lib/db";
import type { DbMessage } from "../lib/db";
import type { ChatMessage } from "../stores/chatStore";
import { useConversationStore } from "../stores/conversationStore";

export type SiblingInfo = {
  siblings: DbMessage[];
  currentIndex: number;
  total: number;
};

/**
 * Compute branch navigation info for each message in the active branch.
 *
 * Takes all messages for the conversation (from IndexedDB) and the currently
 * displayed branch. Returns a siblingInfo map and a navigateToBranch function.
 */
export function useBranchNavigation(
  allMessages: DbMessage[],
  activeBranch: ChatMessage[]
) {
  const siblingInfo = useMemo(() => {
    const map = new Map<string, SiblingInfo>();
    for (const msg of activeBranch) {
      const { siblings, currentIndex } = getSiblings(
        allMessages,
        msg.id,
        msg.parentId ?? null
      );
      map.set(msg.id, { siblings, currentIndex, total: siblings.length });
    }
    return map;
  }, [allMessages, activeBranch]);

  const navigateToBranch = useCallback(
    (messageId: string, direction: "prev" | "next") => {
      const info = siblingInfo.get(messageId);
      if (!info) return;

      const targetIndex =
        direction === "next" ? info.currentIndex + 1 : info.currentIndex - 1;
      if (targetIndex < 0 || targetIndex >= info.total) return;

      const targetSibling = info.siblings[targetIndex];
      if (!targetSibling) return;

      // Walk DOWN from the target sibling to find its deepest leaf.
      // Follow the first child repeatedly until no children exist.
      let leafId = targetSibling.id;
      let found = true;
      while (found) {
        found = false;
        // Find children of current node, sorted by createdAt
        const children = allMessages
          .filter((m) => m.parentId === leafId)
          .sort((a, b) => a.createdAt - b.createdAt);
        if (children.length > 0) {
          leafId = children[0]!.id;
          found = true;
        }
      }

      const convStore = useConversationStore.getState();
      const convId = convStore.activeConversationId;
      if (convId) {
        convStore.updateConversation(convId, { activeLeafId: leafId });
      }
    },
    [allMessages, siblingInfo]
  );

  return { siblingInfo, navigateToBranch };
}
