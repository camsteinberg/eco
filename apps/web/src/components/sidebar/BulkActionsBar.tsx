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

/**
 * The multi-select action bar.
 *
 * It mounts for the whole of multi-select — including with nothing chosen yet —
 * which is what makes "Select all" reachable: while the bar only appeared once
 * a row was already selected, that label could never render.
 *
 * Everything wraps rather than clips: the sidebar column is 280px wide, where a
 * count and three controls do not fit on one line.
 *
 * Deliberately NOT sticky. It used to be `sticky bottom-0`, but its containing
 * block is this list rather than the sidebar's scroller — so instead of pinning
 * to the end of the list it floated at the scrollport's bottom edge and sat on
 * top of whichever row happened to be there (measured 2026-08-19). In normal
 * flow it lands under the last row and covers nothing at any scroll offset.
 */
export function BulkActionsBar({
  selectedCount,
  onSelectAll,
  onDeselectAll,
  onDelete,
  onCancel,
}: BulkActionsBarProps) {
  return (
    <div
      className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] px-3 py-2"
      aria-label="Bulk actions"
    >
      <span className="whitespace-nowrap text-xs font-medium text-[var(--eco-text-secondary)]">
        {selectedCount} selected
      </span>
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-1 gap-y-1">
        <button
          type="button"
          onClick={selectedCount > 0 ? onDeselectAll : onSelectAll}
          className="whitespace-nowrap rounded px-2 py-1 text-xs text-[var(--eco-text-secondary)] transition-colors duration-150 hover:text-[var(--eco-text)]"
        >
          {selectedCount > 0 ? "Deselect" : "Select all"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={selectedCount === 0}
          className="whitespace-nowrap rounded px-2 py-1 text-xs font-medium text-[var(--eco-coral)] transition-colors duration-150 hover:bg-[var(--eco-coral-soft)] disabled:opacity-40"
          aria-label="Delete selected"
        >
          Delete
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="whitespace-nowrap rounded px-2 py-1 text-xs text-[var(--eco-text-secondary)] transition-colors duration-150 hover:text-[var(--eco-text)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
