// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

export const OPEN_SHARE_CONVERSATION_EVENT = "eco:open-share-conversation";

export function requestOpenShareConversation(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_SHARE_CONVERSATION_EVENT));
}
