// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { ChatMessage } from "../../stores/chatStore";

export type SearchMatch = {
  messageId: string;
  matchIndex: number;
};

/**
 * Build an index of all substring matches for `query` across the given messages.
 * Skips system messages. Case-insensitive.
 */
export function buildMatchIndex(
  messages: ChatMessage[],
  query: string
): SearchMatch[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const lowerQuery = trimmed.toLowerCase();
  const matches: SearchMatch[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    const lowerContent = msg.content.toLowerCase();
    let matchIndex = 0;
    let pos = 0;

    while (true) {
      const idx = lowerContent.indexOf(lowerQuery, pos);
      if (idx === -1) break;
      matches.push({ messageId: msg.id, matchIndex });
      matchIndex++;
      pos = idx + 1;
    }
  }

  return matches;
}

type InConversationSearchProps = {
  messages: ChatMessage[];
  isOpen: boolean;
  onClose: () => void;
};

export function InConversationSearch({
  messages,
  isOpen,
  onClose,
}: InConversationSearchProps) {
  const [query, setQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(
    () => buildMatchIndex(messages, query),
    [messages, query]
  );

  // Reset match index when query changes
  const prevQueryRef = useRef(query);
  useEffect(() => {
    if (query !== prevQueryRef.current) {
      setCurrentMatchIndex(0);
      prevQueryRef.current = query;
    }
  }, [query]);

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Clear query when closed
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setCurrentMatchIndex(0);
    }
  }, [isOpen]);

  // Scroll to matched message when currentMatchIndex changes
  useEffect(() => {
    if (matches.length > 0 && currentMatchIndex < matches.length) {
      const match = matches[currentMatchIndex];
      if (match) {
        window.dispatchEvent(
          new CustomEvent("scrollToMessage", {
            detail: { messageId: match.messageId },
          })
        );
      }
    }
  }, [currentMatchIndex, matches]);

  const goToNext = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const goToPrev = useCallback(() => {
    if (matches.length === 0) return;
    setCurrentMatchIndex(
      (prev) => (prev - 1 + matches.length) % matches.length
    );
  }, [matches.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        goToPrev();
      } else if (e.key === "Enter") {
        e.preventDefault();
        goToNext();
      }
    },
    [onClose, goToNext, goToPrev]
  );

  if (!isOpen) return null;

  const matchCountDisplay = (() => {
    if (query.trim().length === 0) return null;
    if (matches.length === 0) return "No matches";
    return `${currentMatchIndex + 1} of ${matches.length}`;
  })();

  return (
    <div
      className="eco-grain-subtle absolute left-0 right-0 top-0 z-20 flex items-center gap-2 border-b px-4 py-2"
      style={{
        backgroundColor: "var(--eco-surface-elevated)",
        borderColor: "var(--eco-border)",
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search in conversation..."
        autoFocus
        className="flex-1 rounded-md border border-[var(--eco-border)] px-3 py-1.5 text-sm transition-all duration-150 focus:border-[var(--eco-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/20"
        style={{
          backgroundColor: "var(--eco-surface)",
          color: "var(--eco-text)",
        }}
        aria-label="Search in conversation"
      />

      {matchCountDisplay && (
        <span
          className="whitespace-nowrap text-xs"
          style={{ color: "var(--eco-text-secondary)" }}
        >
          {matchCountDisplay}
        </span>
      )}

      <button
        type="button"
        onClick={goToPrev}
        disabled={matches.length === 0}
        aria-label="Previous match"
        className="rounded p-1 transition-colors hover:bg-[var(--eco-surface-hover)] disabled:opacity-40"
        style={{ color: "var(--eco-text-secondary)" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path
            fillRule="evenodd"
            d="M14.77 12.79a.75.75 0 01-1.06-.02L10 8.832l-3.71 3.938a.75.75 0 01-1.08-1.04l4.25-4.5a.75.75 0 011.08 0l4.25 4.5a.75.75 0 01-.02 1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      <button
        type="button"
        onClick={goToNext}
        disabled={matches.length === 0}
        aria-label="Next match"
        className="rounded p-1 transition-colors hover:bg-[var(--eco-surface-hover)] disabled:opacity-40"
        style={{ color: "var(--eco-text-secondary)" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        className="rounded p-1 transition-colors hover:bg-[var(--eco-surface-hover)]"
        style={{ color: "var(--eco-text-secondary)" }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className="h-4 w-4"
        >
          <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
        </svg>
      </button>
    </div>
  );
}
