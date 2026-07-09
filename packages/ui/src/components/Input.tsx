// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";

type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  helpText?: string;
  id: string;
};

const baseInputClasses =
  "block w-full rounded-[var(--eco-radius-md)] border bg-[var(--eco-surface)] px-4 py-3 text-base text-[var(--eco-text)] placeholder-[var(--eco-text-secondary)] focus:border-[var(--eco-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]/20 transition-colors";

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ label, error, helpText, id, className = "", ...rest }, ref) {
    const inputClasses = [
      baseInputClasses,
      error
        ? "border-[var(--eco-danger)]"
        : "border-[var(--eco-border)]",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div>
        <label
          htmlFor={id}
          className="mb-1.5 block text-sm font-medium text-[var(--eco-text)]"
        >
          {label}
        </label>
        <input ref={ref} id={id} className={inputClasses} {...rest} />
        {error && (
          <p className="mt-1.5 text-sm text-[var(--eco-danger)]">{error}</p>
        )}
        {!error && helpText && (
          <p className="mt-1.5 text-sm text-[var(--eco-text-secondary)]">
            {helpText}
          </p>
        )}
      </div>
    );
  },
);
