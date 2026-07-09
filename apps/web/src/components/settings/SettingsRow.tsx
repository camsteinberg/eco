// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { ReactNode } from "react";

type Props = {
  label: string;
  description?: string;
  control: ReactNode;
  divider?: boolean;
};

export function SettingsRow({ label, description, control, divider = true }: Props) {
  return (
    <div
      className={[
        "flex items-start justify-between gap-6 py-4",
        divider ? "border-b border-[var(--eco-border-muted)] last:border-b-0" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-[var(--eco-text)]">{label}</p>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-[var(--eco-text-secondary)]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 self-center">{control}</div>
    </div>
  );
}
