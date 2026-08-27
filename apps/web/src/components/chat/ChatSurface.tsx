// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { DragEvent } from "react";
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { springPresets, WarningTriangle } from "@eco/ui";
import { timeGreeting } from "./greeting";
import { ErrorLine, ErrorNotice } from "../ui/ErrorNotice";
import { ContextWindowNotice } from "./ContextWindowNotice";
import { PersistenceNotice } from "./PersistenceNotice";
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
import { useAnyBottomSheetOpen } from "../../lib/bottom-sheet-open";

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

/**
 * The floating "open the guide" button.
 *
 * Size follows the composer's own round-control scale (`h-8` disc, widened to a
 * 44px tap target below `md`), and the disc itself borrows the composer pill's
 * surface recipe — an opaque elevated fill over a real border. The previous
 * translucent fill measured 1.006:1 against the page in dark, which left the
 * glyph floating with no button under it.
 *
 * Positioning — including `display`, so callers can hide the button at
 * viewports where it has nowhere to sit — is the caller's job.
 */
function HelpGuideButton({ className }: { className: string }) {
  // A bottom sheet covers the bottom of the viewport, which is where this disc
  // lives: in the model sheet it landed on the last tile's state line (the
  // clearance under the list is about 38px plus the safe area, against a 44px
  // disc), and it shares a z band with the cookie banner and the toasts. While
  // a sheet is open the disc has nothing to offer that the sheet does not, so
  // it stands down rather than fighting for the same corner.
  const sheetOpen = useAnyBottomSheetOpen();
  if (sheetOpen) return null;

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(ECO_OPEN_GUIDE_EVENT))}
      className={`absolute z-40 h-8 w-8 min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-full border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] text-[var(--eco-text-secondary)] shadow-sm transition-all duration-200 hover:scale-105 active:scale-95 hover:border-[var(--eco-primary)]/40 hover:text-[var(--eco-primary)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] focus-visible:ring-offset-2 md:min-h-0 md:min-w-0 ${className}`}
      aria-label="Open Eco guide"
      title="Open Eco guide"
    >
      <QuestionMarkIcon className="h-5 w-5 md:h-4 md:w-4" />
    </button>
  );
}

function AttachmentDropError({ message, className = "" }: { message: string; className?: string }) {
  return <ErrorLine size="xs" className={className}>{message}</ErrorLine>;
}

function ValidationProtectionNotice({
  banner,
  className = "",
}: {
  banner: NonNullable<ValidationProtectionBanner>;
  className?: string;
}) {
  const warning = banner.tone === "warning";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border px-4 py-3 text-sm ${className}`}
      style={{
        backgroundColor: warning
          ? "var(--eco-coral-soft)"
          : "color-mix(in srgb, var(--eco-amber) 10%, transparent)",
        borderColor: warning
          ? "color-mix(in srgb, var(--eco-coral) 28%, var(--eco-border))"
          : "color-mix(in srgb, var(--eco-amber) 26%, var(--eco-border))",
        color: "var(--eco-text)",
      }}
    >
      <p className="font-medium">{banner.title}</p>
      <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--eco-text-secondary)" }}>
        {banner.body}
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
          // pointer-events-none: the drag handlers live on the surface itself,
          // so an overlay that swallowed dragover/drop would fight the very
          // gesture it is announcing.
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed"
          style={{
            backgroundColor: "rgba(var(--eco-primary-rgb, 45, 90, 61), 0.08)",
            borderColor: "var(--eco-primary)",
          }}
        >
          {/* An opaque chip, not bare glyph-on-tint: the overlay does paint
              above the suggested prompts (measured), but a translucent label
              over card copy still reads as tangled with it. */}
          <div
            className="flex flex-col items-center gap-2 rounded-2xl border px-6 py-5 shadow-sm"
            style={{
              backgroundColor: "var(--eco-surface-elevated)",
              borderColor: "color-mix(in srgb, var(--eco-primary) 30%, var(--eco-border))",
            }}
          >
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
          {/* Caps = the reading column plus this element's own px-4, so the
              composer field here matches the conversation view's exactly and
              nothing jumps on the first message. */}
          <div className="mx-auto flex w-full max-w-[44rem] lg:max-w-[50rem] xl:max-w-[58rem] flex-col items-center px-4 pt-6 sm:pt-[calc(50vh-15rem)]">
            {validationProtectionBanner && (
              <ValidationProtectionNotice
                banner={validationProtectionBanner}
                className="mb-4 w-full"
              />
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
              <div className="relative z-10 w-full">
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
              className="flex items-start gap-2 border-b px-4 py-2 text-sm"
              style={{
                borderColor: "color-mix(in srgb, var(--eco-amber) 26%, var(--eco-border))",
                backgroundColor: "var(--eco-amber-soft)",
                color: "var(--eco-text)",
              }}
            >
              <WarningTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="min-w-0">
                <span className="font-medium">Low battery mode</span>{" "}
                <span className="opacity-80">Eco is keeping on-device replies shorter until you plug this device in.</span>
              </p>
            </div>
          )}

          {validationProtectionBanner && (
            <ValidationProtectionNotice
              banner={validationProtectionBanner}
              className="mx-4 mb-2"
            />
          )}

          <ValidationSelectedModelNotice
            banner={validationSelectedModelBanner}
            className="mx-4 mb-2"
          />

          {error && (
            <ErrorNotice className="mx-4 mb-2" lead={error} />
          )}

          {/* A failed chat save, by the composer. The sidebar shows the same
              message, but on a phone the sidebar is a closed sheet. */}
          <PersistenceNotice className="mx-4 mb-2" />

          {/* Sits just above the composer, where the next message is written,
              and says how much of the chat the model no longer reads. Owns its
              own store state (raised by useChat while the divider exists). */}
          <ContextWindowNotice className="mx-4 mb-2" droppedCount={contextDividerIndex} />

          {/* Impact footer. The help button rides inside it whenever it has
              height: the footer already reserves a 68px lane at its right edge
              for exactly this button, and centring on the band keeps the disc
              inside the tint instead of straddling its top border (and, under
              the low-battery notice, the amber strip above it). */}
          <div className="relative">
            <ImpactFooter
              queryCount={queryCount}
              onShare={onShare}
            />
            {queryCount > 0 && (
              <HelpGuideButton className="flex inset-y-0 my-auto right-4 md:right-6" />
            )}
          </div>

          <div
            data-eco-composer-bar
            className="relative border-t border-[var(--eco-border)]/40 px-3 sm:px-4 pt-3 sm:pt-5 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
          >
            {/* No impact band yet (it counts completed replies, so the first
                turn and the failed ones render without it) — hang the button
                off the composer bar's top edge instead. A fixed bottom offset
                collides with the composer as soon as the textarea autogrows,
                and at tablet widths the centered composer reaches the right
                edge the button used to sit in. */}
            {queryCount <= 0 && (
              <HelpGuideButton className="flex bottom-[calc(100%+0.5rem)] right-4 md:right-6" />
            )}
            <div className="mx-auto max-w-2xl lg:max-w-3xl xl:max-w-4xl">
              {droppedAttachmentError ? (
                <AttachmentDropError message={droppedAttachmentError} className="mb-3" />
              ) : null}
              <ChatInput onSubmit={onSendMessage} onSubmitWithFiles={onSubmitWithFiles} disabled={isStreaming} placeholder="Ask Eco anything..." onStop={onStopGeneration} isStreaming={isStreaming} />
            </div>
          </div>
        </>
      )}

      {/* Help guide floating button. The empty state has no bottom-anchored
          chrome to hang it from — the whole column scrolls — so it stays pinned
          to the surface, and it only appears once the surface is wide enough
          for the column's gutter to hold it. Below `lg` the column reaches the
          right edge and the disc lands on whatever happens to be there: the
          send button when the upgrade card lowers the composer, the
          attachment-limit line otherwise. The empty state is itself the guide
          (greeting, suggested prompts, trust card), and the button returns as
          soon as there is a conversation. */}
      {messages.length === 0 && (
        <HelpGuideButton className="hidden lg:flex bottom-5 right-6" />
      )}
    </div>
  );
}
