// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useEffect, useCallback } from "react";
import { copyConversationAsMarkdown, downloadShareableHTML } from "../../lib/share";
import {
  ConversationNotFoundError,
  exportConversationAsJSON,
  downloadFile,
} from "../../lib/export";

type ShareDialogProps = {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  conversationTitle: string;
};

/**
 * Copy-button state. The two failures are kept apart on purpose: every export
 * path re-reads the conversation from IndexedDB before it touches the clipboard,
 * so a chat deleted while this dialog is open fails at the read. Collapsing that
 * into "copy failed on this browser" blamed a browser that was working fine.
 */
type CopyStatus = "idle" | "success" | "copy-failed" | "conversation-missing";

/**
 * Shared by all three actions, because all three hit the same read first, and
 * "try again" would be false advice for any of them — the record is gone.
 */
const CONVERSATION_MISSING_MESSAGE =
  "Eco can't find this conversation on this device. It may have been deleted.";

/**
 * Share dialog with three actions: copy as markdown, download as HTML,
 * and export as JSON. Renders as a centered modal with backdrop.
 * Privacy-first: no server upload, all actions are local.
 */
export function ShareDialog({
  open,
  onClose,
  conversationId,
  conversationTitle,
}: ShareDialogProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Reset copied state when dialog closes
  useEffect(() => {
    if (!open) {
      setCopyStatus("idle");
      setDownloadError(null);
    }
  }, [open]);

  // Auto-reset copy feedback after 2 seconds
  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  const handleCopyMarkdown = useCallback(async () => {
    setDownloadError(null);
    try {
      await copyConversationAsMarkdown(conversationId);
      setCopyStatus("success");
    } catch (err) {
      setCopyStatus(
        err instanceof ConversationNotFoundError ? "conversation-missing" : "copy-failed",
      );
    }
  }, [conversationId]);

  const handleDownloadHTML = useCallback(async () => {
    setDownloadError(null);
    try {
      await downloadShareableHTML(conversationId, conversationTitle);
    } catch (err) {
      setDownloadError(
        err instanceof ConversationNotFoundError
          ? CONVERSATION_MISSING_MESSAGE
          : "Eco could not create the HTML export. Try again or copy Markdown instead.",
      );
    }
  }, [conversationId, conversationTitle]);

  const handleExportJSON = useCallback(async () => {
    setDownloadError(null);
    try {
      const json = await exportConversationAsJSON(conversationId);
      downloadFile(json, `${conversationTitle}.json`, "application/json");
    } catch (err) {
      setDownloadError(
        err instanceof ConversationNotFoundError
          ? CONVERSATION_MISSING_MESSAGE
          : "Eco could not create the JSON export. Try again or copy Markdown instead.",
      );
    }
  }, [conversationId, conversationTitle]);

  if (!open) return null;

  const truncatedTitle =
    conversationTitle.length > 60
      ? conversationTitle.slice(0, 60) + "..."
      : conversationTitle;

  const copyFailed = copyStatus === "copy-failed" || copyStatus === "conversation-missing";
  // "Try copy again" would be a lie when the record is gone — retrying re-reads
  // the same missing conversation. The button's aria-label stays constant so the
  // accessible name never shifts under a screen reader mid-interaction.
  const copyButtonLabel =
    copyStatus === "success"
      ? "Copied!"
      : copyStatus === "conversation-missing"
        ? "Nothing to copy"
        : copyStatus === "copy-failed"
          ? "Try copy again"
          : "Copy as Markdown";
  const copyStatusMessage =
    copyStatus === "success"
      ? "Copied locally as markdown."
      : copyStatus === "conversation-missing"
        ? CONVERSATION_MISSING_MESSAGE
        : "Copy failed on this browser. Try again.";
  const copyAnnouncement =
    copyStatus === "success"
      ? "Conversation copied as markdown."
      : copyStatus === "conversation-missing"
        ? "This conversation is no longer saved on this device."
        : copyStatus === "copy-failed"
          ? "Couldn't copy conversation as markdown."
          : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center motion-safe:animate-[fadeIn_150ms_ease-out]"
      role="dialog"
      aria-label="Share conversation"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--eco-scrim)]"
        onClick={onClose}
        data-testid="share-backdrop"
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-[var(--eco-text)]">
          Share conversation
        </h2>
        <p className="mt-1 text-sm text-[var(--eco-text-secondary)]">
          {truncatedTitle}
        </p>
        <p className="sr-only" aria-live="polite" role="status">
          {copyAnnouncement}
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {/* Copy as Markdown */}
          <button
            type="button"
            onClick={handleCopyMarkdown}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--eco-border)] px-4 py-3 text-left text-sm font-medium text-[var(--eco-text)] transition-colors duration-150 hover:bg-[var(--eco-primary-soft)]"
            aria-label="Copy as Markdown"
          >
            {copyStatus === "success" ? (
              <>
                {/* Checkmark icon */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5 shrink-0 text-[var(--eco-primary)]"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z"
                    clipRule="evenodd"
                  />
                </svg>
                {copyButtonLabel}
              </>
            ) : copyFailed ? (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5 shrink-0 text-[var(--eco-coral)]"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.03-10.53a.75.75 0 10-1.06-1.06L10 8.44 8.03 6.47a.75.75 0 10-1.06 1.06L8.94 9.5l-1.97 1.97a.75.75 0 001.06 1.06L10 10.56l1.97 1.97a.75.75 0 001.06-1.06L11.06 9.5l1.97-2.03z"
                    clipRule="evenodd"
                  />
                </svg>
                {copyButtonLabel}
              </>
            ) : (
              <>
                {/* Clipboard icon */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="h-5 w-5 shrink-0 text-[var(--eco-text-secondary)]"
                >
                  <path
                    fillRule="evenodd"
                    d="M15.988 3.012A2.25 2.25 0 0118 5.25v6.5A2.25 2.25 0 0115.75 14H13.5V7A2.5 2.5 0 0011 4.5H8.128a2.252 2.252 0 011.884-1.488A2.25 2.25 0 0112.25 1h1.5a2.25 2.25 0 012.238 2.012zM11.5 3.25a.75.75 0 01.75-.75h1.5a.75.75 0 01.75.75v.25h-3v-.25z"
                    clipRule="evenodd"
                  />
                  <path
                    fillRule="evenodd"
                    d="M2 7a1 1 0 011-1h8a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V7zm2 3.25a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75zm0 3.5a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5a.75.75 0 01-.75-.75z"
                    clipRule="evenodd"
                  />
                </svg>
                {copyButtonLabel}
              </>
            )}
          </button>

          {/* Download as HTML */}
          <button
            type="button"
            onClick={handleDownloadHTML}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--eco-border)] px-4 py-3 text-left text-sm font-medium text-[var(--eco-text)] transition-colors duration-150 hover:bg-[var(--eco-primary-soft)]"
            aria-label="Download as HTML"
          >
            {/* Download icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-5 w-5 shrink-0 text-[var(--eco-text-secondary)]"
            >
              <path d="M10.75 2.75a.75.75 0 00-1.5 0v8.614L6.295 8.235a.75.75 0 10-1.09 1.03l4.25 4.5a.75.75 0 001.09 0l4.25-4.5a.75.75 0 00-1.09-1.03l-2.955 3.129V2.75z" />
              <path d="M3.5 12.75a.75.75 0 00-1.5 0v2.5A2.75 2.75 0 004.75 18h10.5A2.75 2.75 0 0018 15.25v-2.5a.75.75 0 00-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5z" />
            </svg>
            Download as HTML
          </button>

          {/* Export as JSON */}
          <button
            type="button"
            onClick={handleExportJSON}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--eco-border)] px-4 py-3 text-left text-sm font-medium text-[var(--eco-text)] transition-colors duration-150 hover:bg-[var(--eco-primary-soft)]"
            aria-label="Export as JSON"
          >
            {/* Code icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-5 w-5 shrink-0 text-[var(--eco-text-secondary)]"
            >
              <path
                fillRule="evenodd"
                d="M6.28 5.22a.75.75 0 010 1.06L2.56 10l3.72 3.72a.75.75 0 01-1.06 1.06L.97 10.53a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0zm7.44 0a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 01-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 010-1.06z"
                clipRule="evenodd"
              />
            </svg>
            Export as JSON
          </button>
        </div>

        {copyStatus !== "idle" && (
          <p
            className="mt-3 text-xs"
            style={{
              color:
                copyStatus === "success"
                  ? "var(--eco-primary)"
                  : "var(--eco-coral)",
            }}
          >
            {copyStatusMessage}
          </p>
        )}

        {downloadError && (
          <div
            role="alert"
            className="mt-3 rounded-xl border border-[var(--eco-coral)]/20 bg-[var(--eco-coral)]/10 px-3 py-2 text-xs leading-5 text-[var(--eco-coral)]"
          >
            <div className="flex items-start justify-between gap-2">
              <p>{downloadError}</p>
              <button
                type="button"
                onClick={() => setDownloadError(null)}
                className="shrink-0 rounded-lg px-2 py-1 font-medium hover:bg-[var(--eco-coral)]/10"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Divider */}
        <div className="my-4 border-t border-[var(--eco-border)]" />

        {/* Privacy note */}
        <p className="text-center text-xs text-[var(--eco-text-muted)]">
          This export is created locally. Eco does not upload this conversation to make the file.
        </p>
      </div>
    </div>
  );
}
