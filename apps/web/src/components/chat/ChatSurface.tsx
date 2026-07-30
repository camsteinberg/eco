// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { DragEvent } from "react";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { springPresets } from "@eco/ui";
import { timeGreeting } from "./greeting";
import { MessageList } from "./MessageList";
import type { AssistantReplyControl } from "./MessageActions";
import type { LocalModelPrepareState } from "./ErrorMessage";
import { ChatInput } from "./ChatInput";
import { ImpactFooter } from "./ImpactFooter";
import { InConversationSearch } from "./InConversationSearch";
import { WhyEcoCard } from "../onboarding/WhyEcoCard";
import { SuggestedPrompts } from "./SuggestedPrompts";
import { EmptyChatBackdrop } from "./EmptyChatBackdrop";
import type { ChatMessage, StreamPhase } from "../../stores/chatStore";
import type { DbMessage, MessageReaction } from "../../lib/db";
import type { ToolCallDisplay } from "../../lib/tool-parser";
import type { FileExtractionResult } from "../../lib/file-extract";
import type {
  getValidationProtectionBanner,
  getValidationSelectedModelBanner,
} from "../../lib/validation-harness";
import { ECO_OPEN_GUIDE_EVENT } from "../../lib/onboarding-guide";

type ValidationProtectionBanner = ReturnType<typeof getValidationProtectionBanner>;
type ValidationSelectedModelBanner = ReturnType<typeof getValidationSelectedModelBanner>;

function QuestionMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth="2.5"
      stroke="currentColor"
      className={className}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M12 17.25h.008v.008H12v-.008Z"
      />
    </svg>
  );
}

function AttachmentDropError({ message, className = "" }: { message: string; className?: string }) {
  return (
    <div className={className}>
      <p
        role="alert"
        aria-live="assertive"
        className="rounded-2xl border px-3 py-2 text-xs leading-relaxed"
        style={{
          backgroundColor: "var(--eco-coral-soft)",
          borderColor: "color-mix(in srgb, var(--eco-coral) 28%, var(--eco-border))",
          color: "var(--eco-coral)",
        }}
      >
        {message}
      </p>
    </div>
  );
}

function ValidationSelectedModelNotice({
  banner,
  className = "",
}: {
  banner: ValidationSelectedModelBanner;
  className?: string;
}) {
  if (!banner) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`${className} rounded-xl border px-4 py-3 text-sm`}
      data-testid="validation-selected-model-banner"
      style={{
        backgroundColor: "color-mix(in srgb, var(--eco-amber) 10%, transparent)",
        borderColor: "color-mix(in srgb, var(--eco-amber) 26%, var(--eco-border))",
        color: "var(--eco-text)",
      }}
    >
      <p className="font-medium">{banner.title}</p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--eco-text-secondary)" }}>
        {banner.body}
      </p>
      <p
        className="mt-2 break-words font-[family-name:var(--eco-font-mono)] text-[11px] leading-relaxed"
        style={{ color: "var(--eco-text-secondary)" }}
      >
        Requested profile: {banner.profileSummary}
      </p>
    </div>
  );
}

export type ChatSurfaceProps = {
  // Conversation data
  messages: ChatMessage[];
  isStreaming: boolean;
  streamPhase?: StreamPhase;
  error: string | null;
  contextDividerIndex: number;
  activeToolCalls?: ToolCallDisplay[];
  activeConversationId: string | null;
  allMessages: DbMessage[];
  editingMessageId: string | null;
  reactionsMap: Map<string, MessageReaction[]>;

  // Send / compose
  onSendMessage: (content: string) => void;
  onSubmitWithFiles: (text: string, files: FileExtractionResult[]) => void;
  onStopGeneration: () => void;

  // Message actions
  onRetry: (messageId: string) => void;
  onStartEdit: (id: string) => void;
  onSaveEdit: (id: string, content: string) => void;
  onCancelEdit: () => void;
  onRegenerate: (id: string) => void;
  onAssistantAction: (messageId: string, action: AssistantReplyControl) => void;
  onNavigateBranch: (messageId: string, direction: "prev" | "next") => void;
  onReact: (messageId: string, emoji: string) => void;
  onRemoveReaction: (messageId: string, emoji: string) => void;

  // Local model readiness
  onPrepareLocalModel: (modelId: string) => void;
  getLocalPrepareState: (modelId: string) => LocalModelPrepareState;

  // Search
  searchOpen: boolean;
  onCloseSearch: () => void;

  // Impact + banners
  queryCount: number;
  onShare: () => void;
  showBatteryReducedNotice: boolean;
  validationProtectionBanner: ValidationProtectionBanner;
  validationSelectedModelBanner: ValidationSelectedModelBanner;

  // Drag-and-drop
  isDragging: boolean;
  droppedAttachmentError: string | null;
  onDragEnter: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
};

/**
 * Time-of-day greeting for the empty chat state. Owns its own clock read (client
 * mount only, so no hydration mismatch) and springs in gently above the suggested
 * prompts. The non-breaking-space placeholder holds the heading's height for the
 * one frame before the greeting resolves, so nothing reflows.
 */
function EmptyGreeting() {
  const shouldReduceMotion = useReducedMotion();
  const [greeting, setGreeting] = useState<string | null>(null);

  useEffect(() => {
    setGreeting(timeGreeting(new Date()));
  }, []);

  return (
    <motion.div
      className="relative z-10 flex flex-col items-center gap-3"
      initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={springPresets.gentle}
    >
      <h2 className="font-[family-name:var(--eco-font-display)] text-3xl text-[var(--eco-text)] text-center tracking-[-0.02em]">
        {greeting ?? " "}
      </h2>
      <p className="max-w-md text-[var(--eco-text-secondary)] text-center text-sm leading-relaxed">
        A private space to think out loud — what’s on your mind?
      </p>
    </motion.div>
  );
}

/**
 * Presentation for the chat surface: empty state, message list, input, impact
 * footer, drop overlay, and the ambient banners/toasts. All state and handlers
 * are owned by ChatWorkspace and passed in.
 */
export function ChatSurface(props: ChatSurfaceProps) {
  const {
    messages,
    isStreaming,
    streamPhase,
    error,
    contextDividerIndex,
    activeToolCalls,
    activeConversationId,
    allMessages,
    editingMessageId,
    reactionsMap,
    onSendMessage,
    onSubmitWithFiles,
    onStopGeneration,
    onRetry,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onRegenerate,
    onAssistantAction,
    onNavigateBranch,
    onReact,
    onRemoveReaction,
    onPrepareLocalModel,
    getLocalPrepareState,
    searchOpen,
    onCloseSearch,
    queryCount,
    onShare,
    showBatteryReducedNotice,
    validationProtectionBanner,
    validationSelectedModelBanner,
    isDragging,
    droppedAttachmentError,
    onDragEnter,
    onDragLeave,
    onDragOver,
    onDrop,
  } = props;

  return (
    <div
      className="grain-subtle relative flex h-full flex-col bg-[var(--eco-surface-chat)]"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Drop zone overlay */}
      {isDragging && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed"
          style={{
            backgroundColor: "rgba(var(--eco-primary-rgb, 45, 90, 61), 0.08)",
            borderColor: "var(--eco-primary)",
          }}
        >
          <div className="flex flex-col items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-10 w-10" style={{ color: "var(--eco-primary)" }}>
              <path fillRule="evenodd" d="M11.47 2.47a.75.75 0 011.06 0l4.5 4.5a.75.75 0 01-1.06 1.06l-3.22-3.22V16.5a.75.75 0 01-1.5 0V4.81L8.03 8.03a.75.75 0 01-1.06-1.06l4.5-4.5zM3 15.75a.75.75 0 01.75.75v2.25a1.5 1.5 0 001.5 1.5h13.5a1.5 1.5 0 001.5-1.5V16.5a.75.75 0 011.5 0v2.25a3 3 0 01-3 3H5.25a3 3 0 01-3-3V16.5a.75.75 0 01.75-.75z" clipRule="evenodd" />
            </svg>
            <p className="text-sm font-medium" style={{ color: "var(--eco-primary)" }}>
              Drop files here
            </p>
          </div>
        </div>
      )}

      {messages.length === 0 && <EmptyChatBackdrop />}

      {messages.length === 0 ? (
        <div className="relative z-10 flex-1 overflow-y-auto">
          {/* Mobile: top-align with a small offset so the composer clears the fold.
              sm+ keeps the original vertical-centering offset (desktop unchanged). */}
          <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 pt-6 sm:pt-[calc(50vh-15rem)]">
            {validationProtectionBanner && (
              <div
                role="status"
                aria-live="polite"
                className="mb-4 w-full rounded-xl border px-4 py-3 text-sm"
                style={{
                  backgroundColor:
                    validationProtectionBanner.tone === "warning"
                      ? "color-mix(in srgb, var(--eco-coral-soft) 70%, white)"
                      : "color-mix(in srgb, var(--eco-amber) 10%, transparent)",
                  borderColor:
                    validationProtectionBanner.tone === "warning"
                      ? "color-mix(in srgb, var(--eco-coral) 28%, var(--eco-border))"
                      : "color-mix(in srgb, var(--eco-amber) 26%, var(--eco-border))",
                  color: "var(--eco-text)",
                }}
              >
                <p className="font-medium">{validationProtectionBanner.title}</p>
                <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--eco-text-secondary)" }}>
                  {validationProtectionBanner.body}
                </p>
              </div>
            )}
            <ValidationSelectedModelNotice
              banner={validationSelectedModelBanner}
              className="mb-4 w-full"
            />
            <div
              data-testid="empty-chat-state"
              className="relative flex h-full flex-col items-center justify-center gap-6 sm:gap-8"
            >
              <EmptyGreeting />
              <div className="relative z-10 w-full max-w-2xl px-4">
                <SuggestedPrompts onSelect={onSendMessage} />
              </div>
            </div>
            <div className="relative mt-6 w-full">
              <div
                className="pointer-events-none absolute -inset-3 rounded-3xl opacity-30"
                style={{ background: 'radial-gradient(ellipse at center, var(--eco-primary-soft) 0%, transparent 70%)' }}
              />
              {droppedAttachmentError ? (
                <AttachmentDropError message={droppedAttachmentError} className="relative mb-3" />
              ) : null}
              <ChatInput onSubmit={onSendMessage} onSubmitWithFiles={onSubmitWithFiles} disabled={isStreaming} placeholder="Ask Eco anything..." onStop={onStopGeneration} isStreaming={isStreaming} />
            </div>
            <div
              data-eco-chat-trust-footer
              className="mt-3 w-full pb-[calc(2rem+env(safe-area-inset-bottom))]"
            >
              <WhyEcoCard />
            </div>
          </div>
        </div>
      ) : (
        <>
          <InConversationSearch
            messages={messages}
            isOpen={searchOpen}
            onClose={onCloseSearch}
          />
          <div className="min-h-0 flex-1 overflow-hidden">
            <MessageList
              messages={messages}
              isStreaming={isStreaming}
              streamPhase={streamPhase}
              onRetry={onRetry}
              allMessages={allMessages}
              activeBranch={messages}
              editingMessageId={editingMessageId}
              onStartEdit={onStartEdit}
              onSaveEdit={onSaveEdit}
              onCancelEdit={onCancelEdit}
              onRegenerate={onRegenerate}
              onAssistantAction={onAssistantAction}
              onNavigateBranch={onNavigateBranch}
              contextDividerIndex={contextDividerIndex}
              activeToolCalls={activeToolCalls}
              reactions={reactionsMap}
              onReact={onReact}
              onRemoveReaction={onRemoveReaction}
              conversationId={activeConversationId ?? undefined}
              onPrepareLocalModel={onPrepareLocalModel}
              getLocalPrepareState={getLocalPrepareState}
            />
          </div>

          {showBatteryReducedNotice && (
            <div
              role="status"
              aria-live="polite"
              className="mx-4 mb-2 rounded-xl border px-4 py-3 text-sm"
              style={{
                backgroundColor: "color-mix(in srgb, var(--eco-amber) 10%, transparent)",
                borderColor: "color-mix(in srgb, var(--eco-amber) 26%, var(--eco-border))",
                color: "var(--eco-text)",
              }}
            >
              <p className="font-medium">Low battery mode</p>
              <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--eco-text-secondary)" }}>
                Eco is keeping on-device replies shorter until you plug this device in.
              </p>
            </div>
          )}

          {validationProtectionBanner && (
            <div
              role="status"
              aria-live="polite"
              className="mx-4 mb-2 rounded-xl border px-4 py-3 text-sm"
              style={{
                backgroundColor:
                  validationProtectionBanner.tone === "warning"
                    ? "color-mix(in srgb, var(--eco-coral-soft) 70%, white)"
                    : "color-mix(in srgb, var(--eco-amber) 10%, transparent)",
                borderColor:
                  validationProtectionBanner.tone === "warning"
                    ? "color-mix(in srgb, var(--eco-coral) 28%, var(--eco-border))"
                    : "color-mix(in srgb, var(--eco-amber) 26%, var(--eco-border))",
                color: "var(--eco-text)",
              }}
            >
              <p className="font-medium">{validationProtectionBanner.title}</p>
              <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--eco-text-secondary)" }}>
                {validationProtectionBanner.body}
              </p>
            </div>
          )}

          <ValidationSelectedModelNotice
            banner={validationSelectedModelBanner}
            className="mx-4 mb-2"
          />

          {error && (
            <div
              role="alert"
              className="mx-4 mb-2 rounded-xl px-4 py-3 text-sm"
              style={{ backgroundColor: 'var(--eco-coral-soft)', color: 'var(--eco-coral)' }}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{error}</span>
              </div>
            </div>
          )}

          {/* Impact footer */}
          <ImpactFooter
            queryCount={queryCount}
            onShare={onShare}
          />

          <div
            data-eco-composer-bar
            className="relative border-t border-[var(--eco-border)]/40 px-3 sm:px-4 pt-3 sm:pt-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
          >
            <div className="mx-auto max-w-2xl">
              {droppedAttachmentError ? (
                <AttachmentDropError message={droppedAttachmentError} className="mb-3" />
              ) : null}
              <ChatInput onSubmit={onSendMessage} onSubmitWithFiles={onSubmitWithFiles} disabled={isStreaming} placeholder="Ask Eco anything..." onStop={onStopGeneration} isStreaming={isStreaming} />
            </div>
          </div>
        </>
      )}

      {/* Help guide floating button */}
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(ECO_OPEN_GUIDE_EVENT))}
        className="absolute z-40 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)]/90 text-[var(--eco-text-secondary)] shadow-md backdrop-blur-sm transition-all duration-200 hover:scale-105 active:scale-95 hover:border-[var(--eco-primary)]/40 hover:bg-[var(--eco-surface-elevated)] hover:text-[var(--eco-primary)] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 bottom-[80px] right-4 md:bottom-5 md:right-6"
        aria-label="Open Eco guide"
        title="Open Eco guide"
      >
        <QuestionMarkIcon className="h-5 w-5" />
      </button>
    </div>
  );
}
