// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

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
        inferenceMethod: "local",
      },
      shouldSwitchToNetwork: false,
    };
  }

  return {
    globalError,
    assistantUpdate: {
      status: "error",
      errorMessage:
        "On-device AI needed a moment. Try again on this device to pick up where you left off.",
      inferenceMethod: "local",
    },
    shouldSwitchToNetwork: false,
  };
}
