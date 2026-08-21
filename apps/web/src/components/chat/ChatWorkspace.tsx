// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useCallback, useState } from "react";
import type { DragEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useChat } from "../../hooks/useChat";
import { useChatPageEffects } from "../../hooks/useChatPageEffects";
import { useConversationManager } from "../../hooks/useConversationManager";
import { ChatSurface } from "./ChatSurface";
import { useChatStore } from "../../stores/chatStore";
import { useConversationStore } from "../../stores/conversationStore";
import {
  validateFile,
  extractText,
  buildMessageWithFiles,
} from "../../lib/file-extract";
import type { FileExtractionResult } from "../../lib/file-extract";
import { OnboardingTour } from "../onboarding/OnboardingTour";
import { LocalInferenceErrorBoundary } from "./LocalInferenceErrorBoundary";
import { ValidationHarnessCrashSentinel } from "./ValidationHarnessCrashSentinel";
import { normalizePendingChatPrompt } from "../../lib/pending-chat-prompt";
import { attachValidationError, attachReadError } from "../../lib/attachment-errors";

export function ChatWorkspace() {
  const { messages, isStreaming, streamPhase, error, sendMessage, editMessage, regenerateMessage, retryMessage, contextDividerIndex, activeToolCalls, stopGeneration } = useChat();
  const clearComposerDraft = useChatStore((s) => s.clearComposerDraft);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);
  const activeConversationLeafId = useConversationStore((s) => {
    const activeConversation = s.conversations.find(
      (conversation) => conversation.id === s.activeConversationId,
    );
    return activeConversation?.activeLeafId ?? null;
  });
  const conversationCount = useConversationStore((s) => s.conversations.length);
  const searchParams = useSearchParams();
  const searchPrompt = normalizePendingChatPrompt(searchParams.get("prompt"));

  const {
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
  } = useConversationManager({
    messages,
    isStreaming,
    activeConversationId,
    activeConversationLeafId,
    sendMessage,
    editMessage,
    regenerateMessage,
    clearComposerDraft,
  });

  const handleSubmitWithFiles = useCallback(
    (text: string, files: FileExtractionResult[]) => {
      const combined = buildMessageWithFiles(text, files);
      handleSendMessage(combined);
    },
    [handleSendMessage]
  );

  // Drag-and-drop state: counter tracks nested dragenter/dragleave events
  const [dragCounter, setDragCounter] = useState(0);
  const [droppedAttachmentError, setDroppedAttachmentError] = useState<string | null>(null);
  const isDragging = dragCounter > 0;

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragCounter((c) => c + 1);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragCounter((c) => Math.max(0, c - 1));
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragCounter(0);
      const droppedFiles = e.dataTransfer.files;
      if (!droppedFiles || droppedFiles.length === 0) return;
      setDroppedAttachmentError(null);

      const { addFileAttachment, updateFileAttachment } = useChatStore.getState();

      Array.from(droppedFiles).forEach(async (file) => {
        const validationError = validateFile(file);
        if (validationError) {
          setDroppedAttachmentError(attachValidationError(validationError.filename, validationError.error));
          return;
        }

        const id = addFileAttachment(file);
        updateFileAttachment(id, { status: "reading" });

        try {
          updateFileAttachment(id, { status: "extracting" });
          const result = await extractText(file);
          updateFileAttachment(id, { status: "done", result });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Extraction failed";
          updateFileAttachment(id, { status: "error", errorMessage: message });
          setDroppedAttachmentError(attachReadError(file.name, message));
        }
      });
    },
    []
  );

  const {
    localModelReady,
    showBatteryReducedNotice,
    validationProtectionBanner,
    validationSelectedModelBanner,
    handlePrepareLocalModel,
    getLocalPrepareState,
    queryCount,
    searchOpen,
    setSearchOpen,
  } = useChatPageEffects({
    searchParams,
    searchPrompt,
    activeConversationId,
    conversationCount,
    messages,
    isStreaming,
    isConversationReady,
    pendingConversationRestoreRef,
    sendMessage: handleSendMessage,
  });

  return (
    <LocalInferenceErrorBoundary localRecoveryAvailable={localModelReady}>
      <ValidationHarnessCrashSentinel />
      <ChatSurface
        messages={messages}
        isStreaming={isStreaming}
        streamPhase={streamPhase}
        error={error}
        contextDividerIndex={contextDividerIndex}
        activeToolCalls={activeToolCalls}
        activeConversationId={activeConversationId}
        allMessages={allMessages}
        editingMessageId={editingMessageId}
        reactionsMap={reactionsMap}
        onSendMessage={handleSendMessage}
        onSubmitWithFiles={handleSubmitWithFiles}
        onStopGeneration={stopGeneration}
        onRetry={retryMessage}
        onStartEdit={handleStartEdit}
        onSaveEdit={handleSaveEdit}
        onCancelEdit={handleCancelEdit}
        onRegenerate={handleRegenerate}
        onAssistantAction={handleAssistantAction}
        onNavigateBranch={handleNavigateBranch}
        onReact={handleReact}
        onRemoveReaction={handleRemoveReaction}
        onPrepareLocalModel={handlePrepareLocalModel}
        getLocalPrepareState={getLocalPrepareState}
        searchOpen={searchOpen}
        onCloseSearch={() => setSearchOpen(false)}
        queryCount={queryCount}
        onShare={() => {
          void handleShareConversation();
        }}
        showBatteryReducedNotice={showBatteryReducedNotice}
        validationProtectionBanner={validationProtectionBanner}
        validationSelectedModelBanner={validationSelectedModelBanner}
        isDragging={isDragging}
        droppedAttachmentError={droppedAttachmentError}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      />
      {/* Onboarding tour -- welcome overlay + driver.js guided tour */}
      <OnboardingTour />
    </LocalInferenceErrorBoundary>
  );
}
