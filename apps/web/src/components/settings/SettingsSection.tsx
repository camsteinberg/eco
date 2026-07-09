// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { ReactNode } from "react";
import { LeafDivider } from "@eco/ui";

type Props = {
  title: string;
  description?: string;
  hairline?: boolean;
  className?: string;
  children: ReactNode;
};

export function SettingsSection({
  title,
  description,
  hairline = true,
  className,
  children,
}: Props) {
  return (
    <>
      {/* Botanical section separator — the design system bans plain rules
          between sections; kept whisper-quiet so the settings rhythm stays calm. */}
      {hairline ? (
        <div className="mt-12 mb-12 flex justify-center" aria-hidden="true">
          <LeafDivider
            size={132}
            opacity={0.5}
            className="text-[var(--eco-border-muted)]"
          />
        </div>
      ) : null}
      <section className={className ?? undefined}>
        <h2 className="font-display text-xl tracking-tight text-[var(--eco-text)]">
          {title}
        </h2>
        {description ? (
          <p className="mt-1.5 max-w-prose text-sm text-[var(--eco-text-secondary)]">
            {description}
          </p>
        ) : null}
        <div className="mt-6">{children}</div>
      </section>
    </>
  );
}
