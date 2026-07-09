// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

const PENDING_CHAT_PROMPT_KEY = "eco-pending-chat-prompt";

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function normalizePendingChatPrompt(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function rememberPendingChatPrompt(
  value: string | null | undefined,
): void {
  if (!canUseSessionStorage()) {
    return;
  }

  try {
    const prompt = normalizePendingChatPrompt(value);
    if (!prompt) {
      window.sessionStorage.removeItem(PENDING_CHAT_PROMPT_KEY);
      return;
    }

    window.sessionStorage.setItem(PENDING_CHAT_PROMPT_KEY, prompt);
  } catch {
    // Best-effort only. URL-based continuation can still carry the prompt.
  }
}

export function readPendingChatPrompt(): string | null {
  if (!canUseSessionStorage()) {
    return null;
  }

  try {
    return normalizePendingChatPrompt(
      window.sessionStorage.getItem(PENDING_CHAT_PROMPT_KEY),
    );
  } catch {
    return null;
  }
}

export function clearPendingChatPrompt(): void {
  if (!canUseSessionStorage()) {
    return;
  }

  try {
    window.sessionStorage.removeItem(PENDING_CHAT_PROMPT_KEY);
  } catch {
    // Best-effort only.
  }
}
