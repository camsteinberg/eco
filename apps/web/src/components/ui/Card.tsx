// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";

type CardProps = {
  children: React.ReactNode;
  className?: string;
  bordered?: boolean;
};

export function Card({ children, className = "", bordered = true }: CardProps) {
  const classes = [
    "rounded-2xl bg-[var(--eco-surface-elevated)]",
    bordered ? "border border-[var(--eco-border)]" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <div className={classes}>{children}</div>;
}
