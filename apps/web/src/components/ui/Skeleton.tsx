// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

type SkeletonVariant = "text" | "circular" | "rectangular";

type SkeletonProps = {
  variant?: SkeletonVariant;
  className?: string;
};

const variantClasses: Record<SkeletonVariant, string> = {
  text: "h-4 w-full rounded",
  circular: "rounded-full",
  rectangular: "rounded-xl",
};

export function Skeleton({ variant = "text", className = "" }: SkeletonProps) {
  const classes = ["skeleton-shimmer", variantClasses[variant], className]
    .filter(Boolean)
    .join(" ");

  return <div className={classes} />;
}
