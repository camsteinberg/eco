// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { motion, useReducedMotion } from "motion/react";
import { FernIllustration } from "@eco/ui";
import { useRouter, usePathname } from "next/navigation";
import { useConversationStore } from "../../stores/conversationStore";
import { ConversationItem } from "./ConversationItem";
import { BulkActionsBar } from "./BulkActionsBar";
import { SearchResults } from "./SearchResults";
import { searchMessages } from "../../lib/search";
import {
  exportConversationAsJSON,
  exportConversationAsMarkdown,
  downloadFile,
} from "../../lib/export";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ShareDialog } from "../share/ShareDialog";
import type { SearchResult } from "../../lib/search";
import type { Conversation } from "../../lib/types/conversation";
import { rememberPendingMessageFocus } from "../../lib/conversation-navigation";

const DAY_IN_MS = 1000 * 60 * 60 * 24;

function getCalendarDayStart(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function getElapsedCalendarDays(now: Date, date: Date): number {
  const diff = getCalendarDayStart(now) - getCalendarDayStart(date);
  return Math.max(0, Math.round(diff / DAY_IN_MS));
}

function getDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const diffDays = getElapsedCalendarDays(now, date);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "Previous 7 Days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 Days", "Older"];

function groupConversations(
  conversations: Conversation[]
): Map<string, Conversation[]> {
  const groups = new Map<string, Conversation[]>();
  for (const conv of conversations) {
    const group = getDateGroup(conv.updatedAt);
    const list = groups.get(group) ?? [];
    list.push(conv);
    groups.set(group, list);
  }
  return groups;
}

/**
 * Tiny mint-stroke seedling for the sidebar nested empty state.
 * Reuses the project's SeedlingIllustration path data scaled to 16px.
 * Spring entrance respects prefers-reduced-motion.
 */
const SPROUT_PATHS = (
  <>
    <path d="M60 90 C60 78, 60 66, 60 55" />
    <path d="M60 58 C52 52, 42 50, 38 54 C34 58, 40 64, 48 62 C52 61, 56 59, 60 58" />
    <path d="M60 58 C68 52, 78 50, 82 54 C86 58, 80 64, 72 62 C68 61, 64 59, 60 58" />
    <path d="M60 55 C58 48, 56 42, 58 38 C60 36, 62 38, 62 42 C62 46, 61 50, 60 55" />
  </>
);

function SidebarSprout() {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return (
      <svg width={16} height={16} viewBox="0 0 120 120" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--eco-primary)" }}>
        {SPROUT_PATHS}
      </svg>
    );
  }

  return (
    <motion.svg
      width={16}
      height={16}
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ color: "var(--eco-primary)" }}
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 80, damping: 15, delay: 0.2 }}
    >
      {SPROUT_PATHS}
    </motion.svg>
  );
}

/**
 * Standalone-sidebar empty state: a soft fern unfurling. Reuses the shared
 * @eco/ui FernIllustration; spring entrance respects prefers-reduced-motion.
 */
function SidebarFern() {
  const shouldReduceMotion = useReducedMotion();

  if (shouldReduceMotion) {
    return (
      <span className="text-[var(--eco-primary)] opacity-50" aria-hidden="true">
        <FernIllustration size={64} />
      </span>
    );
  }

  return (
    <motion.span
      className="text-[var(--eco-primary)]"
      aria-hidden="true"
      initial={{ scale: 0.8, opacity: 0, rotate: -4 }}
      animate={{ scale: 1, opacity: 0.5, rotate: 0 }}
      transition={{ type: "spring", stiffness: 70, damping: 16, delay: 0.1 }}
    >
      <FernIllustration size={64} />
    </motion.span>
  );
}

type ConversationListProps = {
  variant?: "standalone" | "nested";
};

export function ConversationList({ variant = "standalone" }: ConversationListProps) {
  const conversations = useConversationStore((s) => s.conversations);
  const activeId = useConversationStore((s) => s.activeConversationId);
  const persistenceError = useConversationStore((s) => s.persistenceError);
  const {
    setActive,
    renameConversation,
    removeConversation,
    pinConversation,
    unpinConversation,
    removeMultiple,
    activateSearchResult,
    clearPersistenceError,
  } = useConversationStore.getState();
  const router = useRouter();
  const pathname = usePathname();
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Multi-select state
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [sharingConv, setSharingConv] = useState<{ id: string; title: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const isNested = variant === "nested";

  // Reset multi-select when navigating away
  useEffect(() => {
    setMultiSelect(false);
    setSelectedIds(new Set());
  }, [pathname]);

  // Debounced full-text search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (!search.trim()) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);

    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchMessages(search);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      }
      setIsSearching(false);
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [search]);

  const handleDelete = useCallback(
    (id: string) => {
      setDeletingId(id);
      setTimeout(() => {
        removeConversation(id);
        setDeletingId(null);
      }, 200);
    },
    [removeConversation]
  );

  const handleSelectResult = useCallback(
    async (conversationId: string, messageId: string) => {
      rememberPendingMessageFocus({ conversationId, messageId });
      await activateSearchResult(conversationId, messageId);

      // Clear search to return to normal list view
      setSearch("");
      setSearchResults([]);

      // Navigate to chat if not already there
      if (pathname !== "/chat") {
        router.push("/chat");
      }
    },
    [activateSearchResult, pathname, router]
  );

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleExportJSON = useCallback(async (id: string, title: string) => {
    setExportError(null);
    try {
      const json = await exportConversationAsJSON(id);
      downloadFile(json, `${title}.json`, "application/json");
    } catch {
      setExportError("Eco could not export that conversation as JSON. Try again or choose Share for another local format.");
    }
  }, []);

  const handleExportMarkdown = useCallback(async (id: string, title: string) => {
    setExportError(null);
    try {
      const md = await exportConversationAsMarkdown(id);
      downloadFile(md, `${title}.md`, "text/markdown");
    } catch {
      setExportError("Eco could not export that conversation as Markdown. Try again or choose Share for another local format.");
    }
  }, []);

  const handleBulkDelete = useCallback(() => {
    removeMultiple([...selectedIds]);
    setSelectedIds(new Set());
    setMultiSelect(false);
    setConfirmBulkDelete(false);
  }, [selectedIds, removeMultiple]);

  const enterMultiSelect = useCallback(() => {
    setMultiSelect(true);
    setSelectedIds(new Set());
  }, []);

  const exitMultiSelect = useCallback(() => {
    setMultiSelect(false);
    setSelectedIds(new Set());
  }, []);

  const handleShare = useCallback((id: string, title: string) => {
    setSharingConv({ id, title });
  }, []);

  const recoverableFailureAlert = (persistenceError || exportError) ? (
    <div
      role="alert"
      className="mx-1 rounded-xl border border-[var(--eco-coral)]/20 bg-[var(--eco-coral)]/10 px-3 py-2 text-xs leading-5 text-[var(--eco-coral)]"
    >
      <div className="flex items-start justify-between gap-2">
        <p>{exportError ?? persistenceError}</p>
        <button
          type="button"
          onClick={() => {
            setExportError(null);
            clearPersistenceError();
          }}
          className="shrink-0 rounded-lg px-2 py-1 font-medium hover:bg-[var(--eco-coral)]/10"
        >
          Dismiss
        </button>
      </div>
    </div>
  ) : null;

  if (conversations.length === 0) {
    return (
      <div className={isNested ? "flex flex-col gap-2" : "flex flex-col gap-2 px-2 py-2"}>
        {recoverableFailureAlert}
        <div className={isNested
          ? "flex flex-col items-center gap-2 rounded-xl px-3 py-4 text-center text-xs leading-5 text-[var(--eco-text-secondary)]"
          : "flex flex-col items-center gap-3 px-3 py-8 text-center text-sm text-[var(--eco-text-secondary)]"}
        >
          {isNested ? (
            <SidebarSprout />
          ) : (
            <SidebarFern />
          )}
          {isNested ? "Your conversations will gather here." : "Your conversations will gather here. Start one above when you're ready."}
        </div>
      </div>
    );
  }

  // Sort by most recent first
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);

  // Separate pinned and unpinned
  const pinned = sorted
    .filter((c) => c.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const unpinned = sorted.filter((c) => c.pinnedAt == null);

  const groups = groupConversations(unpinned);

  const showSearchResults = search.trim().length > 0;

  function renderConversationItem(conv: Conversation) {
    return (
      <ConversationItem
        key={conv.id}
        conversation={conv}
        isActive={conv.id === activeId}
        isDeleting={conv.id === deletingId}
        isPinned={conv.pinnedAt != null}
        onSelect={() => {
          setActive(conv.id);
          if (pathname !== "/chat") router.push("/chat");
        }}
        onRename={(title) => renameConversation(conv.id, title)}
        onDelete={() => handleDelete(conv.id)}
        onPin={() => pinConversation(conv.id)}
        onUnpin={() => unpinConversation(conv.id)}
        onExportJSON={() => handleExportJSON(conv.id, conv.title)}
        onExportMarkdown={() => handleExportMarkdown(conv.id, conv.title)}
        onShare={() => handleShare(conv.id, conv.title)}
        isMultiSelect={multiSelect}
        isSelected={selectedIds.has(conv.id)}
        onToggleSelect={() => toggleSelection(conv.id)}
        variant={variant}
      />
    );
  }

  return (
    <div className={isNested ? "flex flex-col gap-1 pb-1" : "flex flex-col gap-1 px-2 py-2"}>
      <div className={isNested ? "flex items-center gap-1 px-1 pb-1" : "flex items-center gap-1 px-1 pb-1"}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={isNested ? "Search chats" : "Search conversations..."}
          className={`w-full border px-3 py-1.5 text-xs text-[var(--eco-text)] placeholder:text-[var(--eco-text-secondary)] transition-all duration-150 focus:border-[var(--eco-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/20 ${
            isNested
              ? "rounded-xl border-transparent bg-[var(--eco-primary-soft)]/35"
              : "rounded-lg border-[var(--eco-border)] bg-[var(--eco-surface)]"
          }`}
          aria-label="Search conversations"
          data-testid="conversation-search"
        />
        {!showSearchResults && (
          <button
            type="button"
            onClick={multiSelect ? exitMultiSelect : enterMultiSelect}
            className="shrink-0 rounded-xl px-2 py-1.5 text-xs font-medium text-[var(--eco-text-secondary)] transition-colors duration-150 hover:bg-[var(--eco-primary-soft)]/70 hover:text-[var(--eco-text)]"
            aria-label={multiSelect ? "Cancel selection" : "Select conversations"}
          >
            {multiSelect ? "Done" : "Edit"}
          </button>
        )}
      </div>
      {recoverableFailureAlert}
      {showSearchResults ? (
        <div className="flex flex-col gap-0.5">
          {isSearching ? (
            <p className="px-3 py-4 text-center text-xs text-[var(--eco-text-secondary)]">
              Searching...
            </p>
          ) : (
            <SearchResults
              results={searchResults}
              query={search}
              onSelectResult={handleSelectResult}
            />
          )}
        </div>
      ) : (
        <>
          <nav aria-label="Conversation list" className="flex flex-col gap-0.5">
            {pinned.length > 0 && (
              <div>
                <h3 className={isNested
                  ? "px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--eco-text-secondary)]/65"
                  : "px-3 py-2 font-serif text-xs font-medium uppercase tracking-wider text-[var(--eco-text-secondary)]"}
                >
                  Pinned
                </h3>
                {pinned.map(renderConversationItem)}
              </div>
            )}
            {GROUP_ORDER.filter((g) => groups.has(g)).map((group, groupIdx) => (
              <div key={group}>
                <h3
                  className={isNested
                    ? `px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--eco-text-secondary)]/65 ${groupIdx === 0 && pinned.length === 0 ? '' : 'mt-2'}`
                    : `px-3 py-2 font-serif text-xs font-medium uppercase tracking-wider text-[var(--eco-text-secondary)] ${groupIdx === 0 && pinned.length === 0 ? '' : 'mt-4'}`}
                >
                  {group}
                </h3>
                {groups.get(group)!.map(renderConversationItem)}
              </div>
            ))}
          </nav>
          {multiSelect && (
            <BulkActionsBar
              selectedCount={selectedIds.size}
              onSelectAll={() => {
                setSelectedIds(new Set(conversations.map((c) => c.id)));
              }}
              onDeselectAll={() => {
                setSelectedIds(new Set());
              }}
              onDelete={() => setConfirmBulkDelete(true)}
              onCancel={exitMultiSelect}
            />
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmBulkDelete}
        title={`Delete ${selectedIds.size} conversation${selectedIds.size === 1 ? '' : 's'}?`}
        message="This cannot be undone. All selected conversations and their messages will be permanently deleted."
        confirmLabel="Delete"
        destructive
        onConfirm={handleBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      <ShareDialog
        open={sharingConv !== null}
        onClose={() => setSharingConv(null)}
        conversationId={sharingConv?.id ?? ""}
        conversationTitle={sharingConv?.title ?? ""}
      />
    </div>
  );
}
