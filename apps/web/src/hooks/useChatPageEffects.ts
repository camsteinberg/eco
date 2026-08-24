// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { ReadonlyURLSearchParams } from "next/navigation";
import type { ChatMessage } from "../stores/chatStore";
import { useChatStore } from "../stores/chatStore";
import { useConversationStore } from "../stores/conversationStore";
import { useSettingsStore } from "../stores/settingsStore";
import { ACTIVE_CONVERSATION_STORAGE_KEY } from "../lib/chat-workspace-storage";
import { findAutoPrepareTarget } from "../lib/chat-turns";
import {
  clearPendingChatPrompt,
  normalizePendingChatPrompt,
  readPendingChatPrompt,
  rememberPendingChatPrompt,
} from "../lib/pending-chat-prompt";
import { consumePendingConversationSearch } from "../lib/conversation-navigation";
import { consumeGuestLocalContext } from "../lib/guest-local-context";
import {
  useLocalModelReadiness,
  type LocalModelReadiness,
} from "./useLocalModelReadiness";
import { useModelUpgrade } from "./local-ai/useModelUpgrade";

function buildPromptlessChatHref(searchParams: { toString(): string }): string {
  const nextParams = new URLSearchParams(searchParams.toString());
  nextParams.delete("prompt");
  const nextSearch = nextParams.toString();
  return nextSearch ? `/chat?${nextSearch}` : "/chat";
}

function countUserMessagesWithPrompt(prompt: string): number {
  const normalizedPrompt = normalizePendingChatPrompt(prompt);
  if (!normalizedPrompt) {
    return 0;
  }

  return useChatStore
    .getState()
    .messages.filter(
      (message) =>
        message.role === "user" &&
        normalizePendingChatPrompt(message.content) === normalizedPrompt,
    ).length;
}

/** Bootstrap the settings store on mount (load encrypted settings from IndexedDB). */
function useSettingsBootstrap(): void {
  const hasLoadedSettings = useRef(false);
  useEffect(() => {
    if (hasLoadedSettings.current) return;
    hasLoadedSettings.current = true;
    useSettingsStore.getState().loadFromDB();
  }, []);
}

/** Lifetime impact query count derived from completed assistant messages. */
function useQueryCount(messages: ChatMessage[], isStreaming: boolean): number {
  const [queryCount, setQueryCount] = useState(0);

  // Compute queryCount from current messages.
  // Skipped during streaming to avoid O(n) filters on every token batch.
  const prevQueryCountRef = useRef(0);
  useEffect(() => {
    if (isStreaming) return;
    const count = messages.filter(
      (m) => m.role === "assistant" && m.status === "complete"
    ).length;
    setQueryCount(count);

    // If count increased and streaming just stopped, increment lifetime counter
    if (count > prevQueryCountRef.current && prevQueryCountRef.current >= 0) {
      const delta = count - prevQueryCountRef.current;
      for (let i = 0; i < delta; i++) {
        useSettingsStore.getState().incrementLifetimeQueryCount();
      }
    }
    prevQueryCountRef.current = count;
  }, [messages, isStreaming]);

  return queryCount;
}

type PendingPromptParams = {
  searchParams: ReadonlyURLSearchParams;
  searchPrompt: string | null;
  activeConversationId: string | null;
  conversationCount: number;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConversationReady: boolean;
  pendingConversationRestoreRef: RefObject<boolean>;
  /** Stable accessor for the workspace's send handler. */
  sendMessage: (content: string) => void;
};

/**
 * Resolves the deep-link / stored prompt, restores guest + persisted context
 * after auth round-trips, and auto-submits the pending prompt exactly once.
 */
function usePendingPrompt(params: PendingPromptParams): void {
  const {
    searchParams,
    searchPrompt,
    activeConversationId,
    conversationCount,
    messages,
    isStreaming,
    isConversationReady,
    pendingConversationRestoreRef,
    sendMessage,
  } = params;

  const composerDraft = useChatStore((s) => s.composerDraft);
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const hasLoadedSettings = useSettingsStore((s) => s.hasLoaded);

  const [pendingPrompt, setPendingPrompt] = useState<string | null>(searchPrompt);
  const [hasResolvedGuestContext, setHasResolvedGuestContext] = useState(false);
  const hasMirroredPendingPromptRef = useRef(false);
  const attemptedAutoSubmitPromptRef = useRef<string | null>(null);

  useEffect(() => {
    if (searchPrompt) {
      rememberPendingChatPrompt(searchPrompt);
      setPendingPrompt((current) => (current === searchPrompt ? current : searchPrompt));
      return;
    }

    const storedPrompt = readPendingChatPrompt();
    setPendingPrompt((current) => (current === storedPrompt ? current : storedPrompt));
  }, [searchPrompt]);

  useEffect(() => {
    if (!pendingPrompt || hasMirroredPendingPromptRef.current) {
      return;
    }

    if (composerDraft.trim().length === 0) {
      hasMirroredPendingPromptRef.current = true;
      setComposerDraft(pendingPrompt);
    }
  }, [composerDraft, pendingPrompt, setComposerDraft]);

  // Restore the last local chat context after auth round-trips or session expiry.
  // This keeps guests and expired sessions anchored to the same browser-local
  // conversation instead of reopening a blank chat after sign-in.
  const hasRestoredGuestContext = useRef(false);
  useEffect(() => {
    if (hasRestoredGuestContext.current) {
      return;
    }

    const savedContext = consumeGuestLocalContext();
    if (!savedContext) {
      hasRestoredGuestContext.current = true;
      setHasResolvedGuestContext(true);
      return;
    }

    if (
      !pendingPrompt &&
      savedContext.composerDraft &&
      composerDraft.trim().length === 0
    ) {
      setComposerDraft(savedContext.composerDraft);
    }

    if (activeConversationId) {
      hasRestoredGuestContext.current = true;
      setHasResolvedGuestContext(true);
      return;
    }

    const hasConversation = useConversationStore
      .getState()
      .conversations.some((conversation) => conversation.id === savedContext.activeConversationId);

    if (hasConversation) {
      pendingConversationRestoreRef.current = true;
      useConversationStore.getState().setActive(savedContext.activeConversationId);
    }

    hasRestoredGuestContext.current = true;
    setHasResolvedGuestContext(true);
  }, [activeConversationId, composerDraft, pendingPrompt, setComposerDraft, pendingConversationRestoreRef]);

  useEffect(() => {
    if (!hasResolvedGuestContext) {
      return;
    }

    if (!activeConversationId && typeof window !== "undefined") {
      const persistedActiveConversationId = window.localStorage.getItem(
        ACTIVE_CONVERSATION_STORAGE_KEY,
      );
      if (
        persistedActiveConversationId &&
        useConversationStore
          .getState()
          .conversations.some(
            (conversation) => conversation.id === persistedActiveConversationId,
          )
      ) {
        useConversationStore.getState().setActive(persistedActiveConversationId);
        return;
      }
    }

    if (!pendingPrompt && composerDraft.trim().length === 0) {
      useChatStore.getState().restorePersistedComposerDraft();
    }
  }, [
    activeConversationId,
    composerDraft,
    conversationCount,
    hasResolvedGuestContext,
    pendingPrompt,
  ]);

  const latestSendMessageRef = useRef(sendMessage);
  useEffect(() => {
    latestSendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const lastAutoSubmittedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !pendingPrompt ||
      isStreaming ||
      !hasLoadedSettings ||
      !hasResolvedGuestContext ||
      !isConversationReady ||
      pendingConversationRestoreRef.current
    ) {
      return;
    }

    const currentComposerDraft = useChatStore.getState().composerDraft;
    if (
      hasMirroredPendingPromptRef.current &&
      attemptedAutoSubmitPromptRef.current !== pendingPrompt &&
      currentComposerDraft !== pendingPrompt
    ) {
      clearPendingChatPrompt();
      setPendingPrompt(null);
      window.history.replaceState({}, "", buildPromptlessChatHref(searchParams));
      return;
    }

    if (lastAutoSubmittedPromptRef.current === pendingPrompt) {
      return;
    }

    const previousPromptMessageCount = countUserMessagesWithPrompt(pendingPrompt);
    attemptedAutoSubmitPromptRef.current = pendingPrompt;
    latestSendMessageRef.current(pendingPrompt);
    const nextPromptMessageCount = countUserMessagesWithPrompt(pendingPrompt);

    if (nextPromptMessageCount <= previousPromptMessageCount) {
      return;
    }

    lastAutoSubmittedPromptRef.current = pendingPrompt;
    clearPendingChatPrompt();
    setPendingPrompt(null);
    window.history.replaceState({}, "", buildPromptlessChatHref(searchParams));
  }, [
    hasLoadedSettings,
    hasResolvedGuestContext,
    isConversationReady,
    isStreaming,
    pendingPrompt,
    searchParams,
    pendingConversationRestoreRef,
  ]);

  // The messages dependency only matters via countUserMessagesWithPrompt above,
  // which reads the live store; this keeps the auto-submit guard fresh without
  // re-running on every token batch.
  void messages;
}

/** In-conversation search open state, driven by Cmd/Ctrl+F and window events. */
function useConversationSearch(activeConversationId: string | null): {
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
} {
  const [searchOpen, setSearchOpen] = useState(false);

  // Cmd+F / Ctrl+F opens in-conversation search
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    function handleOpenConversationSearch() {
      setSearchOpen(true);
    }

    window.addEventListener("openConversationSearch", handleOpenConversationSearch);
    return () => window.removeEventListener("openConversationSearch", handleOpenConversationSearch);
  }, []);

  // Reset search on conversation switch (and new-chat clear). Declared before
  // the pending-search effect below so a queued search re-opens afterwards,
  // matching the original effect ordering.
  useEffect(() => {
    setSearchOpen(false);
  }, [activeConversationId]);

  useEffect(() => {
    if (!activeConversationId) {
      return;
    }

    if (consumePendingConversationSearch()) {
      setSearchOpen(true);
    }
  }, [activeConversationId]);

  return { searchOpen, setSearchOpen };
}

export type ChatPageEffectsParams = {
  searchParams: ReadonlyURLSearchParams;
  searchPrompt: string | null;
  activeConversationId: string | null;
  conversationCount: number;
  messages: ChatMessage[];
  isStreaming: boolean;
  isConversationReady: boolean;
  pendingConversationRestoreRef: RefObject<boolean>;
  sendMessage: (content: string) => void;
};

export type ChatPageEffects = LocalModelReadiness & {
  queryCount: number;
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
};

/**
 * Ambient chat-page effects extracted from the workspace orchestrator: local
 * model readiness, settings bootstrap, impact query count, in-conversation
 * search, and the pending-prompt / guest-context restore pipeline.
 * Conversation load/sync effects stay in the orchestrator since they are
 * tightly bound to its message-sync refs.
 */
export function useChatPageEffects(params: ChatPageEffectsParams): ChatPageEffects {
  const readiness = useLocalModelReadiness();

  // A send that resolved to a not-ready slot writes a readiness error card
  // (kind "prepare-local-model"). Sending IS the intent to use that model, and
  // the setup gate already resumes the bound pick's interrupted download
  // without a separate tap — so run the card's own driver automatically
  // instead of parking the person on a button. The driver no-ops if the slot
  // is ready or a prepare is already running, and once the slot flips ready
  // the invisible readiness retry sends the held message itself: type → send
  // → "Preparing…" → the answer arrives, no extra taps. Keyed per card id so
  // a prepare that fails never loops.
  const autoPreparedCardIdsRef = useRef<Set<string>>(new Set());
  const prepareDriver = readiness.handlePrepareLocalModel;
  const autoPrepareTarget = findAutoPrepareTarget(params.messages);
  useEffect(() => {
    if (!autoPrepareTarget) return;
    if (autoPreparedCardIdsRef.current.has(autoPrepareTarget.id)) return;
    autoPreparedCardIdsRef.current.add(autoPrepareTarget.id);
    prepareDriver(autoPrepareTarget.modelId);
  }, [autoPrepareTarget, prepareDriver]);
  // The pull machine's single driver: it resumes an interrupted download and
  // restores the "ready, switch now" affordance, and it starts only once the
  // chat is ready on a local model so it never competes with first-run setup.
  useModelUpgrade({ enabled: readiness.localModelReady });
  useSettingsBootstrap();
  const queryCount = useQueryCount(params.messages, params.isStreaming);
  const { searchOpen, setSearchOpen } = useConversationSearch(params.activeConversationId);

  usePendingPrompt({
    searchParams: params.searchParams,
    searchPrompt: params.searchPrompt,
    activeConversationId: params.activeConversationId,
    conversationCount: params.conversationCount,
    messages: params.messages,
    isStreaming: params.isStreaming,
    isConversationReady: params.isConversationReady,
    pendingConversationRestoreRef: params.pendingConversationRestoreRef,
    sendMessage: params.sendMessage,
  });

  return {
    ...readiness,
    queryCount,
    searchOpen,
    setSearchOpen,
  };
}
