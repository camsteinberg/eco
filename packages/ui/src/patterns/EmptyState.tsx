// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { ReactNode } from "react";
import { Button } from "../components/Button.js";

type EmptyStateAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

type EmptyStateProps = {
  illustration: ReactNode;
  title: string;
  description: string;
  action?: EmptyStateAction;
  className?: string;
};

export function EmptyState({
  illustration,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={[
        "flex flex-col items-center justify-center gap-[var(--eco-space-lg)] px-[var(--eco-space-md)] py-[var(--eco-space-3xl)] text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="h-32 w-32 flex items-center justify-center text-[var(--eco-primary)]">
        {illustration}
      </div>
      <div className="flex flex-col gap-[var(--eco-space-sm)]">
        <h3 className="font-[var(--eco-font-display)] text-xl text-[var(--eco-text)]">
          {title}
        </h3>
        <p className="text-sm text-[var(--eco-text-secondary)] max-w-sm">
          {description}
        </p>
      </div>
      {action &&
        (action.href ? (
          <a
            href={action.href}
            className="inline-flex items-center justify-center gap-2 font-medium rounded-[var(--eco-radius-sm)] bg-[var(--eco-primary)] text-[var(--eco-on-primary)] hover:bg-[var(--eco-primary-hover)] px-3 py-1.5 text-sm transition-colors"
          >
            {action.label}
          </a>
        ) : (
          <Button variant="primary" size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
    </div>
  );
}
