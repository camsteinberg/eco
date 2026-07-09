// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
};

const baseClasses =
  "inline-flex items-center justify-center font-medium transition-all duration-150 ease cursor-pointer active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "rounded-full text-white hover:opacity-90",
  secondary:
    "rounded-xl border border-[var(--eco-border)] text-[var(--eco-text)] hover:bg-[var(--eco-primary-soft)]",
  ghost:
    "rounded-lg text-[var(--eco-text-secondary)] hover:bg-[var(--eco-primary-soft)] hover:text-[var(--eco-text)]",
  danger: "rounded-full text-white hover:opacity-90",
};

const variantStyles: Partial<Record<ButtonVariant, React.CSSProperties>> = {
  primary: { backgroundColor: "var(--eco-primary)" },
  danger: { backgroundColor: "var(--eco-coral)" },
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2.5 text-base",
  lg: "px-6 py-3.5 text-base",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      fullWidth = false,
      disabled,
      className = "",
      style,
      children,
      type = "button",
      ...rest
    },
    ref
  ) {
    const classes = [
      baseClasses,
      variantClasses[variant],
      sizeClasses[size],
      fullWidth ? "w-full" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const mergedStyle = {
      ...variantStyles[variant],
      ...style,
    };

    return (
      <button
        ref={ref}
        // eslint-disable-next-line react/button-has-type -- type defaults to "button", overridable via props
        type={type}
        className={classes}
        style={mergedStyle}
        disabled={disabled || loading}
        {...rest}
      >
        {loading && (
          <svg
            className="animate-spin -ml-1 mr-2 h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);
