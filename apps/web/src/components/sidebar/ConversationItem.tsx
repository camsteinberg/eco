// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useRef, useEffect } from "react";
import type { Conversation } from "../../lib/types/conversation";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { timeAgo } from "../../lib/time";

type ConversationItemProps = {
  conversation: Conversation;
  isActive: boolean;
  variant?: "standalone" | "nested";
  isDeleting?: boolean;
  isPinned?: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onPin?: () => void;
  onUnpin?: () => void;
  onExportJSON?: () => void;
  onExportMarkdown?: () => void;
  onShare?: () => void;
  isMultiSelect?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
};

export function ConversationItem({
  conversation,
  isActive,
  variant = "standalone",
  isDeleting,
  isPinned,
  onSelect,
  onRename,
  onDelete,
  onPin,
  onUnpin,
  onExportJSON,
  onExportMarkdown,
  onShare,
  isMultiSelect,
  isSelected,
  onToggleSelect,
}: ConversationItemProps) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  function handleRename() {
    const trimmed = title.trim();
    if (trimmed && trimmed !== conversation.title) {
      onRename(trimmed);
    } else {
      setTitle(conversation.title);
    }
    setEditing(false);
  }

  const preview = conversation.preview ?? "New conversation";
  const isNested = variant === "nested";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (isMultiSelect) {
          onToggleSelect?.();
        } else {
          onSelect();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (isMultiSelect) {
            onToggleSelect?.();
          } else {
            onSelect();
          }
        }
      }}
      className={[
        "group flex cursor-pointer flex-col gap-0.5 transition-all duration-150 ease",
        isNested ? "rounded-xl px-2.5 py-2 text-xs" : "rounded-lg px-3 py-2 text-sm",
        isActive && !isMultiSelect
          ? "border-l-2 border-l-[var(--eco-primary)] bg-[var(--eco-primary-soft)] text-[var(--eco-text)]"
          : "border-l-2 border-l-transparent text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]/70",
        isMultiSelect && isSelected
          ? "bg-[var(--eco-primary-soft)]/50"
          : "",
        isDeleting ? "slide-out-left" : "",
      ].join(" ")}
      aria-current={isActive && !isMultiSelect ? "page" : undefined}
    >
      <div className="flex items-center justify-between">
        {isMultiSelect && (
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect?.();
            }}
            className={[
              "mr-2 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150",
              isSelected
                ? "border-[var(--eco-primary)] bg-[var(--eco-primary)] text-white"
                : "border-[var(--eco-border)] bg-transparent",
            ].join(" ")}
            aria-label={isSelected ? "Deselect conversation" : "Select conversation"}
          >
            {isSelected && (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
                <path fillRule="evenodd" d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z" clipRule="evenodd" />
              </svg>
            )}
          </button>
        )}
        {editing ? (
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
              if (e.key === "Escape") {
                setTitle(conversation.title);
                setEditing(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full rounded border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-1 py-0.5 text-sm text-[var(--eco-text)]"
            aria-label="Rename conversation"
          />
        ) : (
          <span className="truncate font-medium">{conversation.title}</span>
        )}
        {!isMultiSelect && !editing && (
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-[var(--eco-text-secondary)] opacity-100 transition-opacity duration-150 hover:text-[var(--eco-text)] md:min-h-0 md:min-w-0 md:opacity-0 md:group-hover:opacity-100"
              aria-label="Conversation menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4">
                <path d="M8 2a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM8 6.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM8 11a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" />
              </svg>
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] py-1 shadow-lg"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    setEditing(true);
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]"
                >
                  Rename
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    if (isPinned) {
                      onUnpin?.();
                    } else {
                      onPin?.();
                    }
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]"
                >
                  {isPinned ? "Unpin" : "Pin"}
                </button>
                <div className="my-1 border-t border-[var(--eco-border)]" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onExportJSON?.();
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]"
                >
                  Export as JSON
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    onExportMarkdown?.();
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]"
                >
                  Export as Markdown
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    onShare?.();
                    setMenuOpen(false);
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]"
                >
                  Share
                </button>
                <div className="my-1 border-t border-[var(--eco-border)]" role="separator" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    setConfirmDelete(true);
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-sm text-[var(--eco-coral)] hover:bg-[var(--eco-primary-soft)]"
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className={`${isNested ? "max-w-[8.5rem]" : ""} truncate text-xs text-[var(--eco-text-secondary)]`}>
          {preview}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--eco-text-secondary)]">
          {timeAgo(conversation.updatedAt)}
        </span>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete conversation?"
        message="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
