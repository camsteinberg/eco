// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

const GUEST_LOCAL_CONTEXT_KEY = "eco-auth-chat-context";

export type GuestLocalContext = {
  activeConversationId: string | null;
  composerDraft: string | null;
  updatedAt: number;
};

type GuestLocalContextInput =
  | string
  | {
      activeConversationId?: string | null;
      composerDraft?: string | null;
    };

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function normalizeComposerDraft(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim().length > 0 ? value : null;
}

export function rememberGuestLocalContext(input: GuestLocalContextInput): void {
  if (!canUseSessionStorage()) {
    return;
  }

  const previous = readGuestLocalContext();
  const nextContext: GuestLocalContext = {
    activeConversationId:
      typeof input === "string"
        ? input
        : input.activeConversationId === undefined
          ? previous?.activeConversationId ?? null
          : input.activeConversationId ?? null,
    composerDraft:
      typeof input === "string"
        ? previous?.composerDraft ?? null
        : input.composerDraft === undefined
          ? previous?.composerDraft ?? null
          : normalizeComposerDraft(input.composerDraft),
    updatedAt: Date.now(),
  };

  if (!nextContext.activeConversationId && !nextContext.composerDraft) {
    clearGuestLocalContext();
    return;
  }

  const payload: GuestLocalContext = {
    ...nextContext,
  };

  window.sessionStorage.setItem(GUEST_LOCAL_CONTEXT_KEY, JSON.stringify(payload));
}

export function readGuestLocalContext(): GuestLocalContext | null {
  if (!canUseSessionStorage()) {
    return null;
  }

  const raw = window.sessionStorage.getItem(GUEST_LOCAL_CONTEXT_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<GuestLocalContext>;
    const activeConversationId =
      typeof parsed.activeConversationId === "string" && parsed.activeConversationId.length > 0
        ? parsed.activeConversationId
        : null;
    const composerDraft = normalizeComposerDraft(parsed.composerDraft);

    if (!activeConversationId && !composerDraft) {
      clearGuestLocalContext();
      return null;
    }

    return {
      activeConversationId,
      composerDraft,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    clearGuestLocalContext();
    return null;
  }
}

export function consumeGuestLocalContext(): GuestLocalContext | null {
  const context = readGuestLocalContext();
  clearGuestLocalContext();
  return context;
}

export function clearGuestLocalContext(): void {
  if (!canUseSessionStorage()) {
    return;
  }

  window.sessionStorage.removeItem(GUEST_LOCAL_CONTEXT_KEY);
}
