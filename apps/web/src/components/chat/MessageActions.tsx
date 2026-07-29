// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";

import { copyTextWithFallback } from "../../lib/clipboard";

type MessageActionsProps = {
  content: string;
  role: "user" | "assistant";
  onEdit?: () => void;
  onRegenerate?: () => void;
  onAssistantAction?: (action: AssistantFollowUpAction) => void;
  isLatestAssistant?: boolean;
  /** Dev-gated (lib/dev-capture.ts): flag this reply into the eval capture set. */
  onFlagForEval?: () => void;
  /**
   * True when `content` is already plain text (a canonical exact-answer tool result
   * like "17 * 23 = 391"), so the "Copy" button must NOT run it through
   * strip-markdown — remark would parse a bare `*` as emphasis and drop it,
   * corrupting the computed value. Copies the string verbatim instead.
   */
  plainText?: boolean;
};

export type AssistantFollowUpAction = "continue" | "shorter" | "expand" | "simplify";

export function MessageActions({
  content,
  role,
  onEdit,
  onRegenerate,
  onAssistantAction,
  isLatestAssistant,
  onFlagForEval,
  plainText = false,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const handleCopyPlainText = useCallback(() => {
    // Canonical exact-answer results are already plain text — copy them verbatim.
    // Running "17 * 23 = 391" through strip-markdown would parse the `*` as
    // emphasis and drop it, corrupting the value the user asked for.
    const textPromise = plainText
      ? Promise.resolve(content)
      : import("remark").then(async ({ remark }) => {
          const { default: stripMarkdown } = await import("strip-markdown");
          const result = await remark().use(stripMarkdown).process(content);
          return String(result).trim();
        });

    // copyTextWithFallback (writeText race + execCommand fallback) is the
    // reliable cross-browser path — on iOS a bare writeText after async work
    // silently fails because the tap's user-activation has expired. Success
    // feedback only flips on an actual success.
    void textPromise
      .then((text) => copyTextWithFallback(text))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Genuine failure (no async clipboard AND no execCommand) — leave the
        // button idle rather than claim a copy that didn't happen.
      });
  }, [content, plainText]);

  const handleCopyMarkdown = useCallback(() => {
    setMenuOpen(false);
    void copyTextWithFallback(content)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // See handleCopyPlainText — don't surface a success state that didn't happen.
      });
  }, [content]);

  // Close menu on click outside or Escape
  useEffect(() => {
    if (!menuOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (menuOpen) {
      firstMenuItemRef.current?.focus();
    }
  }, [menuOpen]);

  const actionButtonClass =
    "flex h-7 w-7 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 items-center justify-center rounded-md text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-primary-soft)] hover:text-[var(--eco-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)] motion-reduce:transition-none";
  const menuItemClass =
    "flex w-full items-center gap-2 px-3 py-1.5 min-h-[44px] md:min-h-0 text-left text-sm text-[var(--eco-text)] transition-colors hover:bg-[var(--eco-primary-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--eco-primary)] motion-reduce:transition-none";

  return (
    <div className="flex items-center gap-1 rounded-lg border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-1 opacity-100 shadow-sm transition-opacity focus-within:opacity-100 motion-reduce:transition-none md:opacity-0 md:group-hover:opacity-100">
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Message copied to clipboard" : ""}
      </span>
      {/* Copy plain text */}
      <button
        type="button"
        onClick={handleCopyPlainText}
        className={actionButtonClass}
        aria-label={copied ? "Copied" : "Copy message"}
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="var(--eco-success)"
            className="h-3.5 w-3.5"
          >
            <path
              fillRule="evenodd"
              d="M12.416 3.376a.75.75 0 0 1 .208 1.04l-5 7.5a.75.75 0 0 1-1.154.114l-3-3a.75.75 0 0 1 1.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 0 1 1.04-.207Z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M5.5 3.5A1.5 1.5 0 0 1 7 2h5.5A1.5 1.5 0 0 1 14 3.5v7a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 10.5v-7Z" />
            <path d="M3 5a1 1 0 0 0-1 1v7.5A1.5 1.5 0 0 0 3.5 15H11a1 1 0 0 0 1-1H3.5a.5.5 0 0 1-.5-.5V5Z" />
          </svg>
        )}
      </button>

      {/* Edit button - user messages only */}
      {role === "user" && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className={actionButtonClass}
          aria-label="Edit message"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M13.488 2.513a1.75 1.75 0 0 0-2.475 0L6.75 6.774a2.75 2.75 0 0 0-.596.892l-.848 2.047a.75.75 0 0 0 .98.98l2.047-.848a2.75 2.75 0 0 0 .892-.596l4.261-4.262a1.75 1.75 0 0 0 0-2.474Z" />
            <path d="M4.75 3.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h6.5c.69 0 1.25-.56 1.25-1.25V9A.75.75 0 0 1 14 9v2.25A2.75 2.75 0 0 1 11.25 14h-6.5A2.75 2.75 0 0 1 2 11.25v-6.5A2.75 2.75 0 0 1 4.75 2H7a.75.75 0 0 1 0 1.5H4.75Z" />
          </svg>
        </button>
      )}

      {/* Regenerate button - latest assistant message only */}
      {role === "assistant" && isLatestAssistant && onRegenerate && (
        <button
          type="button"
          onClick={onRegenerate}
          className={actionButtonClass}
          aria-label="Regenerate response"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path
              fillRule="evenodd"
              d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08.681.75.75 0 0 1-1.3-.75 6 6 0 0 1 9.44-.908l.84.84V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44.908l-.84-.84v1.836a.75.75 0 0 1-1.5 0v-3.182a.75.75 0 0 1 .75-.75h3.182a.75.75 0 0 1 0 1.5H3.98l.84.841a4.5 4.5 0 0 0 7.08-.681.75.75 0 0 1 1.025-.274Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      )}

      {/* Three-dot menu */}
      <div ref={menuRef} className="relative">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setMenuOpen(!menuOpen)}
          className={actionButtonClass}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M8 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9.5 12.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
          </svg>
        </button>
        {menuOpen && (
          <div
            id={menuId}
            role="menu"
            aria-label="Message actions"
            className="absolute bottom-full right-0 mb-1 min-w-[160px] rounded-lg border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] py-1 shadow-lg"
          >
            {role === "assistant" && isLatestAssistant && onAssistantAction && (
              <>
                <button
                  ref={firstMenuItemRef}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAssistantAction("continue");
                    setMenuOpen(false);
                  }}
                  className={menuItemClass}
                >
                  Continue
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAssistantAction("shorter");
                    setMenuOpen(false);
                  }}
                  className={menuItemClass}
                >
                  Make shorter
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAssistantAction("expand");
                    setMenuOpen(false);
                  }}
                  className={menuItemClass}
                >
                  Expand
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAssistantAction("simplify");
                    setMenuOpen(false);
                  }}
                  className={menuItemClass}
                >
                  Explain simply
                </button>
                <div className="my-1 h-px bg-[var(--eco-border)]" role="none" />
              </>
            )}
            <button
              ref={role === "assistant" && isLatestAssistant && onAssistantAction ? undefined : firstMenuItemRef}
              type="button"
              role="menuitem"
              onClick={handleCopyMarkdown}
              className={menuItemClass}
            >
              Copy as Markdown
            </button>
            {role === "assistant" && onFlagForEval && (
              <>
                <div className="my-1 h-px bg-[var(--eco-border)]" role="none" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onFlagForEval();
                    setMenuOpen(false);
                  }}
                  className={menuItemClass}
                >
                  Flag for eval…
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
