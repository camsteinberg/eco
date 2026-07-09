// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useRef } from "react";

export type ShortcutHandlers = {
  newChat?: () => void;
  toggleSidebar?: () => void;
  showShortcuts?: () => void;
  collapseSidebar?: () => void;
  exportMarkdown?: () => void;
  exportJSON?: () => void;
  openCommandPalette?: () => void;
  shareConversation?: () => void;
};

/**
 * Register global keyboard shortcuts on the document.
 *
 * Global shortcuts (fire even in inputs):
 * - Ctrl/Cmd+N: new chat
 * - Ctrl/Cmd+K: command palette
 *
 * Non-global shortcuts (skipped in inputs):
 * - Ctrl/Cmd+Shift+S: toggle sidebar
 * - Ctrl/Cmd+B: collapse sidebar
 * - Ctrl/Cmd+Shift+E: export as markdown
 * - Ctrl/Cmd+Shift+D: export as JSON
 * - Ctrl/Cmd+Shift+L: share conversation
 * - Ctrl/Cmd+/: show shortcuts overlay
 *
 * Note: Ctrl/Cmd+F (search in conversation) is handled in chat/page.tsx
 * because it depends on page-specific state.
 *
 * Uses a ref for handlers to avoid re-registering the listener on every render.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "TEXTAREA" ||
        target.tagName === "INPUT" ||
        target.isContentEditable;

      // --- Global shortcuts (fire even in inputs) ---

      // Ctrl/Cmd+N: new chat
      if (e.key === "n") {
        e.preventDefault();
        handlersRef.current.newChat?.();
        return;
      }

      // Ctrl/Cmd+K: command palette
      if (e.key === "k") {
        e.preventDefault();
        handlersRef.current.openCommandPalette?.();
        return;
      }

      // --- Non-global shortcuts (skip in inputs) ---
      if (isInput) return;

      // Ctrl/Cmd+B: collapse sidebar
      if (e.key === "b") {
        e.preventDefault();
        handlersRef.current.collapseSidebar?.();
        return;
      }

      // Ctrl/Cmd+Shift+S: toggle sidebar
      if (e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        handlersRef.current.toggleSidebar?.();
        return;
      }

      // Ctrl/Cmd+Shift+E: export as markdown
      if (e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        handlersRef.current.exportMarkdown?.();
        return;
      }

      // Ctrl/Cmd+Shift+D: export as JSON
      if (e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        handlersRef.current.exportJSON?.();
        return;
      }

      // Ctrl/Cmd+Shift+L: share conversation
      if (e.shiftKey && (e.key === "L" || e.key === "l")) {
        e.preventDefault();
        handlersRef.current.shareConversation?.();
        return;
      }

      // Ctrl/Cmd+/: show shortcuts overlay
      if (e.key === "/") {
        e.preventDefault();
        handlersRef.current.showShortcuts?.();
        return;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
}
