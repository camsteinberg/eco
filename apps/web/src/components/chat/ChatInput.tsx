// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { FileChip } from "./FileChip";
import { ModelSelector } from "./ModelSelector";
import { ResearchToggle } from "./ResearchToggle";
import { useChatStore } from "../../stores/chatStore";
import {
  validateFile,
  extractText,
  buildMessageWithFiles,
  ALLOWED_EXTENSIONS,
  MAX_FILES_PER_MESSAGE,
} from "../../lib/file-extract";
import type { FileExtractionResult } from "../../lib/file-extract";
import { getSeason } from "../../lib/season";
import { LeafAnimation, checkEasterEgg } from "../easter-eggs/LeafAnimation";
import type { AnimationVariant } from "../easter-eggs/LeafAnimation";

export type ChatInputProps = {
  onSubmit: (message: string) => void;
  onSubmitWithFiles?: (message: string, files: FileExtractionResult[]) => void;
  disabled?: boolean;
  placeholder?: string;
  onStop?: () => void;
  isStreaming?: boolean;
};

const MAX_HEIGHT = 192;

const ACCEPT_STRING = [...ALLOWED_EXTENSIONS].map((e) => `.${e}`).join(",");
const trimTerminalPunctuation = (message: string) => message.replace(/[.!?]+$/u, "");

export function ChatInput({
  onSubmit,
  onSubmitWithFiles,
  disabled = false,
  placeholder = "Message Eco...",
  onStop,
  isStreaming = false,
}: ChatInputProps) {
  const [easterEgg, setEasterEgg] = useState<{ visible: boolean; variant: AnimationVariant }>({
    visible: false,
    variant: 'leaves',
  });
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Timestamp of the last successful submit — debounces rapid double-taps. */
  const lastSubmitRef = useRef<number>(0);

  const fileAttachments = useChatStore((s) => s.fileAttachments);
  const composerDraft = useChatStore((s) => s.composerDraft);
  const { addFileAttachment, updateFileAttachment, removeFileAttachment, clearFileAttachments, setComposerDraft, clearComposerDraft } =
    useChatStore.getState();

  // Check if any file is still processing
  const hasProcessing = fileAttachments.some(
    (f) => f.status === "validating" || f.status === "reading" || f.status === "extracting"
  );

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [composerDraft, resize]);

  /**
   * Process selected files: validate, add to store, extract text.
   */
  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const currentCount = useChatStore.getState().fileAttachments.length;
      const fileArray = Array.from(files);
      let acceptedFileCount = 0;
      setAttachmentError(null);

      for (let i = 0; i < fileArray.length; i++) {
        const file = fileArray[i]!;

        // Enforce max files per message
        if (currentCount + acceptedFileCount >= MAX_FILES_PER_MESSAGE) {
          setAttachmentError(
            `Could not attach ${file.name}: max ${String(MAX_FILES_PER_MESSAGE)} files per message.`,
          );
          continue;
        }

        const validationError = validateFile(file);
        if (validationError) {
          setAttachmentError(
            `Could not attach ${validationError.filename}: ${validationError.error}.`,
          );
          continue;
        }

        acceptedFileCount += 1;
        const id = addFileAttachment(file);
        updateFileAttachment(id, { status: "reading" });

        // Extract text asynchronously
        try {
          updateFileAttachment(id, { status: "extracting" });
          const result = await extractText(file);
          updateFileAttachment(id, { status: "done", result });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Extraction failed";
          updateFileAttachment(id, { status: "error", errorMessage: message });
          setAttachmentError(
            `Could not read ${file.name}: ${trimTerminalPunctuation(message)}. Remove it or choose another file before sending.`,
          );
        }
      }
    },
    [addFileAttachment, updateFileAttachment]
  );

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) {
      void processFiles(files);
    }
    // Reset input so the same file can be re-selected
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function handleSubmit() {
    // Double-submit guard: reject if store says we're streaming or if last
    // submit was less than 300ms ago. Uses fresh store state (not stale
    // closure) so a just-completed stream is correctly detected.
    const nowMs = Date.now();
    if (useChatStore.getState().isStreaming) return;
    if (nowMs - lastSubmitRef.current < 300) return;

    const trimmed = composerDraft.trim();
    const doneFiles = fileAttachments
      .filter((f) => f.status === "done" && f.result)
      .map((f) => f.result!);

    // Allow submit if there's text or done files (not if both empty)
    if (!trimmed && doneFiles.length === 0) return;
    if (disabled || hasProcessing) return;

    if (doneFiles.length > 0 && onSubmitWithFiles) {
      onSubmitWithFiles(trimmed, doneFiles);
    } else if (doneFiles.length > 0) {
      // Fallback: build message inline using buildMessageWithFiles
      onSubmit(buildMessageWithFiles(trimmed, doneFiles));
    } else {
      onSubmit(trimmed);
    }

    // Check for easter egg triggers (after send, not during typing)
    if (trimmed) {
      const season = getSeason();
      const egg = checkEasterEgg(trimmed, season);
      if (egg) {
        setEasterEgg({ visible: true, variant: egg.variant });
      }
    }

    lastSubmitRef.current = Date.now();
    clearComposerDraft();
    clearFileAttachments();
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
    textareaRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const hasContent = composerDraft.trim().length > 0 || fileAttachments.some((f) => f.status === "done");
  const attachmentProcessingLabel =
    fileAttachments.length > 1 ? "Preparing attachments…" : "Preparing attachment…";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        handleSubmit();
      }}
      className="rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] shadow-sm transition-shadow focus-within:shadow-md focus-within:ring-2 focus-within:ring-[var(--eco-primary)]/15"
    >
      {/* File chips row */}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3 pb-1">
          {fileAttachments.map((att) => (
            <FileChip
              key={att.id}
              filename={att.file.name}
              size={att.file.size}
              status={att.status}
              errorMessage={att.errorMessage}
              truncated={att.result?.truncated}
              onRemove={() => {
                removeFileAttachment(att.id);
                setAttachmentError(null);
              }}
            />
          ))}
        </div>
      )}

      {attachmentError ? (
        <div className="px-4 pt-3">
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
            {attachmentError}
          </p>
        </div>
      ) : null}

      {/* Input row */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPT_STRING}
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />

        {/* Paperclip button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          aria-label="Attach files"
          className="flex h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 shrink-0 cursor-pointer items-center justify-center rounded-full transition-all hover:bg-[var(--eco-border)]/50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
          style={{ color: "var(--eco-text-secondary)" }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4.5 w-4.5"
            aria-hidden="true"
          >
            <path fillRule="evenodd" d="M15.621 4.379a3 3 0 00-4.242 0l-7 7a3 3 0 004.241 4.243h.001l.497-.5a.75.75 0 011.064 1.057l-.498.501-.002.002a4.5 4.5 0 01-6.364-6.364l7-7a4.5 4.5 0 016.368 6.36l-3.455 3.553A2.625 2.625 0 119.52 9.52l3.45-3.451a.75.75 0 111.061 1.06l-3.45 3.451a1.125 1.125 0 001.587 1.595l3.454-3.553a3 3 0 000-4.242z" clipRule="evenodd" />
          </svg>
        </button>

        <textarea
          ref={textareaRef}
          value={composerDraft}
          onChange={(e) => setComposerDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          className="min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-[0.9375rem] leading-normal text-[var(--eco-text)] placeholder:text-[var(--eco-text-secondary)] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:py-0"
          style={{ maxHeight: `${MAX_HEIGHT}px`, overflowY: "auto" }}
          aria-label="Message input"
        />

        <ResearchToggle />

        <ModelSelector />

        {isStreaming && onStop ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            className="flex h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 border-[var(--eco-text-secondary)] text-[var(--eco-text-secondary)] transition-all hover:border-[var(--eco-text)] hover:text-[var(--eco-text)] hover:scale-110 active:scale-95"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1" />
            </svg>
          </button>
        ) : hasProcessing ? (
          <button
            type="button"
            disabled
            aria-label={attachmentProcessingLabel}
            title={attachmentProcessingLabel}
            className="flex h-8 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full border border-[var(--eco-border)] bg-[var(--eco-primary-soft)] px-3 text-[var(--eco-primary)] md:min-h-0"
          >
            <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="28" strokeDashoffset="8" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !hasContent || hasProcessing}
            aria-label="Send message"
            className="flex h-8 w-8 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--eco-on-primary)] transition-all hover:opacity-90 hover:scale-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-30"
            style={{ backgroundColor: 'var(--eco-accent)' }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M3.105 2.289a.75.75 0 00-.826.95l1.903 6.557H13.5a.75.75 0 010 1.5H4.182l-1.903 6.557a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
            </svg>
          </button>
        )}
      </div>
      {hasProcessing && (
        <div className="px-4 pb-3">
          <p
            role="status"
            aria-live="polite"
            className="text-xs leading-relaxed text-[var(--eco-text-secondary)]"
          >
            {attachmentProcessingLabel} Send unlocks as soon as the text is ready.
          </p>
        </div>
      )}
      <LeafAnimation
        visible={easterEgg.visible}
        variant={easterEgg.variant}
        onComplete={() => setEasterEgg((prev) => ({ ...prev, visible: false }))}
      />
    </form>
  );
}
