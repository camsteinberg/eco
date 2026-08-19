// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import { Button } from "@eco/ui";

type BrandedErrorProps = {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
};

export function BrandedError({ title, description, action }: BrandedErrorProps) {
  return (
    <div
      role="alert"
      className="mt-3 rounded-xl border border-[var(--eco-coral)]/20 bg-[var(--eco-coral-soft)] p-4"
    >
      <p className="text-sm font-medium text-[var(--eco-coral)]">{title}</p>
      <p className="mt-1 text-xs text-[var(--eco-text-secondary)]">
        {description}
      </p>
      {action && (
        <Button
          variant="primary"
          size="sm"
          onClick={action.onClick}
          className="mt-3"
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
