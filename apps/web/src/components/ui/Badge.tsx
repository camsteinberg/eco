// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";

type BadgeVariant = "default" | "success" | "warning" | "danger" | "info";

type BadgeProps = {
  children: React.ReactNode;
  variant?: BadgeVariant;
  className?: string;
};

const variantClasses: Record<BadgeVariant, string> = {
  default:
    "bg-[var(--eco-surface)] text-[var(--eco-text-secondary)]",
  success: "bg-[var(--eco-mint-soft)] text-[var(--eco-mint)]",
  warning: "bg-[var(--eco-amber-soft)] text-[var(--eco-amber)]",
  danger: "bg-[var(--eco-coral-soft)] text-[var(--eco-coral)]",
  info: "bg-[var(--eco-sky-soft)] text-[var(--eco-sky)]",
};

export function Badge({
  children,
  variant = "default",
  className = "",
}: BadgeProps) {
  const classes = [
    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
    variantClasses[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <span className={classes}>{children}</span>;
}
