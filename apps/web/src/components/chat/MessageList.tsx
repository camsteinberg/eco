// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import type { KeyboardEvent, TouchEvent, WheelEvent } from "react";
import { MessageBubble } from "./MessageBubble";
import type { LocalModelPrepareState } from "./ErrorMessage";
import type { AssistantReplyControl } from "./MessageActions";
import { ContextDivider } from "./ContextDivider";
import { FlagFailureDialog } from "./FlagFailureDialog";
import { isCaptureEnabled } from "../../lib/dev-capture";
import { useBranchNavigation } from "../../hooks/useBranchNavigation";
import type { ChatMessage, StreamPhase } from "../../stores/chatStore";
import type { DbMessage, MessageReaction } from "../../lib/db";
import type { ToolCallDisplay } from "../../lib/tool-parser";

type MessageListProps = {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamPhase?: StreamPhase;
  onRetry?: (messageId: string) => void;
  /** All messages in the conversation (for sibling computation). */
  allMessages?: DbMessage[];
  /** Currently displayed branch path. */
  activeBranch?: ChatMessage[];
  /** ID of the message currently being edited, or null. */
  editingMessageId?: string | null;
  /** Called when user clicks the edit button on a message. */
  onStartEdit?: (id: string) => void;
  /** Called when user saves an edit. */
  onSaveEdit?: (id: string, content: string) => void;
  /** Called when user cancels editing. */
  onCancelEdit?: () => void;
  /** Called when user clicks regenerate on an assistant message. */
  onRegenerate?: (id: string) => void;
  /** Called when user chooses a premium follow-up action on an assistant message. */
  onAssistantAction?: (messageId: string, action: AssistantReplyControl) => void;
  /** Called when user navigates between branch siblings. */
  onNavigateBranch?: (messageId: string, direction: "prev" | "next") => void;
  /** Index in messages where the context divider should appear, or -1 for none. */
  contextDividerIndex?: number;
  /** Active tool calls for the current streaming response. */
  activeToolCalls?: ToolCallDisplay[];
  /** Map from message ID to its reactions array. */
  reactions?: Map<string, MessageReaction[]>;
  /** Called when user clicks a reaction emoji on a message. */
  onReact?: (messageId: string, emoji: string) => void;
  /** Called when user removes a reaction emoji from a message. */
  onRemoveReaction?: (messageId: string, emoji: string) => void;
  /** Current conversation ID, passed to MessageBubble for per-conversation tooltips. */
  conversationId?: string;
  /** Called when user clicks the re-ask CTA on a low-confidence local response. */
  onReask?: (messageId: string) => void;
  /** Called when user prepares a model from a local readiness error. */
  onPrepareLocalModel?: (modelId: string) => void;
  getLocalPrepareState?: (modelId: string) => LocalModelPrepareState;
};

export function MessageList({
  messages,
  isStreaming,
  streamPhase,
  onRetry,
  allMessages,
  activeBranch,
  editingMessageId,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onRegenerate,
  onAssistantAction,
  onNavigateBranch,
  contextDividerIndex = -1,
  activeToolCalls,
  reactions,
  onReact,
  onRemoveReaction,
  conversationId,
  onReask,
  onPrepareLocalModel,
  getLocalPrepareState,
}: MessageListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Failure-capture loop (dev-gated): which assistant message is being flagged.
  // The gate is read once per mount — the ?eco-capture param syncs a sticky
  // flag in ChatPageClient before this list renders.
  const [captureEnabled] = useState(() => isCaptureEnabled());
  const [flagTargetId, setFlagTargetId] = useState<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);

  // Track messages that existed when the conversation first loaded.
  // Any message NOT in this set appeared during the session and should animate.
  const sessionStartIdsRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);

  // Capture initial message IDs on first non-empty render
  const captureInitialIds = useCallback(() => {
    if (!initializedRef.current && messages.length > 0) {
      const ids = new Set<string>();
      for (const msg of messages) {
        ids.add(msg.id);
      }
      sessionStartIdsRef.current = ids;
      initializedRef.current = true;
    }
  }, [messages]);

  useEffect(() => {
    captureInitialIds();
  }, [captureInitialIds]);

  // Reset tracking when conversation changes (messages go to empty then repopulate)
  const prevLengthRef = useRef(messages.length);
  useEffect(() => {
    if (prevLengthRef.current > 0 && messages.length === 0) {
      // Conversation switched -- reset for next load
      initializedRef.current = false;
      sessionStartIdsRef.current = new Set();
    }
    prevLengthRef.current = messages.length;
  }, [messages.length]);

  // Use branch navigation hook to compute sibling info
  const { siblingInfo, navigateToBranch } = useBranchNavigation(
    allMessages ?? [],
    activeBranch ?? messages
  );

  const isNearBottom = useCallback((thresholdPx = 180) => {
    const el = parentRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= thresholdPx;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    previousScrollTopRef.current = el.scrollTop;
  }, []);

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;

    const previousScrollTop = previousScrollTopRef.current;
    const isScrollingUp = el.scrollTop < previousScrollTop - 2;
    const nearBottom = isNearBottom();

    if (isStreaming && isScrollingUp) {
      shouldStickToBottomRef.current = false;
    } else if (nearBottom) {
      shouldStickToBottomRef.current = true;
    }

    previousScrollTopRef.current = el.scrollTop;
  }, [isNearBottom, isStreaming]);

  const pauseAutoFollow = useCallback(() => {
    if (isStreaming) {
      shouldStickToBottomRef.current = false;
    }
  }, [isStreaming]);

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < -2) {
      pauseAutoFollow();
    }
  }, [pauseAutoFollow]);

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const startY = touchStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY != null && currentY != null && currentY > startY + 4) {
      pauseAutoFollow();
    }
  }, [pauseAutoFollow]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (
      event.key === "ArrowUp"
      || event.key === "PageUp"
      || event.key === "Home"
      || (event.key === " " && event.shiftKey)
    ) {
      pauseAutoFollow();
    }
  }, [pauseAutoFollow]);

  // Auto-scroll to bottom only when the user is already following the latest
  // reply; do not fight manual scrollback.
  useEffect(() => {
    const latestMessage = messages.at(-1);
    if (latestMessage?.role === "user") {
      shouldStickToBottomRef.current = true;
    }
    if (messages.length > 0 && shouldStickToBottomRef.current) {
      scrollToBottom();
    }
  }, [messages, messages.length, scrollToBottom]);

  // Keep the latest answer anchored after returning to a hidden tab.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        requestAnimationFrame(() => {
          if (messages.length > 0 && shouldStickToBottomRef.current) {
            scrollToBottom();
          }
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [messages.length, scrollToBottom]);

  // Find the latest assistant message
  const lastAssistantId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "assistant") return messages[i]!.id;
    }
    return null;
  })();
  // The FIRST assistant message in the conversation carrying a grounded (sourced)
  // citation — the ONLY message the once-per-chat grounding notice attaches to, so
  // it no longer reappears under every subsequent grounded reply. Mirrors the
  // lastAssistantId inline scan; same `!!c.source` test the chip/notice key on.
  const firstGroundedAssistantId = (() => {
    for (const m of messages) {
      if (m.role === "assistant" && m.citations?.some((c) => !!c.source)) return m.id;
    }
    return null;
  })();
  const precedingUserPrompts = new Map<string, string>();
  let latestUserPrompt: string | undefined;

  for (const message of messages) {
    if (message.role === "user") {
      latestUserPrompt = message.content;
      continue;
    }

    if (message.role === "assistant" && latestUserPrompt) {
      precedingUserPrompts.set(message.id, latestUserPrompt);
    }
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto overscroll-contain"
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onKeyDown={handleKeyDown}
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-atomic="false"
      aria-label="Chat messages"
      tabIndex={0}
      style={{ overflowAnchor: "none" }}
    >
      <div className="flex flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <p className="sr-only" role="status" aria-live="polite">
          {isStreaming
            ? `Assistant response ${streamPhase ? `${streamPhase.replace(/-/g, " ")}` : "streaming"}`
            : messages.length > 0
              ? `${messages.length} chat ${messages.length === 1 ? "message" : "messages"}`
              : "No chat messages yet"}
        </p>
        {messages.map((msg, index) => {

          const isLastAssistant = msg.id === lastAssistantId;
          const isEditing = editingMessageId === msg.id;
          const msgSiblingInfo = siblingInfo.get(msg.id);
          const isNewMessage = initializedRef.current && !sessionStartIdsRef.current.has(msg.id);

          const showDivider = contextDividerIndex >= 0 && index === contextDividerIndex;

          return (
            <div
              key={msg.id}
              data-index={index}
              data-message-id={msg.id}
              data-message-role={msg.role}
            >
              {showDivider && <ContextDivider />}
              <MessageBubble
                role={msg.role}
                content={msg.content}
                timestamp={msg.createdAt}
                isStreaming={isLastAssistant && isStreaming}
                streamPhase={isLastAssistant && isStreaming ? streamPhase : undefined}
                isNew={isNewMessage}
                status={msg.status}
                errorMessage={msg.errorMessage}
                onRetry={onRetry ? () => onRetry(msg.id) : undefined}
                localReadiness={msg.localReadiness}
                localPrepareState={
                  msg.localReadiness ? getLocalPrepareState?.(msg.localReadiness.modelId) : undefined
                }
                onPrepareLocalModel={onPrepareLocalModel}
                tokenCount={msg.tokenCount}
                streamStartTime={msg.streamStartTime}
                siblingInfo={
                  msgSiblingInfo && msgSiblingInfo.total > 1
                    ? { currentIndex: msgSiblingInfo.currentIndex, total: msgSiblingInfo.total }
                    : undefined
                }
                onNavigatePrev={
                  onNavigateBranch
                    ? () => {
                        navigateToBranch(msg.id, "prev");
                        onNavigateBranch(msg.id, "prev");
                      }
                    : undefined
                }
                onNavigateNext={
                  onNavigateBranch
                    ? () => {
                        navigateToBranch(msg.id, "next");
                        onNavigateBranch(msg.id, "next");
                      }
                    : undefined
                }
                onEdit={
                  onStartEdit && msg.role === "user"
                    ? () => onStartEdit(msg.id)
                    : undefined
                }
                onRegenerate={
                  onRegenerate && isLastAssistant
                    ? () => onRegenerate(msg.id)
                    : undefined
                }
                onAssistantAction={
                  onAssistantAction && isLastAssistant
                    ? (action) => onAssistantAction(msg.id, action)
                    : undefined
                }
                isLatestAssistant={isLastAssistant}
                isFirstGrounded={msg.id === firstGroundedAssistantId}
                onFlagForEval={
                  captureEnabled &&
                  msg.role === "assistant" &&
                  msg.content.trim().length > 0 &&
                  (msg.status === undefined || msg.status === "complete") &&
                  !(isLastAssistant && isStreaming)
                    ? () => setFlagTargetId(msg.id)
                    : undefined
                }
                toolCalls={isLastAssistant ? activeToolCalls : undefined}
                streamInterrupted={msg.streamInterrupted}
                interruptedReason={msg.interruptedReason}
                possiblyTruncated={msg.possiblyTruncated}
                localCompletionTokens={msg.localCompletionTokens}
                resolvedModel={msg.resolvedModel}
                inferenceMethod={msg.inferenceMethod}
                confidence={msg.confidence}
                offlineDivider={msg.offlineDivider}
                citations={msg.citations}
                verification={msg.verification}
                canonicalToolAnswer={msg.canonicalToolAnswer}
                onReask={onReask ? () => onReask(msg.id) : undefined}
                promptContent={precedingUserPrompts.get(msg.id)}
                conversationId={conversationId}
                isEditing={isEditing}
                onSaveEdit={
                  onSaveEdit
                    ? (content: string) => onSaveEdit(msg.id, content)
                    : undefined
                }
                onCancelEdit={onCancelEdit}
                reactions={reactions?.get(msg.id)}
                onReact={onReact ? (emoji: string) => onReact(msg.id, emoji) : undefined}
                onRemoveReaction={onRemoveReaction ? (emoji: string) => onRemoveReaction(msg.id, emoji) : undefined}
              />
            </div>
          );
        })}
        <div ref={bottomRef} aria-hidden="true" className="h-px w-full" />
      </div>
      {flagTargetId !== null && (
        <FlagFailureDialog
          // Keyed by target so reflagging a different message resets the form.
          key={flagTargetId}
          open
          failingMessageId={flagTargetId}
          messages={messages}
          onClose={() => setFlagTargetId(null)}
        />
      )}
    </div>
  );
}
