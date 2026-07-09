// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { readGuestLocalContext } from "./guest-local-context";
import { readPendingChatPrompt } from "./pending-chat-prompt";

export type ChatContinuationPreview = {
  kind: "prompt" | "draft";
  text: string;
};

/**
 * Read the best currently available chat continuation text for UI previews.
 *
 * Pending prompt handoffs take priority because they represent a deliberate
 * one-time continuation flow. If there is no queued prompt, fall back to the
 * guest-local composer draft captured during auth-required detours.
 */
export function readChatContinuationPreview(): ChatContinuationPreview | null {
  const pendingPrompt = readPendingChatPrompt();
  if (pendingPrompt) {
    return {
      kind: "prompt",
      text: pendingPrompt,
    };
  }

  const guestContext = readGuestLocalContext();
  if (guestContext?.composerDraft) {
    return {
      kind: "draft",
      text: guestContext.composerDraft,
    };
  }

  return null;
}
