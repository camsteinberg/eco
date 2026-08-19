// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { interruptActiveGeneration } from "./useChat";
import { useChatStore } from "../stores/chatStore";
import type { ChatMessage } from "../stores/chatStore";
import { useConversationStore } from "../stores/conversationStore";
import {
  openEcoDB,
  toDbMessage,
  addReactionToMessage,
  removeReactionFromMessage,
} from "../lib/db";
import type { DbMessage, MessageReaction } from "../lib/db";
import type { AssistantReplyControl } from "../components/chat/MessageActions";
import type { RegenerateOverrides } from "./useChat";
import {
  canDeepen,
  REPLY_CONTROL_TREATMENTS,
  SHORTER_MIN_COMPLETION_TOKENS,
} from "../lib/reply-controls";
import { resolveActiveModelId } from "../lib/active-model";
import { requestOpenShareConversation } from "../lib/share-conversation-event";
import { useScrollToMessage } from "./useScrollToMessage";

// Non-printable separators (U+0001 field, U+0002 record) avoid collisions
// between message content and the delimiters used to build the sync signature.
const SYNC_FIELD_SEPARATOR = String.fromCharCode(1);
const SYNC_RECORD_SEPARATOR = String.fromCharCode(2);

function getMessageSyncSignature(messages: ChatMessage[]): string {
  return messages
    .map((message) =>
      [
        message.id,
        message.role,
        message.content,
        message.parentId ?? "",
        message.status ?? "",
        message.errorMessage ?? "",
        message.streamInterrupted ? "1" : "0",
        message.offlineDivider ? "1" : "0",
        message.inferenceMethod ?? "",
      ].join(SYNC_FIELD_SEPARATOR),
    )
    .join(SYNC_RECORD_SEPARATOR);
}

/**
 * The one control that is still a TURN rather than a regenerate.
 *
 * Continuation needs the partial reply sitting in the history for the model to
 * carry on from, and true assistant-prefix continuation does not exist in this
 * codebase — the shim accepts a `continueFinalMessage` flag for caller-shape
 * parity and does not consume it. So this stays a canned turn on purpose.
 */
const CONTINUE_TURN = "Continue your previous answer.";

type ConversationManagerParams = {
  /** Live messages from useChat. */
  messages: ChatMessage[];
  isStreaming: boolean;
  activeConversationId: string | null;
  activeConversationLeafId: string | null;
  sendMessage: (content: string) => void;
  editMessage: (id: string, content: string) => void;
  regenerateMessage: (id: string, overrides?: RegenerateOverrides) => void;
  clearComposerDraft: () => void;
};

export type ConversationManager = {
  allMessages: DbMessage[];
  reactionsMap: Map<string, MessageReaction[]>;
  editingMessageId: string | null;
  isConversationReady: boolean;
  /** Set while a conversation restore is in flight (auto-submit guard). */
  pendingConversationRestoreRef: RefObject<boolean>;
  handleSendMessage: (content: string) => void;
  handleShareConversation: () => Promise<void>;
  handleNavigateBranch: (messageId: string, direction: "prev" | "next") => Promise<void>;
  handleReact: (messageId: string, emoji: string) => Promise<void>;
  handleRemoveReaction: (messageId: string, emoji: string) => Promise<void>;
  handleStartEdit: (id: string) => void;
  handleSaveEdit: (id: string, content: string) => void;
  handleCancelEdit: () => void;
  handleRegenerate: (id: string) => void;
  handleAssistantAction: (messageId: string, action: AssistantReplyControl) => void;
};

/**
 * Owns conversation persistence and the message-list interaction surface:
 * loading the active conversation from IndexedDB, syncing it back when
 * streaming stops, branch navigation, reactions, edit/regenerate, sharing, and
 * the scroll-to-message behavior. Lifted out of ChatWorkspace because all of
 * these share the same snapshot / sync refs.
 */
export function useConversationManager(
  params: ConversationManagerParams,
): ConversationManager {
  const {
    messages,
    isStreaming,
    activeConversationId,
    activeConversationLeafId,
    sendMessage,
    editMessage,
    regenerateMessage,
    clearComposerDraft,
  } = params;

  const prevActiveIdRef = useRef<string | null>(null);
  const prevActiveLeafIdRef = useRef<string | null>(null);
  const displayedConversationIdRef = useRef<string | null>(null);
  const conversationSnapshotsRef = useRef<Map<string, ChatMessage[]>>(new Map());
  const skipNextLoadedConversationSyncRef = useRef<{
    conversationId: string;
    signature: string;
  } | null>(null);
  const workspaceLoadRequestRef = useRef(0);
  const [isConversationReady, setIsConversationReady] = useState(true);
  const pendingConversationRestoreRef = useRef(false);

  const rememberConversationSnapshot = useCallback(
    (conversationId: string | null, snapshot: ChatMessage[]) => {
      if (!conversationId) {
        return;
      }

      if (snapshot.length === 0) {
        conversationSnapshotsRef.current.delete(conversationId);
        return;
      }

      conversationSnapshotsRef.current.set(
        conversationId,
        snapshot.map((message) => ({
          ...message,
          ...(message.citations ? { citations: [...message.citations] } : {}),
        })),
      );
    },
    [],
  );

  // State for edit mode and branch navigation
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [allMessages, setAllMessages] = useState<DbMessage[]>([]);
  const [reactionsMap, setReactionsMap] = useState<Map<string, MessageReaction[]>>(new Map());

  /**
   * Load ALL messages for the current conversation from IndexedDB.
   * This is needed for sibling computation in branch navigation.
   */
  const loadAllMessages = useCallback(async (conversationId: string, requestId?: number) => {
    // A load is stale once a newer request superseded it or the active
    // conversation changed out from under it; staleness skips the state write.
    const isStale = () =>
      requestId !== undefined
      && (
        requestId !== workspaceLoadRequestRef.current
        || useConversationStore.getState().activeConversationId !== conversationId
      );
    try {
      const db = await openEcoDB();
      const msgs = await db.getAllFromIndex("messages", "by-conversation", conversationId);
      if (isStale()) return;
      setAllMessages(msgs);
    } catch {
      if (isStale()) return;
      setAllMessages([]);
    }
  }, []);

  // Extract reactions from allMessages into a Map for the MessageList
  useEffect(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const msg of allMessages) {
      if (msg.reactions && msg.reactions.length > 0) {
        map.set(msg.id, msg.reactions);
      }
    }
    setReactionsMap(map);
  }, [allMessages]);

  const handleReact = useCallback(async (messageId: string, emoji: string) => {
    try {
      await addReactionToMessage(messageId, emoji);
      setReactionsMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(messageId) ?? [];
        if (!existing.some((r) => r.emoji === emoji)) {
          next.set(messageId, [...existing, { emoji, timestamp: Date.now() }]);
        }
        return next;
      });
    } catch {
      // IndexedDB write failed — skip optimistic update
    }
  }, []);

  const handleRemoveReaction = useCallback(async (messageId: string, emoji: string) => {
    try {
      await removeReactionFromMessage(messageId, emoji);
      setReactionsMap((prev) => {
        const next = new Map(prev);
        const existing = next.get(messageId) ?? [];
        next.set(messageId, existing.filter((r) => r.emoji !== emoji));
        return next;
      });
    } catch {
      // IndexedDB write failed — skip optimistic update
    }
  }, []);

  // When the active conversation changes, load its messages from IndexedDB.
  useEffect(() => {
    const previousActiveConversationId = prevActiveIdRef.current;
    const previousActiveLeafId = prevActiveLeafIdRef.current;
    const conversationChanged = activeConversationId !== previousActiveConversationId;

    if (
      activeConversationId === previousActiveConversationId
      && activeConversationLeafId === previousActiveLeafId
    ) {
      return;
    }

    // Claim the request id only once this pass has committed to loading.
    // Bumping it above the guard would let a no-op pass — StrictMode's second
    // invocation, whose refs the first pass already updated — invalidate the
    // load still in flight from the first, restoring a blank pane in dev.
    const requestId = ++workspaceLoadRequestRef.current;

    if (conversationChanged && useChatStore.getState().isStreaming) {
      interruptActiveGeneration();
    }

    // Save current chat messages to IndexedDB for the previous conversation before switching.
    if (
      conversationChanged
      && previousActiveConversationId
      && displayedConversationIdRef.current === previousActiveConversationId
    ) {
      const currentMessages = useChatStore.getState().messages;
      if (currentMessages.length > 0) {
        rememberConversationSnapshot(previousActiveConversationId, currentMessages);
        const convStore = useConversationStore.getState();
        for (const m of currentMessages) {
          convStore.saveMessage(toDbMessage(m, previousActiveConversationId));
        }
        // Update activeLeafId to the last message
        const lastMsg = currentMessages[currentMessages.length - 1];
        if (lastMsg) {
          convStore.updateConversation(previousActiveConversationId, { activeLeafId: lastMsg.id });
        }
      }
    }

    prevActiveIdRef.current = activeConversationId;
    prevActiveLeafIdRef.current = activeConversationLeafId;

    // Keep the live branch in memory while it is still streaming.
    // Rehydrating the same conversation mid-stream can hide the stop control
    // and overwrite partial tokens with the last persisted snapshot.
    if (!conversationChanged && useChatStore.getState().isStreaming) {
      return;
    }

    if (activeConversationId === null) {
      // New chat -- clear messages.
      displayedConversationIdRef.current = null;
      skipNextLoadedConversationSyncRef.current = null;
      pendingConversationRestoreRef.current = false;
      setIsConversationReady(true);
      useChatStore.getState().clearMessages({ preserveComposerDraft: true });
      setAllMessages([]);
      setEditingMessageId(null);
      return;
    }

    // Load messages from IndexedDB for the target conversation.
    pendingConversationRestoreRef.current = true;
    setIsConversationReady(false);
    useConversationStore.getState().loadConversationMessages(activeConversationId)
      .then((chatMessages) => {
        if (
          requestId !== workspaceLoadRequestRef.current
          || useConversationStore.getState().activeConversationId !== activeConversationId
        ) {
          return;
        }

        displayedConversationIdRef.current = activeConversationId;
        if (chatMessages.length > 0) {
          rememberConversationSnapshot(activeConversationId, chatMessages as ChatMessage[]);
          skipNextLoadedConversationSyncRef.current = {
            conversationId: activeConversationId,
            signature: getMessageSyncSignature(chatMessages as ChatMessage[]),
          };
          useChatStore.getState().setMessages(chatMessages as ChatMessage[]);
        } else {
          const rememberedSnapshot =
            activeConversationLeafId !== null
              ? conversationSnapshotsRef.current.get(activeConversationId) ?? null
              : null;

          if (rememberedSnapshot && rememberedSnapshot.length > 0) {
            skipNextLoadedConversationSyncRef.current = {
              conversationId: activeConversationId,
              signature: getMessageSyncSignature(rememberedSnapshot),
            };
            useChatStore.getState().setMessages(rememberedSnapshot);
            setAllMessages(
              rememberedSnapshot.map((message) =>
                toDbMessage(message, activeConversationId),
              ),
            );
            return;
          }

          useChatStore.getState().clearMessages();
        }
      })
      .finally(() => {
        if (
          requestId !== workspaceLoadRequestRef.current
          || useConversationStore.getState().activeConversationId !== activeConversationId
        ) {
          return;
        }
        pendingConversationRestoreRef.current = false;
        setIsConversationReady(true);
      });

    // Also load all messages for branch navigation
    loadAllMessages(activeConversationId, requestId);
    if (conversationChanged) {
      setEditingMessageId(null);
    }
  }, [activeConversationId, activeConversationLeafId, loadAllMessages, rememberConversationSnapshot]);

  // Sync chat messages back to IndexedDB whenever streaming stops.
  useEffect(() => {
    if (isStreaming) return;
    const convId = useConversationStore.getState().activeConversationId;
    if (!convId) return;
    if (pendingConversationRestoreRef.current) return;
    if (displayedConversationIdRef.current !== convId) return;
    const currentMessages = useChatStore.getState().messages;
    if (currentMessages.length > 0) {
      const currentSignature = getMessageSyncSignature(currentMessages);
      const pendingLoadedSync = skipNextLoadedConversationSyncRef.current;
      if (
        pendingLoadedSync
        && pendingLoadedSync.conversationId === convId
        && pendingLoadedSync.signature === currentSignature
      ) {
        skipNextLoadedConversationSyncRef.current = null;
        return;
      }

      skipNextLoadedConversationSyncRef.current = null;
      const convStore = useConversationStore.getState();
      for (const m of currentMessages) {
        convStore.saveMessage(toDbMessage(m, convId));
      }
      // Update activeLeafId to the last message
      const lastMsg = currentMessages[currentMessages.length - 1];
      if (lastMsg) {
        convStore.updateConversation(convId, { activeLeafId: lastMsg.id });
      }
      rememberConversationSnapshot(convId, currentMessages);
      // Reload all messages so sibling info is up-to-date after edit/regenerate
      loadAllMessages(convId);
    }
  }, [isStreaming, messages, loadAllMessages, rememberConversationSnapshot]);

  const handleShareConversation = useCallback(async () => {
    const convId = useConversationStore.getState().activeConversationId;
    const currentMessages = useChatStore.getState().messages;

    if (
      convId
      && currentMessages.length > 0
      && displayedConversationIdRef.current === convId
    ) {
      const convStore = useConversationStore.getState();
      await Promise.all(currentMessages.map((message) =>
        convStore.saveMessage(toDbMessage(message, convId)),
      ));

      const lastMessage = currentMessages[currentMessages.length - 1];
      if (lastMessage) {
        convStore.updateConversation(convId, { activeLeafId: lastMessage.id });
      }
      rememberConversationSnapshot(convId, currentMessages);
    }

    requestOpenShareConversation();
  }, [rememberConversationSnapshot]);

  const handleSendMessage = useCallback(
    (content: string) => {
      const trimmedContent = content.trim();
      if (!trimmedContent || isStreaming) {
        return;
      }

      const convStore = useConversationStore.getState();
      if (convStore.activeConversationId === null) {
        const title =
          trimmedContent.length > 50 ? trimmedContent.slice(0, 50) + "..." : trimmedContent;
        const preview =
          trimmedContent.length > 60 ? trimmedContent.slice(0, 60) : trimmedContent;
        const now = Date.now();
        const id = crypto.randomUUID();
        convStore.addConversation({
          id,
          title,
          createdAt: now,
          updatedAt: now,
          activeLeafId: null,
          preview,
        });
        // Sync the ref so the activeConversationId effect doesn't clear
        // the messages that sendMessage() is about to add.
        prevActiveIdRef.current = id;
        displayedConversationIdRef.current = id;
      }
      clearComposerDraft();
      sendMessage(trimmedContent);
    },
    [clearComposerDraft, isStreaming, sendMessage]
  );

  const handleStartEdit = useCallback((id: string) => {
    setEditingMessageId(id);
  }, []);

  const handleSaveEdit = useCallback(
    (id: string, content: string) => {
      setEditingMessageId(null);
      editMessage(id, content);
    },
    [editMessage]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
  }, []);

  const handleRegenerate = useCallback(
    (id: string) => {
      regenerateMessage(id);
    },
    [regenerateMessage]
  );

  /**
   * Run one per-reply control.
   *
   * `continue` sends a turn. The other three REGENERATE the target reply as a
   * sibling with a forced intent and a model-facing directive, so the control
   * changes what the model is asked for instead of asking the model a new
   * question about its own last answer — which is what made "shorter",
   * "expand" and "simplify" the same request.
   */
  const handleAssistantAction = useCallback(
    (messageId: string, action: AssistantReplyControl) => {
      // Mid-stream every control is a no-op. `handleSendMessage` and
      // `regenerateMessage` each refuse independently; stating it once here is
      // what makes that visible at the layer the user is pressing.
      if (isStreaming) return;

      if (action === "continue") {
        handleSendMessage(CONTINUE_TURN);
        return;
      }

      // Read the live reply, not the persisted copy: `possiblyTruncated` and
      // `localCompletionTokens` are written to the chat store on completion and
      // are NOT carried by `toDbMessage`, so a reply restored from IndexedDB
      // has neither. Both guards below therefore fail OPEN on absence.
      const target = useChatStore.getState().messages.find((m) => m.id === messageId);

      if (action === "expand") {
        // A reply that stopped at its ceiling has more to say, not less depth.
        // Continuing adds to what the user already read; regenerating would
        // throw it away and very likely hit the same ceiling again.
        if (target?.possiblyTruncated === true) {
          handleSendMessage(CONTINUE_TURN);
          return;
        }
        // On a model whose budget does not move between intents, asking for
        // depth cannot buy any. Silent no-op until the control is presented
        // conditionally in the UI.
        if (!canDeepen(resolveActiveModelId())) return;
      }

      if (
        action === "shorter"
        && target?.localCompletionTokens !== undefined
        && target.localCompletionTokens < SHORTER_MIN_COMPLETION_TOKENS
      ) {
        return;
      }

      const { intent, directive } = REPLY_CONTROL_TREATMENTS[action];
      regenerateMessage(messageId, { intent, turnDirective: directive });
    },
    [handleSendMessage, isStreaming, regenerateMessage],
  );

  const handleNavigateBranch = useCallback(
    async (_messageId: string, _direction: "prev" | "next") => {
      // The useBranchNavigation hook in MessageList handles updating activeLeafId
      // in the conversation store. After it updates, we reload the active branch.
      const convId = useConversationStore.getState().activeConversationId;
      if (!convId) return;

      // Wait for the store update to propagate
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Reload the active branch from IndexedDB
      const chatMessages = await useConversationStore.getState().loadConversationMessages(convId);
      if (chatMessages.length > 0) {
        useChatStore.getState().setMessages(chatMessages as ChatMessage[]);
      }
      // Reload all messages for updated sibling info
      await loadAllMessages(convId);
    },
    [loadAllMessages]
  );

  // Scroll-to-message support (triggered by search result selection / focus).
  useScrollToMessage(activeConversationId, messages);

  return {
    allMessages,
    reactionsMap,
    editingMessageId,
    isConversationReady,
    pendingConversationRestoreRef,
    handleSendMessage,
    handleShareConversation,
    handleNavigateBranch,
    handleReact,
    handleRemoveReaction,
    handleStartEdit,
    handleSaveEdit,
    handleCancelEdit,
    handleRegenerate,
    handleAssistantAction,
  };
}
