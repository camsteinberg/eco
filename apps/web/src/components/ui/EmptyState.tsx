// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import React from "react";
import { Button } from "./Button";

type EmptyStateAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

type EmptyStateProps = {
  illustration: React.ReactNode;
  title: string;
  description: string;
  action?: EmptyStateAction;
};

export function EmptyState({
  illustration,
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <div
        className="h-32 w-32 flex items-center justify-center"
        style={{ color: "var(--eco-primary)" }}
      >
        {illustration}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="font-serif text-xl text-[var(--eco-text)]">
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
            className="inline-flex items-center justify-center font-medium transition-all duration-150 ease cursor-pointer active:scale-[0.98] rounded-full text-white hover:opacity-90 px-3 py-1.5 text-sm"
            style={{ backgroundColor: "var(--eco-primary)" }}
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
