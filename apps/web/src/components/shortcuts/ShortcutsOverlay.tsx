// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useEffect, useCallback } from "react";

type ShortcutsOverlayProps = {
  open: boolean;
  onClose: () => void;
};

const isMac =
  typeof navigator !== "undefined" && navigator.platform?.includes("Mac");
const mod = isMac ? "Cmd" : "Ctrl";

type ShortcutEntry = {
  keys: readonly string[];
  description: string;
};

type ShortcutSection = {
  label: string;
  items: readonly ShortcutEntry[];
};

const shortcutSections: readonly ShortcutSection[] = [
  {
    label: "General",
    items: [
      { keys: ["Enter"], description: "Send message" },
      { keys: [mod, "N"], description: "New chat" },
      { keys: [mod, "K"], description: "Command palette" },
    ],
  },
  {
    label: "Navigation",
    items: [
      { keys: [mod, "F"], description: "Search in conversation" },
      { keys: [mod, "B"], description: "Collapse sidebar to icons" },
      { keys: [mod, "Shift", "S"], description: "Toggle sidebar" },
    ],
  },
  {
    label: "Export",
    items: [
      { keys: [mod, "Shift", "E"], description: "Export as Markdown" },
      { keys: [mod, "Shift", "D"], description: "Export as JSON" },
      { keys: [mod, "Shift", "L"], description: "Share conversation" },
    ],
  },
  {
    label: "Other",
    items: [
      { keys: [mod, "/"], description: "Keyboard shortcuts" },
      { keys: ["Esc"], description: "Close overlay / cancel" },
    ],
  },
] as const;

/**
 * Keyboard shortcuts overlay panel. Shows all available shortcuts
 * in a centered modal with backdrop.
 */
export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center motion-safe:animate-[fadeIn_150ms_ease-out]"
      role="dialog"
      aria-label="Keyboard shortcuts"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--eco-scrim)]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-6 shadow-lg">
        <h2 className="mb-4 text-lg font-semibold text-[var(--eco-text)]">
          Keyboard shortcuts
        </h2>

        <div className="space-y-4">
          {shortcutSections.map(({ label, items }) => (
            <div key={label}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--eco-text-muted)]">
                {label}
              </h3>
              <div className="space-y-2">
                {items.map(({ keys, description }) => (
                  <div
                    key={description}
                    className="flex items-center justify-between"
                  >
                    <span className="text-sm text-[var(--eco-text-secondary)]">
                      {description}
                    </span>
                    <div className="flex items-center gap-1">
                      {keys.map((key) => (
                        <kbd
                          key={key}
                          className="inline-flex min-w-[1.75rem] items-center justify-center rounded-md border border-[var(--eco-border)] bg-[var(--eco-surface)] px-2 py-1 text-xs font-medium text-[var(--eco-text)]"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
