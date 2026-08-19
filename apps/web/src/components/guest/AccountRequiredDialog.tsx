// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { buildAuthPageHref } from "../../lib/auth-continuation";

type AccountRequiredDialogProps = {
  open: boolean;
  title: string;
  description: string;
  callbackUrl: string;
  onClose: () => void;
};

export function AccountRequiredDialog({
  open,
  title,
  description,
  callbackUrl,
  onClose,
}: AccountRequiredDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const signInHref = buildAuthPageHref("/sign-in", { callbackUrl });
  const signUpHref = buildAuthPageHref("/sign-up", { callbackUrl });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

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
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          onClose();
        }
      }}
      className="w-full max-w-lg rounded-xl border border-[var(--eco-border)] bg-[var(--eco-surface-elevated)] p-0 shadow-xl backdrop:bg-[var(--eco-scrim)]"
    >
      <div className="p-6 sm:p-7">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]"
            style={{
              backgroundColor: "color-mix(in srgb, var(--eco-primary-soft) 74%, white 12%)",
              color: "var(--eco-primary)",
            }}
          >
            Account needed here
          </span>
          <span className="inline-flex items-center rounded-full border border-[var(--eco-border)] px-3 py-1 text-xs font-medium text-[var(--eco-text-secondary)]">
            Guest stays local
          </span>
        </div>

        <h2 className="mt-5 font-serif text-2xl text-[var(--eco-text)]">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-[var(--eco-text-secondary)]">
          {description}
        </p>

        <div className="mt-5 rounded-2xl border border-[var(--eco-border)] bg-[var(--eco-surface)] px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-[var(--eco-text-muted)]">
            What carries forward
          </p>
          <p className="mt-2 text-sm leading-6 text-[var(--eco-text-secondary)]">
            Your current route, draft, and local thread follow you into your account so the app keeps feeling continuous.
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Link
            href={signUpHref}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full px-5 py-3 text-sm font-medium text-[var(--eco-on-primary)] transition-all hover:opacity-95"
            style={{ backgroundColor: "var(--eco-primary)" }}
          >
            Create free account
          </Link>
          <Link
            href={signInHref}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-full border border-[var(--eco-border)] px-5 py-3 text-sm font-medium text-[var(--eco-text)] transition-colors hover:border-[var(--eco-primary)] hover:text-[var(--eco-primary)]"
          >
            Sign in
          </Link>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-full px-4 py-2 text-sm font-medium text-[var(--eco-text-secondary)] transition-colors hover:text-[var(--eco-text)]"
        >
          Not now
        </button>
      </div>
    </dialog>
  );
}
