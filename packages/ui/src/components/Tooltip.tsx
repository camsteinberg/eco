// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Bos Computing LLC

"use client";

import type { ReactNode } from "react";
import { Tooltip as RadixTooltip } from "radix-ui";

type TooltipProps = {
  content: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  delayDuration?: number;
};

export function Tooltip({
  content,
  children,
  side = "top",
  sideOffset = 8,
  delayDuration = 200,
}: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content
            side={side}
            sideOffset={sideOffset}
            className="z-50 rounded-[var(--eco-radius-sm)] bg-[var(--eco-text)] px-3 py-2 text-xs text-[var(--eco-surface)] shadow-[var(--eco-shadow-md)] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          >
            {content}
            <RadixTooltip.Arrow className="fill-[var(--eco-text)]" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
