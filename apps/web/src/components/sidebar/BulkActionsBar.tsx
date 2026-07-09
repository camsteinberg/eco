// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type BulkActionsBarProps = {
  selectedCount: number;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDelete: () => void;
  onCancel: () => void;
};

export function BulkActionsBar({
  selectedCount,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onCancel,
}: BulkActionsBarProps) {
  return (
    <div className="sticky bottom-0 flex items-center justify-between border-t border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-3 py-2">
      <span className="text-xs font-medium text-[var(--eco-text-secondary)]">
        {selectedCount} selected
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={selectedCount > 0 ? onDeselectAll : onSelectAll}
          className="rounded px-2 py-1 text-xs text-[var(--eco-text-secondary)] transition-colors duration-150 hover:text-[var(--eco-text)]"
        >
          {selectedCount > 0 ? "Deselect" : "Select All"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={selectedCount === 0}
          className="rounded px-2 py-1 text-xs font-medium text-[var(--eco-coral)] transition-colors duration-150 hover:bg-[var(--eco-coral)]/10 disabled:opacity-40"
          aria-label="Delete selected"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-xs text-[var(--eco-text-secondary)] transition-colors duration-150 hover:text-[var(--eco-text)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
