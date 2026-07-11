// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

import { LOCAL_RUNTIME_HICCUP_MESSAGE } from "../local-ai/adapters/error-messages";
import type { ChatMessage } from "../stores/chatStore";

export type ChatCompletionMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type LocalRuntimeCrashRecovery = {
  globalError: string;
  assistantUpdate:
    | {
        status: "complete";
        streamInterrupted: true;
        interruptedReason: "fault";
        inferenceMethod: "local";
      }
    | {
        status: "error";
        errorMessage: string;
        inferenceMethod: "local";
      };
  shouldSwitchToNetwork: false;
};

export function buildLocalFallbackMessages({
  systemPrompt,
  messages,
  partialAssistantContent,
}: {
  systemPrompt: string;
  messages: ChatCompletionMessage[];
  partialAssistantContent: string;
}): ChatCompletionMessage[] {
  const fallbackMessages: ChatCompletionMessage[] = [
    { role: "system", content: systemPrompt },
    ...messages,
  ];

  if (partialAssistantContent.trim().length > 0) {
    fallbackMessages.push({
      role: "assistant",
      content: partialAssistantContent,
    });
  }

  return fallbackMessages;
}

export function getLocalRuntimeCrashRecovery(
  hasPartialContent: boolean,
): LocalRuntimeCrashRecovery {
  const globalError =
    "On-device AI needed a moment. Your conversation is safe — try again to keep going on this device.";

  if (hasPartialContent) {
    return {
      globalError,
      assistantUpdate: {
        status: "complete",
        streamInterrupted: true,
        interruptedReason: "fault",
        inferenceMethod: "local",
      },
      shouldSwitchToNetwork: false,
    };
  }

  return {
    globalError,
    assistantUpdate: {
      status: "error",
      errorMessage: LOCAL_RUNTIME_HICCUP_MESSAGE,
      inferenceMethod: "local",
    },
    shouldSwitchToNetwork: false,
  };
}

/**
 * Restore-time sweep for replies a crash or reload left unfinalized.
 *
 * A generation that never reaches its completion handler is persisted with its
 * live status still `"streaming"` (or `"sending"`) — the store's `isStreaming`
 * flag doesn't survive a reload, so on restore that message renders as a bare,
 * actionless bubble (empty when no tokens landed before the crash). This marks
 * those assistant messages as interrupted with reason `"restore-detected"` so
 * the bubble shows the honest "this reply was interrupted" marker plus a working
 * Try again, instead of looking like a blank or forever-loading reply.
 *
 * Deliberately narrow: only ASSISTANT messages whose persisted status is a
 * non-terminal `"streaming"`/`"sending"` are touched. A finished reply
 * (`"complete"`/`"error"`, or a legacy record with no status) is left exactly as
 * stored. Returns a new array; unaffected messages are passed through by
 * reference.
 */
export function markRestoredInterruptions(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const isUnfinalizedAssistant =
      message.role === "assistant" &&
      (message.status === "streaming" || message.status === "sending");
    if (!isUnfinalizedAssistant) return message;
    return {
      ...message,
      status: "complete",
      streamInterrupted: true,
      interruptedReason: "restore-detected",
    };
  });
}
