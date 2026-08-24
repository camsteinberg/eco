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
  /** Optional anchor id, so a deep link can scroll straight to this section. */
  id?: string;
  children: ReactNode;
};

export function SettingsSection({
  title,
  description,
  hairline = true,
  className,
  id,
  children,
}: Props) {
  return (
    <>
      {/* Botanical section separator — the design system bans plain rules
          between sections (use the leaf divider). It reads at --eco-border so
          it lands as an intentional leaf motif rather than a faint smudge, with
          a tighter, single-step gap above and below to keep the rhythm calm. */}
      {hairline ? (
        <div className="my-8 flex justify-center" aria-hidden="true">
          <LeafDivider size={132} className="text-[var(--eco-border)]" />
        </div>
      ) : null}
      <section id={id} className={className ?? undefined}>
        <h2 className="font-display font-medium text-xl tracking-tight text-[var(--eco-text)]">
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
