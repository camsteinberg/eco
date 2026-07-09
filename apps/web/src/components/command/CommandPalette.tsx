// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useRouter } from "next/navigation";
import { useConversationStore } from "../../stores/conversationStore";

const isMac =
  typeof navigator !== "undefined" && navigator.platform?.includes("Mac");
const mod = isMac ? "Cmd" : "Ctrl";

export type CommandItem = {
  id: string;
  label: string;
  section: "Actions" | "Conversations";
  icon?: React.ReactNode;
  shortcut?: string[];
  action: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  onAction: (action: string) => void;
};

/** Maximum number of conversations shown when the query is empty. */
const MAX_RECENT_CONVERSATIONS = 5;

/**
 * Cmd+K command palette for quick navigation and actions.
 * Provides action search and conversation navigation with keyboard support.
 */
export function CommandPalette({ open, onClose, onAction }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const router = useRouter();
  const conversations = useConversationStore((s) => s.conversations);
  const activeConversationId = useConversationStore((s) => s.activeConversationId);

  const actions: CommandItem[] = useMemo(
    () => [
      {
        id: "new-chat",
        label: "New chat",
        section: "Actions" as const,
        shortcut: [mod, "N"],
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ),
        action: () => {
          onAction("newChat");
          onClose();
        },
      },
      {
        id: "toggle-sidebar",
        label: "Toggle sidebar",
        section: "Actions" as const,
        shortcut: [mod, "Shift", "S"],
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5.5 2.5v11" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        ),
        action: () => {
          onAction("toggleSidebar");
          onClose();
        },
      },
      {
        id: "toggle-theme",
        label: "Toggle theme",
        section: "Actions" as const,
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ),
        action: () => {
          onAction("toggleTheme");
          onClose();
        },
      },
      ...(activeConversationId
        ? [
            {
              id: "search-conversation",
              label: "Search current conversation",
              section: "Actions" as const,
              shortcut: [mod, "F"],
              icon: (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ),
              action: () => {
                onAction("searchConversation");
                onClose();
              },
            },
          ]
        : []),
      {
        id: "export-md",
        label: "Export as Markdown",
        section: "Actions" as const,
        shortcut: [mod, "Shift", "E"],
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 12V4l3 3 3-3v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        action: () => {
          onAction("exportMarkdown");
          onClose();
        },
      },
      {
        id: "export-json",
        label: "Export as JSON",
        section: "Actions" as const,
        shortcut: [mod, "Shift", "D"],
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 3C3.5 3 3 4 3 5v1.5C3 7.5 2 8 2 8s1 .5 1 1.5V11c0 1 .5 2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M11 3c1.5 0 2 1 2 2v1.5c0 1 1 1.5 1 1.5s-1 .5-1 1.5V11c0 1-.5 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        ),
        action: () => {
          onAction("exportJSON");
          onClose();
        },
      },
      {
        id: "share",
        label: "Share conversation",
        section: "Actions" as const,
        shortcut: [mod, "Shift", "L"],
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 9V12.5C4 13.05 4.45 13.5 5 13.5H11C11.55 13.5 12 13.05 12 12.5V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M8 2.5V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M5.5 5L8 2.5L10.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
        action: () => {
          onAction("shareConversation");
          onClose();
        },
      },
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        section: "Actions" as const,
        shortcut: [mod, "/"],
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="4.5" width="13" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 8h1M7.5 8h1M11 8h1M5 10.5h6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        ),
        action: () => {
          onAction("showShortcuts");
          onClose();
        },
      },
    ],
    [activeConversationId, onAction, onClose]
  );

  const conversationItems: CommandItem[] = useMemo(
    () =>
      conversations.map((conv) => ({
        id: `conv-${conv.id}`,
        label: conv.title,
        section: "Conversations" as const,
        icon: (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.5 3.5h11v8h-5l-3 2v-2h-3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        ),
        action: () => {
          useConversationStore.getState().setActive(conv.id);
          router.push("/chat");
          onClose();
        },
      })),
    [conversations, router, onClose]
  );

  const filteredItems: CommandItem[] = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      // Empty query: all actions + recent 5 conversations
      return [
        ...actions,
        ...conversationItems.slice(0, MAX_RECENT_CONVERSATIONS),
      ];
    }
    const matchedActions = actions.filter((a) =>
      a.label.toLowerCase().includes(q)
    );
    const matchedConversations = conversationItems.filter((c) =>
      c.label.toLowerCase().includes(q)
    );
    return [...matchedActions, ...matchedConversations];
  }, [query, actions, conversationItems]);

  // Group items by section for rendering
  const sections = useMemo(() => {
    const grouped: { label: string; items: CommandItem[] }[] = [];
    const actionItems = filteredItems.filter((i) => i.section === "Actions");
    const convItems = filteredItems.filter(
      (i) => i.section === "Conversations"
    );
    if (actionItems.length > 0) {
      grouped.push({ label: "Actions", items: actionItems });
    }
    if (convItems.length > 0) {
      grouped.push({ label: "Conversations", items: convItems });
    }
    return grouped;
  }, [filteredItems]);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Autofocus with a small delay to ensure the input is mounted
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Clamp selectedIndex when filteredItems change
  useEffect(() => {
    setSelectedIndex((prev) =>
      filteredItems.length === 0 ? 0 : Math.min(prev, filteredItems.length - 1)
    );
  }, [filteredItems]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[aria-selected="true"]');
    if (selected && typeof selected.scrollIntoView === "function") {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  const executeItem = useCallback(
    (item: CommandItem) => {
      item.action();
    },
    []
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < filteredItems.length - 1 ? prev + 1 : prev
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : prev));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredItems[selectedIndex]) {
            executeItem(filteredItems[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "Tab": {
          // Trap focus inside the dialog
          e.preventDefault();
          inputRef.current?.focus();
          break;
        }
      }
    },
    [filteredItems, selectedIndex, executeItem, onClose]
  );

  if (!open) return null;

  // Compute a flat index for each item across sections
  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] motion-safe:animate-[fadeIn_150ms_ease-out]"
      role="dialog"
      aria-label="Command palette"
      aria-modal="true"
      onKeyDown={handleKeyDown}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--eco-scrim)]"
        onClick={onClose}
        aria-hidden="true"
        data-testid="command-palette-backdrop"
      />

      {/* Panel */}
      <div className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] shadow-lg">
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-[var(--eco-border)] px-4 py-3">
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-[var(--eco-text-muted)]"
          >
            <circle cx="7.5" cy="7.5" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11.5 11.5L16 16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-base text-[var(--eco-text)] placeholder:text-[var(--eco-text-muted)] outline-none"
            role="combobox"
            aria-label="Search commands"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-activedescendant={filteredItems[selectedIndex] ? `cmd-option-${filteredItems[selectedIndex].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
          aria-label="Command results"
          className="max-h-80 overflow-y-auto px-2 py-2"
        >
          {sections.map((section) => (
            <div key={section.label}>
              <div className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-[var(--eco-text-muted)]">
                {section.label}
              </div>
              {section.items.map((item) => {
                const itemIndex = flatIndex++;
                const isSelected = itemIndex === selectedIndex;
                return (
                  <div
                    key={item.id}
                    id={`cmd-option-${item.id}`}
                    role="option"
                    aria-selected={isSelected}
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                      isSelected
                        ? "bg-[var(--eco-primary)]/10 text-[var(--eco-text)]"
                        : "text-[var(--eco-text-secondary)] hover:bg-[var(--eco-primary)]/5"
                    }`}
                    onClick={() => executeItem(item)}
                    data-testid={`command-item-${item.id}`}
                  >
                    {item.icon && (
                      <span className="shrink-0 text-[var(--eco-text-muted)]">
                        {item.icon}
                      </span>
                    )}
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.shortcut && (
                      <div className="flex items-center gap-1">
                        {item.shortcut.map((key, i) => (
                          <kbd
                            key={`${key}-${i}`}
                            className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-[var(--eco-border)] bg-[var(--eco-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--eco-text-muted)]"
                          >
                            {key}
                          </kbd>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {filteredItems.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-[var(--eco-text-muted)]">
              No results found
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 border-t border-[var(--eco-border)] px-4 py-2 text-xs text-[var(--eco-text-muted)]">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--eco-border)] bg-[var(--eco-surface)] px-1 py-0.5 text-[10px]">
              &#8593;&#8595;
            </kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--eco-border)] bg-[var(--eco-surface)] px-1 py-0.5 text-[10px]">
              Enter
            </kbd>
            Select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--eco-border)] bg-[var(--eco-surface)] px-1 py-0.5 text-[10px]">
              Esc
            </kbd>
            Close
          </span>
        </div>
      </div>
    </div>
  );
}
