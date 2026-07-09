// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useState, useRef, useEffect, useCallback } from "react";

type EditMessageProps = {
  content: string;
  onSave: (newContent: string) => void;
  onCancel: () => void;
};

export function EditMessage({ content, onSave, onCancel }: EditMessageProps) {
  const [value, setValue] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus with cursor at end (mount-only)
  const hasFocused = useRef(false);
  useEffect(() => {
    if (hasFocused.current) return;
    hasFocused.current = true;
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    }
  }, [value.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    },
    [onCancel]
  );

  const trimmedValue = value.trim();
  const isDisabled = !trimmedValue || trimmedValue === content;

  return (
    <div className="w-full space-y-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full resize-none rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-3 py-2 text-[15px] text-[var(--eco-text)] focus:outline-none focus:ring-2 focus:ring-[var(--eco-primary)]/15"
        rows={3}
        aria-label="Edit message"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-[var(--eco-text-secondary)] transition-colors hover:bg-[var(--eco-surface-elevated)]"
          aria-label="Cancel edit"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onSave(trimmedValue)}
          disabled={isDisabled}
          className="rounded-lg px-3 py-1.5 text-sm text-white transition-colors disabled:opacity-40"
          style={{ backgroundColor: "var(--eco-primary)" }}
          aria-label="Save & Submit"
        >
          Save & Submit
        </button>
      </div>
    </div>
  );
}
