// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { motion, useReducedMotion } from "motion/react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
};

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[var(--eco-primary)] text-[var(--eco-on-primary)] hover:bg-[var(--eco-primary-hover)]",
  secondary:
    "border border-[var(--eco-primary)] text-[var(--eco-primary)] hover:bg-[var(--eco-primary-soft)]",
  ghost:
    "text-[var(--eco-text-secondary)] hover:text-[var(--eco-text)] hover:bg-[var(--eco-surface-elevated)]",
  danger:
    "bg-[var(--eco-coral)] text-[var(--eco-on-primary)] hover:opacity-90",
};

const variantRadius: Record<Variant, string> = {
  primary: "rounded-[var(--eco-radius-full)]",
  secondary: "rounded-[var(--eco-radius-sm)]",
  ghost: "rounded-[var(--eco-radius-sm)]",
  danger: "rounded-[var(--eco-radius-full)]",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-5 py-2.5 text-sm",
  lg: "px-6 py-3 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      children,
      className = "",
      ...props
    },
    ref,
  ) {
    const shouldReduceMotion = useReducedMotion();
    const isDisabled = disabled || loading;

    return (
      // @ts-expect-error -- Motion v12 MotionStyle incompatible with CSSProperties under exactOptionalPropertyTypes
      <motion.button
        ref={ref}
        disabled={isDisabled}
        whileTap={
          isDisabled || shouldReduceMotion ? undefined : { scale: 0.97 }
        }
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        className={[
          "inline-flex items-center justify-center gap-2 font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--eco-primary)]/30 focus-visible:ring-offset-2",
          loading
            ? "disabled:cursor-wait bg-[var(--eco-primary-soft)] text-[var(--eco-primary)]"
            : `disabled:opacity-40 disabled:cursor-not-allowed ${variantClasses[variant]}`,
          variantRadius[variant],
          sizeClasses[size],
          className,
        ].join(" ")}
        {...props}
      >
        {loading && (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
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
              d="M4 12a8 8 0 018-8v8H4z"
            />
          </svg>
        )}
        {children}
      </motion.button>
    );
  },
);
