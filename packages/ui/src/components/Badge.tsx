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
    "bg-[var(--eco-neutral-bg)] text-[var(--eco-neutral-text-secondary)]",
  success: "bg-[var(--eco-success-soft)] text-[var(--eco-success)]",
  warning: "bg-[var(--eco-warning-soft)] text-[var(--eco-warning)]",
  danger: "bg-[var(--eco-danger-soft)] text-[var(--eco-danger)]",
  info: "bg-[var(--eco-info-soft)] text-[var(--eco-info)]",
};

export function Badge({
  children,
  variant = "default",
  className = "",
}: BadgeProps) {
  const classes = [
    "inline-flex items-center rounded-[var(--eco-radius-full)] px-2.5 py-0.5 text-xs font-medium",
    variantClasses[variant],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <span className={classes}>{children}</span>;
}
