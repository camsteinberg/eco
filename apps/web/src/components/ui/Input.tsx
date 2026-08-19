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
  "block w-full rounded-xl border bg-[var(--eco-surface)] px-4 py-3 text-base text-[var(--eco-text)] placeholder-[var(--eco-text-secondary)] focus:outline-none transition-all duration-150 ease";

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ label, error, helpText, id, className = "", ...rest }, ref) {
    const inputClasses = [
      baseInputClasses,
      error
        ? "border-[var(--eco-coral)] focus:border-[var(--eco-coral)] focus:ring-2 focus:ring-[var(--eco-coral)]/20"
        : "border-[var(--eco-border)] focus:border-[var(--eco-primary)] focus:ring-2 focus:ring-[var(--eco-primary)]/20",
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
          <p className="mt-1.5 text-sm text-[var(--eco-coral)]">{error}</p>
        )}
        {!error && helpText && (
          <p className="mt-1.5 text-sm text-[var(--eco-text-secondary)]">
            {helpText}
          </p>
        )}
      </div>
    );
  }
);
