// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";

type CardProps = {
  children: React.ReactNode;
  className?: string;
  bordered?: boolean;
  grain?: boolean;
  shadow?: "none" | "sm" | "md" | "lg";
};

const shadowClasses: Record<NonNullable<CardProps["shadow"]>, string> = {
  none: "",
  sm: "shadow-[var(--eco-shadow-sm)]",
  md: "shadow-[var(--eco-shadow-md)]",
  lg: "shadow-[var(--eco-shadow-lg)]",
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  function Card(
    {
      children,
      className = "",
      bordered = true,
      grain = false,
      shadow = "none",
    },
    ref,
  ) {
    const classes = [
      "rounded-[var(--eco-radius-md)] bg-[var(--eco-surface-elevated)]",
      bordered ? "border border-[var(--eco-border)]" : "",
      grain ? "eco-grain" : "",
      shadowClasses[shadow],
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div ref={ref} className={classes}>
        {children}
      </div>
    );
  },
);
