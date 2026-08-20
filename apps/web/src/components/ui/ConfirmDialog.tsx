// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { useRef, useEffect } from "react";
import { ErrorLine } from "./ErrorNotice";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  errorMessage?: string | null;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  destructive = false,
  errorMessage = null,
  confirmDisabled = false,
  cancelDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        if (cancelDisabled) {
          event.preventDefault();
          return;
        }

        onCancel();
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current && !cancelDisabled) onCancel();
      }}
      className="rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-0 shadow-lg backdrop:bg-[var(--eco-scrim)]"
    >
      <div className="w-80 p-5">
        <h3 className="text-base font-semibold text-[var(--eco-text)]">
          {title}
        </h3>
        <p
          aria-live={confirmDisabled ? "polite" : undefined}
          className="mt-2 text-sm text-[var(--eco-text-secondary)]"
        >
          {message}
        </p>
        {errorMessage ? (
          <ErrorLine className="mt-3">{errorMessage}</ErrorLine>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={cancelDisabled}
            // rounded-full, not rounded-lg: at this button height Eco's 24px
            // lg radius clamps to a pill anyway, so full states the rendered
            // shape instead of depending on the clamp surviving a size change.
            className="rounded-full border border-[var(--eco-border)] px-3 py-1.5 text-sm font-medium text-[var(--eco-text)] transition-colors hover:bg-[var(--eco-primary-soft)] active:scale-[0.98]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="rounded-full px-3 py-1.5 text-sm font-medium text-[var(--eco-on-primary)] transition-all duration-150 hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              backgroundColor: destructive
                ? "var(--eco-coral)"
                : "var(--eco-primary)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
