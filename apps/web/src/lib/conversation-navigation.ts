// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

type BranchMessageLike = {
  id: string;
  parentId: string | null;
  createdAt: number;
};

export type PendingMessageFocus = {
  conversationId: string;
  messageId: string;
};

const PENDING_MESSAGE_FOCUS_KEY = "eco-pending-message-focus";
const PENDING_CONVERSATION_SEARCH_KEY = "eco-pending-conversation-search";

export function resolveBranchLeafId(
  messages: BranchMessageLike[],
  targetMessageId: string,
): string | null {
  const target = messages.find((message) => message.id === targetMessageId);
  if (!target) {
    return null;
  }

  const childrenByParent = new Map<string, BranchMessageLike[]>();
  for (const message of messages) {
    if (!message.parentId) {
      continue;
    }

    const existingChildren = childrenByParent.get(message.parentId) ?? [];
    existingChildren.push(message);
    childrenByParent.set(message.parentId, existingChildren);
  }

  const leaves: BranchMessageLike[] = [];
  const stack: BranchMessageLike[] = [target];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    const children = childrenByParent.get(current.id) ?? [];
    if (children.length === 0) {
      leaves.push(current);
      continue;
    }

    for (const child of children) {
      stack.push(child);
    }
  }

  leaves.sort((a, b) => b.createdAt - a.createdAt);
  return leaves[0]?.id ?? targetMessageId;
}

function readSessionValue(key: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // sessionStorage can be unavailable in restricted contexts.
  }
}

function removeSessionValue(key: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // sessionStorage can be unavailable in restricted contexts.
  }
}

export function rememberPendingMessageFocus(input: PendingMessageFocus): void {
  writeSessionValue(PENDING_MESSAGE_FOCUS_KEY, JSON.stringify(input));
}

export function readPendingMessageFocus(): PendingMessageFocus | null {
  const raw = readSessionValue(PENDING_MESSAGE_FOCUS_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PendingMessageFocus>;
    if (
      typeof parsed.conversationId === "string"
      && typeof parsed.messageId === "string"
    ) {
      return {
        conversationId: parsed.conversationId,
        messageId: parsed.messageId,
      };
    }
  } catch {
    // Fall through to clearing invalid data.
  }

  removeSessionValue(PENDING_MESSAGE_FOCUS_KEY);
  return null;
}

export function consumePendingMessageFocus(): PendingMessageFocus | null {
  const pending = readPendingMessageFocus();
  removeSessionValue(PENDING_MESSAGE_FOCUS_KEY);
  return pending;
}

export function rememberPendingConversationSearch(): void {
  writeSessionValue(PENDING_CONVERSATION_SEARCH_KEY, "1");
}

export function consumePendingConversationSearch(): boolean {
  const pending = readSessionValue(PENDING_CONVERSATION_SEARCH_KEY) === "1";
  removeSessionValue(PENDING_CONVERSATION_SEARCH_KEY);
  return pending;
}
