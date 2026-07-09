// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { SearchResult } from "../../lib/search";
import { LeafIllustration } from "../illustrations/LeafIllustration";

type SearchResultsProps = {
  results: SearchResult[];
  query: string;
  onSelectResult: (conversationId: string, messageId: string) => void;
};

function HighlightedSnippet({
  snippet,
  query,
}: {
  snippet: string;
  query: string;
}) {
  if (!query) return <span>{snippet}</span>;

  const lowerSnippet = snippet.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: { text: string; isMatch: boolean }[] = [];
  let lastIndex = 0;

  let idx = lowerSnippet.indexOf(lowerQuery, lastIndex);
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push({ text: snippet.slice(lastIndex, idx), isMatch: false });
    }
    parts.push({
      text: snippet.slice(idx, idx + query.length),
      isMatch: true,
    });
    lastIndex = idx + query.length;
    idx = lowerSnippet.indexOf(lowerQuery, lastIndex);
  }
  if (lastIndex < snippet.length) {
    parts.push({ text: snippet.slice(lastIndex), isMatch: false });
  }

  return (
    <span>
      {parts.map((part, i) =>
        part.isMatch ? (
          <mark
            key={i}
            className="rounded-sm bg-[var(--eco-primary-soft)] px-0.5 text-[var(--eco-text)]"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </span>
  );
}

export function SearchResults({
  results,
  query,
  onSelectResult,
}: SearchResultsProps) {
  if (results.length === 0 && query.trim()) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <LeafIllustration className="h-16 w-16" style={{ color: "var(--eco-primary)" }} />
        <p className="text-sm font-medium text-[var(--eco-text)]">No conversations found</p>
        <p className="text-xs text-[var(--eco-text-secondary)]">Try different words, or start a new conversation.</p>
      </div>
    );
  }

  return (
    <div role="listbox" aria-label="Search results" className="flex flex-col gap-0.5">
      {results.map((result) => (
        <button
          key={`${result.conversationId}-${result.messageId}`}
          type="button"
          role="option"
          aria-selected={false}
          onClick={() => onSelectResult(result.conversationId, result.messageId)}
          className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-[var(--eco-surface-elevated)]"
        >
          <div className="truncate text-sm font-medium text-[var(--eco-text)]">
            {result.conversationTitle}
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-[var(--eco-text-secondary)]">
            <HighlightedSnippet snippet={result.snippet} query={query} />
          </div>
        </button>
      ))}
    </div>
  );
}
